import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findIncidentMatch } from "./incident-detection";
import { computeIncidentPriority, computeIncidentConfidence, type DbLevel } from "./incident-priority";
import { resolveAssignment } from "./actions/routing";
import { createNotification } from "./notifications/create";
import { findGovernmentUsersForJurisdiction } from "./notifications/targeting";
import { categoryToDb } from "./db-enums";
import { categoryLabels } from "./categories";
import type { CivicLocation, ProblemCategory } from "./types";

export interface EvaluateIncidentInput {
  reportId: string;
  category: ProblemCategory;
  subcategory?: string | null;
  description: string;
  location: CivicLocation;
  createdAt: string;
  /** The new report's own AI-assessed severity (db-style: "low" |
   * "medium" | "high" | "critical"), when available — null if AI analysis
   * failed/hasn't run, treated as "low" in the priority formula, never
   * blocking incident linking on an AI outage (spec §6/§20). Typed as a
   * plain string because it comes straight from Gemini's Zod-validated
   * `z.enum(dbSeverityValues)` output (src/lib/ai.ts), which — being
   * derived from `Object.values(...)` — TypeScript can't narrow to the
   * literal DbLevel union at the call site. */
  severity: string | null;
  /** Phase 6A's existing report-level classification (src/lib/
   * duplicate-detection.ts), when this same report already triggered it. */
  existingDuplicateCandidate?: { reportId: string; relationType: "duplicate" | "related" } | null;
}

function ageInDays(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000)));
}

function averageCoordinate(
  a: { latitude: number | null; longitude: number | null },
  b: { latitude: number | null; longitude: number | null }
): { latitude: number | null; longitude: number | null } {
  if (a.latitude != null && a.longitude != null && b.latitude != null && b.longitude != null) {
    return { latitude: (a.latitude + b.latitude) / 2, longitude: (a.longitude + b.longitude) / 2 };
  }
  if (a.latitude != null && a.longitude != null) return { latitude: a.latitude, longitude: a.longitude };
  if (b.latitude != null && b.longitude != null) return { latitude: b.latitude, longitude: b.longitude };
  return { latitude: null, longitude: null };
}

/**
 * Evaluates whether a just-created report belongs to a Civic Incident —
 * either joining one that already exists or, when the match is strong
 * enough on its own, founding a brand-new one from exactly two reports
 * (spec §7: never more than one incident from a single report). Always
 * called AFTER the report itself is fully inserted (never blocks report
 * creation) and always wrapped by the caller in try/catch as a best-effort
 * step, exactly like the existing duplicate-detection call in
 * src/lib/actions/reports.ts — an incident-linking failure here must never
 * lose or corrupt the underlying report.
 */
export async function evaluateIncidentForReport(admin: SupabaseClient, input: EvaluateIncidentInput): Promise<void> {
  const dbCategory = categoryToDb[input.category];
  const match = await findIncidentMatch(admin, {
    reportId: input.reportId,
    category: dbCategory,
    subcategory: input.subcategory ?? null,
    location: input.location,
    description: input.description,
    createdAt: input.createdAt,
    existingDuplicateCandidate: input.existingDuplicateCandidate,
  });
  if (!match) return;

  const { data: existingLink } = await admin
    .from("incident_reports")
    .select("incident_id")
    .eq("report_id", match.reportId)
    .limit(1)
    .maybeSingle();

  if (existingLink?.incident_id) {
    await admin.from("incident_reports").insert({
      incident_id: existingLink.incident_id,
      report_id: input.reportId,
      relationship_type: match.relationshipType,
      confidence: match.score,
    });
    // A 'candidate' addition is recorded for human review only — it never
    // moves the incident's own severity/priority/confidence, and never
    // triggers a notification (spec §3/§15).
    if (match.relationshipType !== "candidate") {
      await recomputeIncidentAggregate(admin, existingLink.incident_id);
      await notifyIncidentEvent(admin, existingLink.incident_id, "incident_updated", input.location);
    }
    return;
  }

  // No existing incident to join — only FOUND a new one when confidence is
  // NOT merely a candidate (spec §3: never create/merge on insufficient
  // confidence; a lone low-confidence pair is simply left unrecorded).
  if (match.relationshipType === "candidate") return;

  const { data: matchedReport } = await admin
    .from("reports")
    .select("id, status, severity, created_at")
    .eq("id", match.reportId)
    .single();
  if (!matchedReport) return;

  const { data: matchedLocation } = await admin
    .from("report_locations")
    .select("latitude, longitude")
    .eq("report_id", match.reportId)
    .maybeSingle();

  const assignment = await resolveAssignment(admin, input.category, input.location);

  const oldestReportAgeDays = Math.max(
    ageInDays(matchedReport.created_at as string),
    ageInDays(input.createdAt)
  );

  const { severity, priority } = computeIncidentPriority({
    memberSeverities: [
      ((matchedReport.severity as DbLevel | null) ?? "low"),
      (input.severity as DbLevel | null) ?? "low",
    ],
    affectedReportCount: 2,
    anyReopened: matchedReport.status === "reopened",
    oldestReportAgeDays,
    stillUnresolved: true,
  });

  const { latitude, longitude } = averageCoordinate(
    { latitude: matchedLocation?.latitude ?? null, longitude: matchedLocation?.longitude ?? null },
    { latitude: input.location.latitude ?? null, longitude: input.location.longitude ?? null }
  );

  const areaLabel = input.location.landmark || input.location.area || input.location.displayName;
  const title = `${categoryLabels[input.category]} — ${areaLabel}`;

  const { data: incident, error: incidentError } = await admin
    .from("civic_incidents")
    .insert({
      title,
      category: dbCategory,
      subcategory: input.subcategory ?? null,
      severity,
      priority,
      department_id: assignment?.departmentId ?? null,
      latitude,
      longitude,
      confidence: match.score,
      detection_method: match.detectionMethod,
    })
    .select("id")
    .single();

  if (incidentError || !incident) {
    console.error("Failed to create civic incident (non-fatal)", incidentError);
    return;
  }

  const { error: linkError } = await admin.from("incident_reports").insert([
    { incident_id: incident.id, report_id: match.reportId, relationship_type: "primary", confidence: match.score },
    { incident_id: incident.id, report_id: input.reportId, relationship_type: match.relationshipType, confidence: match.score },
  ]);
  if (linkError) {
    console.error("Failed to link reports to new civic incident (non-fatal)", linkError);
    return;
  }

  await notifyIncidentEvent(admin, incident.id, "incident_created", input.location);
}

