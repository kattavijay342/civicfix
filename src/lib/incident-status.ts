import type { IssueStatus } from "./types";

/** The only 3 states ever written to civic_incidents.status (see
 * supabase/migrations/0014_incident_intelligence.sql). */
export type IncidentDbStatus = "open" | "in_progress" | "resolved";

/**
 * Derives the incident's DISPLAYED status live from its own explicit status
 * plus whether any linked report is currently reopened — never stored as a
 * fourth DB value (spec §16: "if the incident is reopened... the incident
 * should reflect the reopened state appropriately" without a second,
 * driftable source of truth alongside the reports' own status_history).
 *
 * A reopened linked report always wins: if a citizen has said a resolution
 * isn't real, the incident can never honestly show "Resolved," regardless
 * of what a department previously, correctly recorded. Reuses the existing
 * IssueStatus vocabulary (ROUTED/IN_PROGRESS/RESOLVED/REOPENED) so the
 * incident UI can reuse StatusBadge unchanged instead of inventing a
 * parallel badge component.
 */
export function deriveIncidentDisplayStatus(dbStatus: IncidentDbStatus, anyReopened: boolean): IssueStatus {
  if (anyReopened) return "REOPENED";
  if (dbStatus === "resolved") return "RESOLVED";
  if (dbStatus === "in_progress") return "IN_PROGRESS";
  return "ROUTED";
}
