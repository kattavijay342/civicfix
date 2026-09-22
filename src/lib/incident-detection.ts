import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CivicLocation } from "./types";
import { haversineMeters } from "./geo";
import { jaccardSimilarity } from "./text-similarity";
import { confirmSameIncident, IncidentAIUnavailableError } from "./incident-ai-confirm";

/** Wider than report-level duplicate detection's 14-day/300m window
 * (src/lib/duplicate-detection.ts) — an incident is a longer-lived,
 * real-world physical problem that citizens can plausibly keep re-reporting
 * for weeks, not just the same day or two. */
const INCIDENT_WINDOW_DAYS = 30;
const INCIDENT_NEARBY_METERS = 500;

/** Below this deterministic score, two reports aren't even worth recording
 * a relationship for (spec §3/§5: never merge on a single weak signal). */
const MIN_SIGNAL_THRESHOLD = 0.45;
/** [MIN_SIGNAL_THRESHOLD, AUTO_LINK_THRESHOLD) is the ambiguous band where a
 * single, one-shot Gemini semantic check is actually useful (spec §6: never
 * call AI for every report — only when deterministic signals are
 * genuinely unclear). */
const AUTO_LINK_THRESHOLD = 0.72;
/** At/above this, the deterministic signals alone are strong enough to
 * classify as the stronger "duplicate" relationship rather than "related". */
const STRONG_MATCH_THRESHOLD = 0.85;
/** Gemini's own confidence must clear this bar for its "yes" to count —
 * never blindly trust a low-confidence AI "yes" (spec §6: never fabricate
 * AI confidence, never treat an unsure answer as a confirmation). */
const AI_CONFIRMATION_MIN_CONFIDENCE = 0.6;

export type IncidentRelationshipType = "primary" | "duplicate" | "related" | "supporting" | "candidate";
export type IncidentDetectionMethod = "rule_based" | "ai_confirmed";

export interface IncidentMatch {
  /** The best-matching existing report (never more than one — an incident
   * grows by one report joining at a time, never a batch merge). */
  reportId: string;
  /** Deterministic multi-signal score, 0-1. Always the REAL computed score,
   * even when detectionMethod is "ai_confirmed" — Gemini's own confidence
   * is never substituted in, so this column is never a fabricated number. */
  score: number;
  relationshipType: IncidentRelationshipType;
  detectionMethod: IncidentDetectionMethod;
  reason: string;
}

interface CandidateRow {
  id: string;
  description: string;
  created_at: string;
}

interface CandidateLocationRow {
  report_id: string;
  district: string | null;
  constituency: string | null;
  area: string | null;
  latitude: number | null;
  longitude: number | null;
  display_name: string;
}

function daysBetween(aIso: string, bIso: string): number {
  return Math.abs(Math.floor((new Date(aIso).getTime() - new Date(bIso).getTime()) / (24 * 60 * 60 * 1000)));
}

function buildReason(input: {
  sameArea: boolean;
  near: boolean;
  similarity: number;
  subcategoryMatch: boolean;
  daysApart: number;
  existingRelationBonus: boolean;
}): string {
  const signals: string[] = [];
  if (input.sameArea) signals.push("same category and area");
  else if (input.near) signals.push(`same category and within ~${INCIDENT_NEARBY_METERS}m`);
  if (input.subcategoryMatch) signals.push("matching subcategory");
  if (input.similarity >= 0.3) signals.push("similar wording");
  if (input.existingRelationBonus) signals.push("already flagged as a possible duplicate/related report");
  signals.push(input.daysApart <= 1 ? "reported the same day" : `reported ${input.daysApart} days apart`);
  return signals.join(", ");
}

/**
 * Conservative, multi-signal incident-candidate search (spec §3/§5/§18):
 * an indexed, bounded query (same category + a 30-day window — mirrors
 * src/lib/duplicate-detection.ts's pattern and shares its composite index,
 * supabase/migrations/0014_incident_intelligence.sql) rather than a
 * similarity scan across the whole reports table, then a deterministic
 * geo + text + recency + subcategory score computed in JS over that small
 * candidate set, and finally — ONLY for the genuinely ambiguous score band
 * — one optional Gemini semantic-confirmation call (spec §6: never call AI
 * for every report). Never returns more than one match, so a single report
 * can never fan out into "hundreds of incidents" (spec §7).
 */
