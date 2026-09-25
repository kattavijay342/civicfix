import { stateNames, getDistricts, getConstituencies, getAreas } from "@/lib/jurisdiction";
import { isAppRole } from "@/lib/role-routes";
import type { UserRole } from "@/lib/types";

export interface JurisdictionInput {
  govState: string | null;
  govDistrict: string | null;
  govConstituency: string | null;
  govArea: string | null;
}

/** The exact profile columns an admin role change writes. */
export interface RoleAssignment {
  role: UserRole;
  department_id: string | null;
  gov_state: string | null;
  gov_district: string | null;
  gov_constituency: string | null;
  gov_area: string | null;
}

function clean(value: FormDataEntryValue | null): string | null {
  const s = String(value ?? "").trim();
  return s || null;
}

export function readJurisdiction(formData: FormData): JurisdictionInput {
  return {
    govState: clean(formData.get("govState")),
    govDistrict: clean(formData.get("govDistrict")),
    govConstituency: clean(formData.get("govConstituency")),
    govArea: clean(formData.get("govArea")),
  };
}

/**
 * Every jurisdiction level the admin set must exist under its parent in
 * the configured hierarchy (src/lib/jurisdiction.ts) — the same values the
 * admin UI offers — and a level can't be set without its parent. These
 * strings end up in the RLS scope (report_in_my_jurisdiction), so they are
 * checked server-side rather than trusted from the form.
 */
export function validateJurisdiction(j: JurisdictionInput): string | null {
  const { govState, govDistrict, govConstituency, govArea } = j;
  if (govState && !stateNames.includes(govState)) return "Unknown state.";
  if (govDistrict && (!govState || !getDistricts(govState).includes(govDistrict))) return "Unknown district for that state.";
  if (govConstituency && (!govDistrict || !getConstituencies(govState!, govDistrict).includes(govConstituency))) {
    return "Unknown constituency for that district.";
  }
  if (govArea && (!govConstituency || !getAreas(govState!, govDistrict!, govConstituency).includes(govArea))) {
    return "Unknown area for that constituency.";
  }
  return null;
}

/**
 * Validates an admin-requested role change and returns the normalized
 * columns to write. Government and department in-charge accounts must be
 * scoped to at least a state — an unscoped account would either see
 * nothing (government RLS) or route nothing (department_incharges), which
 * is never what an admin means to create. Fields that don't apply to the
 * role are cleared, so a demotion never leaves stale scope behind.
 */
export function buildRoleAssignment(
  role: unknown,
  departmentId: string | null,
  jurisdiction: JurisdictionInput
): { error: string } | { assignment: RoleAssignment } {
  if (!isAppRole(role)) return { error: "Invalid role." };

  const scoped = role === "government" || role === "department_incharge";
  if (role === "department_incharge" && !departmentId) {
    return { error: "Select a department for a department in-charge." };
  }
  if (scoped) {
    if (!jurisdiction.govState) return { error: "Select a jurisdiction (at least a state)." };
    const jurisdictionError = validateJurisdiction(jurisdiction);
    if (jurisdictionError) return { error: jurisdictionError };
  }

  return {
    assignment: {
      role,
      department_id: role === "department_incharge" ? departmentId : null,
      gov_state: scoped ? jurisdiction.govState : null,
      gov_district: scoped ? jurisdiction.govDistrict : null,
      gov_constituency: scoped ? jurisdiction.govConstituency : null,
      gov_area: scoped ? jurisdiction.govArea : null,
    },
  };
}
