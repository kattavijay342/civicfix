import type { IssueStatus } from "@/lib/types";

/** Lifecycle order (Phase 3 Step 17): Reported < AI Analyzed < Routed <
 * Acknowledged < In Progress < Resolved. Every transition is checked
 * against the report's CURRENT status so an in-charge can only move a
 * report forward, never backward, skip stages into "resolved" outside
 * submitResolution, or re-apply a status the report is already past.
 *
 * Kept in its own module (rather than inline in src/lib/actions/department.ts)
 * because a "use server" file may only export async functions — a plain
 * constant/sync helper exported from one is a Next.js build error — and so
 * this logic can be unit-tested directly (src/lib/status-transitions.test.ts). */
export const STATUS_ORDER: Record<IssueStatus, number> = {
  REPORTED: 0,
  AI_ANALYZED: 1,
  ROUTED: 2,
  ACKNOWLEDGED: 3,
  IN_PROGRESS: 4,
  RESOLVED: 5,
  // Phase 6D — deliberately ranked with ROUTED, not above RESOLVED. A
  // reopened report re-enters the workflow needing fresh department
  // attention: the in-charge must acknowledge (3 > 2) and can progress
  // (4 > 2) again before resolving again, reusing canAdvanceStatus/
  // canSubmitResolution completely unchanged.
  REOPENED: 2,
};

/** Statuses a department in-charge may set directly via updateReportStatus.
 * "resolved" is deliberately excluded — it requires evidence, via
 * submitResolution, never a plain status update. */
export const FORWARD_STATUSES: IssueStatus[] = ["ACKNOWLEDGED", "IN_PROGRESS"];

export function canAdvanceStatus(current: IssueStatus, next: IssueStatus): boolean {
  if (!FORWARD_STATUSES.includes(next)) return false;
  return STATUS_ORDER[next] > STATUS_ORDER[current];
}

export function canSubmitResolution(current: IssueStatus): boolean {
  if (current === "RESOLVED") return false;
  return STATUS_ORDER[current] >= STATUS_ORDER.ACKNOWLEDGED;
}
