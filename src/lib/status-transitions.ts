import type { IssueStatus } from "@/lib/types";

/** Lifecycle order (Phase 3 Step 17): Reported < AI Analyzed < Routed <
 * Acknowledged < In Progress < Resolved. Used for display ordering and
 * aging; the department in-charge's allowed moves are the stricter
 * DEPARTMENT_NEXT_STATUS below.
 *
 * Kept in its own module (rather than inline in src/lib/actions/department.ts)
 * because a "use server" file may only export async functions — a plain
 * constant/sync helper exported from one is a Next.js build error — and so
 * this logic can be unit-tested directly (src/lib/status-transitions.test.ts)
 * and imported by DepartmentActionsPanel without duplicating it. */
export const STATUS_ORDER: Record<IssueStatus, number> = {
  REPORTED: 0,
  AI_ANALYZED: 1,
  ROUTED: 2,
  ACKNOWLEDGED: 3,
  IN_PROGRESS: 4,
  RESOLVED: 5,
  // Phase 6D — deliberately ranked with ROUTED, not above RESOLVED. A
  // reopened report re-enters the workflow needing fresh department
  // attention: the in-charge must acknowledge again before progressing.
  REOPENED: 2,
};

/**
 * G4 — the department in-charge workflow, one step at a time:
 *
 *   Routed / Reopened -> Acknowledged -> In Progress -> Resolved
 *
 * Every department mutation is checked against the report's CURRENT stored
 * status, so a stage can never be skipped (Routed -> Resolved), repeated
 * (Acknowledged -> Acknowledged), or reversed (In Progress -> Acknowledged).
 * Reopening is a citizen action (submitResolutionFeedback), never a
 * department one, so nothing here leads back out of Resolved.
 */
export const DEPARTMENT_NEXT_STATUS: Partial<Record<IssueStatus, IssueStatus>> = {
  ROUTED: "ACKNOWLEDGED",
  REOPENED: "ACKNOWLEDGED",
  ACKNOWLEDGED: "IN_PROGRESS",
  IN_PROGRESS: "RESOLVED",
};

/** Statuses a department in-charge may set directly via updateReportStatus.
 * "resolved" is deliberately excluded — it requires evidence, via
 * submitResolution, never a plain status update. */
export const FORWARD_STATUSES: IssueStatus[] = ["ACKNOWLEDGED", "IN_PROGRESS"];

/** The single next status the department may move this report to, or null
 * when there is no department action available (not yet routed, or
 * already resolved). */
export function nextDepartmentStatus(current: IssueStatus): IssueStatus | null {
  return DEPARTMENT_NEXT_STATUS[current] ?? null;
}

export function canAdvanceStatus(current: IssueStatus, next: IssueStatus): boolean {
  if (!FORWARD_STATUSES.includes(next)) return false;
  return nextDepartmentStatus(current) === next;
}

export function canSubmitResolution(current: IssueStatus): boolean {
  return nextDepartmentStatus(current) === "RESOLVED";
}

/** Friendly explanation for a rejected department transition — never a raw
 * database message. */
export function transitionErrorMessage(current: IssueStatus, requested: IssueStatus): string {
  if (current === "RESOLVED") return "This report has already been resolved.";
  if (current === requested) return `This report is already ${STATUS_LABEL[current]}.`;
  const next = nextDepartmentStatus(current);
  if (!next) return "This report hasn't been routed to a department yet.";
  return `This report is ${STATUS_LABEL[current]} — the next step is "${ACTION_LABEL[next]}".`;
}

const STATUS_LABEL: Record<IssueStatus, string> = {
  REPORTED: "reported",
  AI_ANALYZED: "AI analyzed",
  ROUTED: "routed",
  ACKNOWLEDGED: "acknowledged",
  IN_PROGRESS: "in progress",
  RESOLVED: "resolved",
  REOPENED: "reopened",
};

/** Button labels for the department's next step (DepartmentActionsPanel). */
export const ACTION_LABEL: Partial<Record<IssueStatus, string>> = {
  ACKNOWLEDGED: "Acknowledge",
  IN_PROGRESS: "Start work",
  RESOLVED: "Resolve",
};
