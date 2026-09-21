import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CivicLocation } from "./types";

const DUPLICATE_WINDOW_DAYS = 14;
const NEARBY_METERS = 300;

function jaccardSimilarity(a: string, b: string): number {
  const wordsOf = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter(Boolean));
  const setA = wordsOf(a);
  const setB = wordsOf(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export type DuplicateRelationType = "duplicate" | "related";

export interface DuplicateCandidate {
  reportId: string;
  title: string;
  score: number;
  /** Phase 6A — "duplicate" (high-confidence same complaint) vs "related"
   * (same area/category but lower text overlap). Deterministic, not
   * AI-generated — see the module doc comment below for why. */
  relationType: DuplicateRelationType;
  /** Deterministic, human-readable explanation of which signals matched. */
  reason: string;
}

/** Score at/above this is treated as the same complaint being re-reported;
 * below it (but still >= the submit-time gate in src/lib/actions/reports.ts)
 * it's a genuinely different report that's merely related. */
const DUPLICATE_RELATION_THRESHOLD = 0.8;

function buildReason(input: {
  sameArea: boolean;
  near: boolean;
  similarity: number;
  daysAgo: number;
}): string {
  const signals: string[] = [];
  if (input.sameArea) signals.push("same category and area");
  else if (input.near) signals.push("same category and within ~300m");
  if (input.similarity >= 0.35) signals.push("similar wording");
  const recency =
    input.daysAgo <= 1 ? "reported today" : `reported ${input.daysAgo} day${input.daysAgo === 1 ? "" : "s"} ago`;
  signals.push(recency);
  return signals.length > 0 ? signals.join(", ") : "Matched on category and location only.";
}

/**
 * Heuristic-only duplicate/related detection (Step 17, extended in Phase
 * 6A): same category, same area/jurisdiction or within ~300m, reported in
 * the last 14 days, still unresolved. Deliberately deterministic rather
 * than an extra AI semantic-comparison call per report — the existing
 * geo+category+text-overlap signal already reliably separates "clearly the
 * same complaint" from "loosely related," and computing it this way costs
 * one query, zero AI calls, and is fully unit-testable. Never auto-merges —
 * the caller surfaces this as a "possible duplicate"/"related issue" for a
 * human to review.
 */
export async function findPossibleDuplicate(
  admin: SupabaseClient,
  input: { category: string; location: CivicLocation; description: string }
): Promise<DuplicateCandidate | null> {
  const since = new Date(Date.now() - DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: candidates } = await admin
    .from("reports")
    .select("id, title, description, created_at")
    .eq("category", input.category)
    .neq("status", "resolved")
    .gte("created_at", since)
    .limit(50);

  if (!candidates || candidates.length === 0) return null;

  const { data: locations } = await admin
    .from("report_locations")
    .select("report_id, district, constituency, area, latitude, longitude")
    .in(
      "report_id",
      candidates.map((c) => c.id)
    );

  const locationByReport = new Map((locations ?? []).map((l) => [l.report_id, l]));

  let best: DuplicateCandidate | null = null;
  for (const candidate of candidates) {
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
        NEARBY_METERS;

    if (!sameArea && !near) continue;

    const similarity = jaccardSimilarity(input.description, candidate.description);
    const score = 0.5 + Math.min(similarity, 0.5);

    if (!best || score > best.score) {
      const daysAgo = Math.floor((Date.now() - new Date(candidate.created_at).getTime()) / (24 * 60 * 60 * 1000));
      best = {
        reportId: candidate.id,
        title: candidate.title,
        score,
        relationType: score >= DUPLICATE_RELATION_THRESHOLD ? "duplicate" : "related",
        reason: buildReason({ sameArea, near, similarity, daysAgo }),
      };
    }
  }

  return best;
}
