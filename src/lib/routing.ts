import type { ProblemCategory } from "./types";

/**
 * The application's configured category -> department mapping. It is both
 * the deterministic fallback route and the consistency check the AI's
 * department recommendation must pass (see decideDepartment below).
 */
export const categoryDepartmentMap: Record<ProblemCategory, string> = {
  ROAD: "Roads & Infrastructure",
  INFRASTRUCTURE: "Roads & Infrastructure",
  GARBAGE: "Sanitation",
  DUMPING: "Sanitation",
  SEWAGE: "Sanitation",
  WATER_LEAKAGE: "Water Supply",
  DRAINAGE: "Drainage",
  STREETLIGHT: "Electrical",
  OTHER: "General Administration",
};

export function departmentNameForCategory(category: ProblemCategory): string {
  return categoryDepartmentMap[category];
}

/**
 * Other names the model (and people) commonly use for a configured
 * department — e.g. live Gemini output has said "Roads & Buildings
 * Department" and "Electricity and Public Lighting Department". Compared
 * after normalizeDepartmentName(), so casing, "&"/"and" and a trailing
 * "Department" never matter. An alias only ever resolves to a department
 * that also exists in the `departments` table; it can't create one.
 */
const DEPARTMENT_ALIASES: Record<string, string[]> = {
  "Roads & Infrastructure": ["roads", "road", "roads and buildings", "public works", "pwd", "r and b", "engineering"],
  Sanitation: ["solid waste management", "garbage", "waste management", "public health and sanitation"],
  "Water Supply": ["water", "water works", "rural water supply", "water supply and sewerage"],
  Drainage: ["storm water drainage", "drains"],
  Electrical: ["electricity", "street lighting", "streetlights", "electricity and public lighting", "public lighting"],
  "General Administration": ["municipal administration", "administration"],
};

export function normalizeDepartmentName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(department|dept|division|wing|section|office)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ConfiguredDepartment {
  id: string;
  name: string;
}

/**
 * Resolves free-form AI text to one of the CONFIGURED departments, or null.
 * Tries the whole string, then each "/"-separated part ("Electrical
 * Department / Street Lighting Division"). Never fuzzy beyond the explicit
 * alias table — an unknown name is unresolved, not guessed.
 */
export function matchConfiguredDepartment(
  recommendation: string | null | undefined,
  departments: ConfiguredDepartment[]
): ConfiguredDepartment | null {
  if (!recommendation) return null;
  const byKey = new Map<string, ConfiguredDepartment>();
  for (const d of departments) {
    byKey.set(normalizeDepartmentName(d.name), d);
    for (const alias of DEPARTMENT_ALIASES[d.name] ?? []) {
      const key = normalizeDepartmentName(alias);
      if (!byKey.has(key)) byKey.set(key, d);
    }
  }
  const candidates = [recommendation, ...recommendation.split("/")];
  for (const candidate of candidates) {
    const hit = byKey.get(normalizeDepartmentName(candidate));
    if (hit) return hit;
  }
  return null;
}

export type RoutingBasis = "ai_recommendation" | "category_mapping";

export type DepartmentDecision =
  | { ok: true; department: ConfiguredDepartment; basis: RoutingBasis; note: string }
  | { ok: false; reason: "department_not_configured" };

/**
 * AI recommendation -> configured department. The recommendation is
 * accepted only when it names a configured department that is also what
 * the configured category mapping allows for the AI's (schema-validated)
 * category or the citizen's category. Otherwise the deterministic category
 * mapping decides. The model can therefore pick between plausible
 * configured departments but never route a pothole to Water Supply, and
 * never reach a department that isn't in the `departments` table.
 */
