import type { ProblemCategory } from "./types";

/**
 * The application's configured category -> department mapping. This is the
 * ONLY source of truth for which department a report is routed to.
 *
 * The AI (see src/lib/ai.ts) may *recommend* a department name in its free
 * text reasoning, but the actual routing decision always comes from this
 * table plus the report's jurisdiction (see resolveAssignment in
 * src/lib/actions/routing.ts) — never from the model's output directly.
 * This keeps a hallucinated department name from ever reaching the database.
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