/**
 * Recomputes an incident's severity/priority/confidence from its current
 * non-candidate linked reports — always re-derived from real, live data
 * (spec §8: "do not store values that can easily become stale"), never
 * incrementally patched. Bounded to one incident's own (small) member set,
 * never a table-wide scan (spec §18).
 */
async function recomputeIncidentAggregate(admin: SupabaseClient, incidentId: string): Promise<void> {
  const { data: links } = await admin
    .from("incident_reports")
    .select("report_id, confidence")
    .eq("incident_id", incidentId)
    .neq("relationship_type", "candidate");
  if (!links || links.length === 0) return;

  const { data: reports } = await admin
    .from("reports")
    .select("id, status, severity, created_at")
    .in(
      "id",
      links.map((l) => l.report_id)
    );
  if (!reports || reports.length === 0) return;

  const memberSeverities = reports.map((r) => (r.severity as DbLevel | null) ?? "low");
  const anyReopened = reports.some((r) => r.status === "reopened");
  const stillUnresolved = reports.some((r) => r.status !== "resolved");
  const oldestReportAgeDays = Math.max(...reports.map((r) => ageInDays(r.created_at as string)));

  const { severity, priority } = computeIncidentPriority({
    memberSeverities,
    affectedReportCount: reports.length,
    anyReopened,
    oldestReportAgeDays,
    stillUnresolved,
  });
  const confidence = computeIncidentConfidence(links.map((l) => Number(l.confidence)));

  await admin.from("civic_incidents").update({ severity, priority, confidence }).eq("id", incidentId);
}

/**
 * ONE notification per recipient per event — never one per linked report
 * (spec §15: "do NOT send 7 identical notifications if 7 reports are
 * linked to one incident"). Recipients are the incident's own department's
 * active in-charges plus government users whose configured jurisdiction
 * covers the report location that triggered this event — the exact same
 * two audiences (src/lib/actions/reports.ts's notifyNewAssignment /
 * notifyAiAnalysisComplete) this app already notifies for an individual
 * report, just deduplicated to one message each.
 */
async function notifyIncidentEvent(
  admin: SupabaseClient,
  incidentId: string,
  type: "incident_created" | "incident_updated",
  triggeringLocation: CivicLocation
): Promise<void> {
  const { data: incident } = await admin
    .from("civic_incidents")
    .select("incident_code, title, department_id")
    .eq("id", incidentId)
    .single();
  if (!incident) return;

  const recipients = new Set<string>();
  if (incident.department_id) {
    const { data: incharges } = await admin
      .from("department_incharges")
      .select("profile_id")
      .eq("department_id", incident.department_id)
      .eq("is_active", true);
    for (const i of incharges ?? []) recipients.add(i.profile_id);
  }
  for (const id of await findGovernmentUsersForJurisdiction(admin, triggeringLocation)) {
    recipients.add(id);
  }

  const title = type === "incident_created" ? `New civic incident: ${incident.incident_code}` : `Civic incident updated: ${incident.incident_code}`;
  const body =
    type === "incident_created"
      ? `"${incident.title}" was created from multiple related citizen reports.`
      : `"${incident.title}" has a new linked report.`;

  for (const recipientId of recipients) {
    await createNotification(admin, {
      recipientId,
      type,
      title,
      body,
      actionUrl: `/government/incidents/${incidentId}`,
    });
  }
}
