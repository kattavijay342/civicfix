import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProblemCategory } from "@/lib/types";
import { departmentNameForCategory } from "@/lib/routing";

interface JurisdictionInput {
  state?: string | null;
  district?: string | null;
  constituency?: string | null;
  area?: string | null;
}

/**
 * Resolves a report to its department + (if one is configured) a specific
 * in-charge. This is the ONLY place routing decisions are made — the AI's
 * "recommended_department" text is never used here, only the citizen's
 * category (via the fixed categoryDepartmentMap) and the report's
 * jurisdiction. If no in-charge is configured yet for that department/area,
 * the report is still routed to the department with incharge left null;
 * an admin can assign one later.
 */
export async function resolveAssignment(
  admin: SupabaseClient,
  category: ProblemCategory,
  location: JurisdictionInput
): Promise<{ departmentId: string; inchargeId: string | null } | null> {
  const departmentName = departmentNameForCategory(category);

  const { data: department } = await admin
    .from("departments")
    .select("id")
    .eq("name", departmentName)
    .single();

  if (!department) return null;

  const { data: incharges } = await admin
    .from("department_incharges")
    .select("profile_id, gov_state, gov_district, gov_constituency, gov_area")
    .eq("department_id", department.id)
    .eq("is_active", true);

  const inchargeId = pickMostSpecificMatch(incharges ?? [], location);

  return { departmentId: department.id, inchargeId };
}

function pickMostSpecificMatch(
  incharges: Array<{
    profile_id: string;
    gov_state: string | null;
    gov_district: string | null;
    gov_constituency: string | null;
    gov_area: string | null;
  }>,
  location: JurisdictionInput
): string | null {
  let bestMatch: { profileId: string; specificity: number } | null = null;

  for (const incharge of incharges) {
    const fields: Array<[string | null, string | null | undefined]> = [
      [incharge.gov_state, location.state],
      [incharge.gov_district, location.district],
      [incharge.gov_constituency, location.constituency],
      [incharge.gov_area, location.area],
    ];

    let specificity = 0;
    let mismatched = false;
    for (const [scopeValue, locationValue] of fields) {
      if (scopeValue === null) continue;
      if (scopeValue === locationValue) {
        specificity += 1;
      } else {
        mismatched = true;
        break;
      }
    }

    if (mismatched) continue;
    if (!bestMatch || specificity > bestMatch.specificity) {
      bestMatch = { profileId: incharge.profile_id, specificity };
    }
  }

  return bestMatch?.profileId ?? null;
}
