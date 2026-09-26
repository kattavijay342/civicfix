import { isJurisdictionCompatible, type InchargeScope, type JurisdictionLike } from "@/lib/routing";

/**
 * G4 — "is this assignment still effective for this in-charge?"
 *
 * report_assignments.incharge_id alone is not enough: an in-charge can be
 * deactivated, moved to another department, re-scoped to another
 * jurisdiction, or demoted after a report was routed to them. The
 * assignment only authorizes them while ALL of the rules G3 used to pick
 * them (findIncharge in src/lib/actions/routing.ts) still hold:
 *
 *   - the profile is still a department_incharge,
 *   - the profile is still for the assignment's department,
 *   - an ACTIVE department_incharges row exists for that department, and
 *   - that row's scope still covers the report's location.
 *
 * Pure so it can be unit-tested; loaders live in
 * src/lib/data/incharge-access.ts.
 */

export type InchargeAccessDenial =
  | "not_incharge"
  | "not_assigned"
  | "wrong_department"
  | "inactive"
  | "out_of_jurisdiction";

export type InchargeAccess = { ok: true } | { ok: false; reason: InchargeAccessDenial };

export interface InchargeAccessInput {
  userId: string;
  profile: { role: string; department_id: string | null } | null;
  assignment: { incharge_id: string | null; department_id: string } | null;
  /** This user's department_incharges rows (any department, any state). */
  inchargeRows: Array<InchargeScope & { department_id: string; is_active: boolean }>;
  location: JurisdictionLike | null;
}

export function evaluateInchargeAccess(input: InchargeAccessInput): InchargeAccess {
  const { userId, profile, assignment, inchargeRows, location } = input;
  if (!profile || profile.role !== "department_incharge") return { ok: false, reason: "not_incharge" };
  if (!assignment || assignment.incharge_id !== userId) return { ok: false, reason: "not_assigned" };
  if (profile.department_id !== assignment.department_id) return { ok: false, reason: "wrong_department" };

  const activeRows = inchargeRows.filter((r) => r.department_id === assignment.department_id && r.is_active);
  if (activeRows.length === 0) return { ok: false, reason: "inactive" };

  // No stored location = the jurisdiction can't be verified: fail closed.
  if (!location || !activeRows.some((r) => isJurisdictionCompatible(r, location))) {
    return { ok: false, reason: "out_of_jurisdiction" };
  }
  return { ok: true };
}

/** Friendly, non-revealing messages for the action layer. */
export const INCHARGE_ACCESS_MESSAGES: Record<InchargeAccessDenial, string> = {
  not_incharge: "Only the assigned department in-charge can update this report.",
  not_assigned: "This report isn't assigned to you.",
  wrong_department: "This report belongs to a department you're no longer assigned to.",
  inactive: "Your department in-charge access is inactive. Contact an administrator.",
  out_of_jurisdiction: "This report is outside your current jurisdiction.",
};