export function decideDepartment(input: {
  aiRecommendation: string | null;
  aiCategory: ProblemCategory | null;
  citizenCategory: ProblemCategory;
  departments: ConfiguredDepartment[];
}): DepartmentDecision {
  const { departments } = input;
  const primaryCategory = input.aiCategory ?? input.citizenCategory;
  const allowed = new Set([categoryDepartmentMap[primaryCategory], categoryDepartmentMap[input.citizenCategory]]);

  const recommended = matchConfiguredDepartment(input.aiRecommendation, departments);
  if (recommended && allowed.has(recommended.name)) {
    return {
      ok: true,
      department: recommended,
      basis: "ai_recommendation",
      note: `Routed to ${recommended.name} (AI recommendation validated against configured departments)`,
    };
  }

  const mapped = departments.find((d) => d.name === categoryDepartmentMap[primaryCategory]);
  if (mapped) {
    const why = !input.aiRecommendation
      ? "no AI recommendation"
      : recommended
        ? "AI recommendation did not match the issue category"
        : "AI recommendation is not a configured department";
    return {
      ok: true,
      department: mapped,
      basis: "category_mapping",
      note: `Routed to ${mapped.name} by configured category mapping (${why})`,
    };
  }

  return { ok: false, reason: "department_not_configured" };
}

export interface JurisdictionLike {
  state?: string | null;
  district?: string | null;
  constituency?: string | null;
  area?: string | null;
}

export interface InchargeScope {
  gov_state: string | null;
  gov_district: string | null;
  gov_constituency: string | null;
  gov_area: string | null;
}

/**
 * How specifically an in-charge's scope covers a location: the number of
 * scope levels set (all of which must equal the location's), or null when
 * any set level differs. An in-charge with no scope at all covers nothing —
 * the same rule report_in_my_jurisdiction() applies to government users,
 * and G1's admin provisioning never creates one anyway.
 */
export function jurisdictionMatchSpecificity(scope: InchargeScope, location: JurisdictionLike): number | null {
  const pairs: Array<[string | null, string | null | undefined]> = [
    [scope.gov_state, location.state],
    [scope.gov_district, location.district],
    [scope.gov_constituency, location.constituency],
    [scope.gov_area, location.area],
  ];
  let specificity = 0;
  for (const [scopeValue, locationValue] of pairs) {
    if (scopeValue === null) continue;
    if (scopeValue !== locationValue) return null;
    specificity += 1;
  }
  return specificity === 0 ? null : specificity;
}

export function isJurisdictionCompatible(scope: InchargeScope, location: JurisdictionLike): boolean {
  return jurisdictionMatchSpecificity(scope, location) !== null;
}

export interface InchargeCandidate extends InchargeScope {
  profile_id: string;
  created_at: string;
}

/**
 * Picks the most specifically-scoped compatible in-charge. Ties go to the
 * longest-serving assignment (then profile id) so the same report always
 * routes to the same person regardless of row order.
 */
export function pickIncharge(candidates: InchargeCandidate[], location: JurisdictionLike): string | null {
  let best: { candidate: InchargeCandidate; specificity: number } | null = null;
  for (const candidate of candidates) {
    const specificity = jurisdictionMatchSpecificity(candidate, location);
    if (specificity === null) continue;
    if (
      !best ||
      specificity > best.specificity ||
      (specificity === best.specificity &&
        (candidate.created_at < best.candidate.created_at ||
          (candidate.created_at === best.candidate.created_at && candidate.profile_id < best.candidate.profile_id)))
    ) {
      best = { candidate, specificity };
    }
  }
  return best?.candidate.profile_id ?? null;
}

export type RoutingState = "assigned" | "unassigned" | "pending_ai" | "pending_department" | "not_routed";

/** The routing state shown on report detail — derived only from what is
 * stored, so it can never claim an assignment that doesn't exist. */
export function routingStateFor(
  assignment: { inchargeId: string | null } | null,
  status: string
): RoutingState {
  if (assignment) return assignment.inchargeId ? "assigned" : "unassigned";
  if (status === "REPORTED") return "pending_ai";
  if (status === "AI_ANALYZED") return "pending_department";
  return "not_routed";
}

export const ROUTING_STATE_LABELS: Record<RoutingState, string> = {
  assigned: "Assigned",
  unassigned: "Unassigned — no in-charge configured for this department and jurisdiction",
  pending_ai: "Routing pending — waiting for AI analysis",
  pending_department: "Routing pending — no configured department matched",
  not_routed: "Not routed",
};