export async function findIncidentMatch(
  admin: SupabaseClient,
  input: {
    /** The new report's own id — excluded from its own candidate search. */
    reportId: string;
    category: string;
    subcategory?: string | null;
    location: CivicLocation;
    description: string;
    createdAt: string;
    /** Phase 6A's existing report-level classification (src/lib/
     * duplicate-detection.ts), when the new report already triggered it —
     * reused as one more corroborating signal (spec §3 signal 5) rather
     * than recomputed independently. */
    existingDuplicateCandidate?: { reportId: string; relationType: "duplicate" | "related" } | null;
  }
): Promise<IncidentMatch | null> {
  const since = new Date(Date.now() - INCIDENT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: candidates } = await admin
    .from("reports")
    .select("id, description, created_at")
    .eq("category", input.category)
    .neq("id", input.reportId)
    .neq("status", "resolved")
    .gte("created_at", since)
    .limit(100);

  if (!candidates || candidates.length === 0) return null;

  const candidateIds = candidates.map((c) => c.id);
  const [{ data: locations }, { data: analyses }] = await Promise.all([
    admin
      .from("report_locations")
      .select("report_id, district, constituency, area, latitude, longitude, display_name")
      .in("report_id", candidateIds),
    // Subcategory (signal 2b) lives in ai_analyses.extended, not on
    // `reports` itself — one bounded batched query over the same candidate
    // set, never one query per candidate (spec §18: no N+1s).
    admin.from("ai_analyses").select("report_id, extended").in("report_id", candidateIds),
  ]);

  const locationByReport = new Map<string, CandidateLocationRow>((locations ?? []).map((l) => [l.report_id, l]));
  const subcategoryByReport = new Map<string, string | null>(
    (analyses ?? []).map((a) => [
      a.report_id as string,
      ((a.extended as Record<string, unknown> | null)?.subcategory as string | undefined) ?? null,
    ])
  );

  let best:
    | (IncidentMatch & { sameArea: boolean; near: boolean; similarity: number; subcategoryMatch: boolean; daysApart: number })
    | null = null;

  for (const candidate of candidates as unknown as CandidateRow[]) {
    const loc = locationByReport.get(candidate.id);
    if (!loc) continue;

    const sameArea =
      !!input.location.district &&
      loc.district === input.location.district &&
      loc.constituency === input.location.constituency &&
      loc.area === input.location.area;

    const near =
      input.location.latitude != null &&
      input.location.longitude != null &&
      loc.latitude != null &&
      loc.longitude != null &&
      haversineMeters(input.location.latitude, input.location.longitude, loc.latitude, loc.longitude) <
        INCIDENT_NEARBY_METERS;

    // Signal 1 (geographic proximity) + signal 2 (category, already
    // guaranteed by the query itself) are both required before any other
    // signal is even considered — never merge on text similarity alone.
    if (!sameArea && !near) continue;

    const similarity = jaccardSimilarity(input.description, candidate.description);
    const candidateSubcategory = subcategoryByReport.get(candidate.id) ?? null;
    const subcategoryMatch =
      !!input.subcategory &&
      !!candidateSubcategory &&
      input.subcategory.trim().toLowerCase() === candidateSubcategory.trim().toLowerCase();

    const daysApart = daysBetween(input.createdAt, candidate.created_at);

    const existingRelationBonus = input.existingDuplicateCandidate?.reportId === candidate.id;

    let score = 0;
    score += sameArea ? 0.3 : near ? 0.25 : 0;
    score += Math.min(similarity, 0.4);
    score += subcategoryMatch ? 0.1 : 0;
    score += daysApart <= 3 ? 0.15 : daysApart <= 7 ? 0.08 : daysApart <= INCIDENT_WINDOW_DAYS ? 0.03 : 0;
    if (existingRelationBonus) {
      score += input.existingDuplicateCandidate?.relationType === "duplicate" ? 0.25 : 0.15;
    }
    score = Math.min(score, 1);

    if (!best || score > best.score) {
      best = {
        reportId: candidate.id,
        score,
        // Placeholder — the real tier/reason/detectionMethod are resolved
        // once the single best candidate across the whole set is known.
        relationshipType: "candidate",
        detectionMethod: "rule_based",
        reason: "",
        sameArea,
        near,
        similarity,
        subcategoryMatch,
        daysApart,
      };
    }
  }

  if (!best || best.score < MIN_SIGNAL_THRESHOLD) return null;

  const reason = buildReason({
    sameArea: best.sameArea,
    near: best.near,
    similarity: best.similarity,
    subcategoryMatch: best.subcategoryMatch,
    daysApart: best.daysApart,
    existingRelationBonus: !!input.existingDuplicateCandidate && input.existingDuplicateCandidate.reportId === best.reportId,
  });

  if (best.score >= AUTO_LINK_THRESHOLD) {
    return {
      reportId: best.reportId,
      score: best.score,
      relationshipType: best.score >= STRONG_MATCH_THRESHOLD ? "duplicate" : "related",
      detectionMethod: "rule_based",
      reason,
    };
  }

  // Ambiguous band: try exactly one Gemini semantic-confirmation call for
  // this single best candidate — never for every candidate, never for
  // scores outside this band (spec §6).
  try {
    const candidateRow = (candidates as unknown as CandidateRow[]).find((c) => c.id === best!.reportId)!;
    const candidateLoc = locationByReport.get(best.reportId)!;
    const confirmation = await confirmSameIncident({
      reportA: { category: input.category, description: input.description, areaLabel: input.location.displayName },
      reportB: {
        category: input.category,
        description: candidateRow.description,
        areaLabel: candidateLoc.display_name,
      },
      distanceMeters:
        input.location.latitude != null &&
        input.location.longitude != null &&
        candidateLoc.latitude != null &&
        candidateLoc.longitude != null
          ? haversineMeters(input.location.latitude, input.location.longitude, candidateLoc.latitude, candidateLoc.longitude)
          : null,
      daysApart: best.daysApart,
    });

    if (confirmation.same_incident && confirmation.confidence >= AI_CONFIRMATION_MIN_CONFIDENCE) {
      return {
        reportId: best.reportId,
        score: best.score, // the real deterministic score — Gemini's confidence is never substituted in.
        relationshipType: "supporting",
        detectionMethod: "ai_confirmed",
        reason: `${reason} — AI-confirmed: ${confirmation.reasoning}`,
      };
    }
  } catch (err) {
    if (!(err instanceof IncidentAIUnavailableError)) throw err;
    // Gemini unavailable/quota-exhausted/malformed — fall through to the
    // honest "rule-based, unconfirmed" candidate classification below
    // rather than blocking or fabricating a confirmation (spec §6/§20).
  }

  return {
    reportId: best.reportId,
    score: best.score,
    relationshipType: "candidate",
    detectionMethod: "rule_based",
    reason,
  };
}
