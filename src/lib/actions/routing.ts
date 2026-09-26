import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProblemCategory } from "@/lib/types";
import {
  decideDepartment,
  departmentNameForCategory,
  pickIncharge,
  type ConfiguredDepartment,
  type InchargeCandidate,
  type JurisdictionLike,
  type RoutingBasis,
} from "@/lib/routing";
import { logStatusChange } from "@/lib/actions/status-history";
import { notifyInchargeOfAssignment } from "@/lib/notifications/report-assigned";

/** The configured departments (admin-managed reference data). */
export async function loadConfiguredDepartments(admin: SupabaseClient): Promise<ConfiguredDepartment[]> {
  const { data } = await admin.from("departments").select("id, name");
  return (data ?? []) as ConfiguredDepartment[];
}

/**
 * Active in-charges of `departmentId` whose scope covers `location`. The
 * department_incharges row is cross-checked against the profile itself
 * (still a department_incharge, still for this department), so a demoted
 * or moved account is never picked even if a stale row survived. Two
 * batched queries regardless of how many in-charges exist.
 */
async function findIncharge(
  admin: SupabaseClient,
  departmentId: string,
  location: JurisdictionLike
): Promise<string | null> {
  const { data: rows } = await admin
    .from("department_incharges")
    .select("profile_id, gov_state, gov_district, gov_constituency, gov_area, created_at")
    .eq("department_id", departmentId)
    .eq("is_active", true);
  const candidates = (rows ?? []) as InchargeCandidate[];
  if (candidates.length === 0) return null;

  const { data: profiles } = await admin
    .from("profiles")
    .select("id, role, department_id")
    .in("id", candidates.map((c) => c.profile_id));
  const authorized = new Set(
    (profiles ?? [])
      .filter((p) => p.role === "department_incharge" && p.department_id === departmentId)
      .map((p) => p.id as string)
  );

  return pickIncharge(
    candidates.filter((c) => authorized.has(c.profile_id)),
    location
  );
}

export type AssignmentResolution =
  | {
      ok: true;
      departmentId: string;
      departmentName: string;
      inchargeId: string | null;
      basis: RoutingBasis;
      note: string;
    }
  | { ok: false; reason: "department_not_configured" };

/**
 * AI recommendation -> configured department -> authorized, jurisdiction-
 * compatible in-charge. Every input here is server-derived: the AI output
 * was schema-validated in src/lib/ai.ts, the category was validated by the
 * server action, and the location's jurisdiction was canonicalized by
 * resolveReportJurisdiction(). Nothing a client sends can name a
 * department id or a user id.
 */
export async function resolveAssignment(
  admin: SupabaseClient,
  input: {
    aiRecommendation: string | null;
    aiCategory: ProblemCategory | null;
    citizenCategory: ProblemCategory;
    departments?: ConfiguredDepartment[];
  },
  location: JurisdictionLike
): Promise<AssignmentResolution> {
  const departments = input.departments ?? (await loadConfiguredDepartments(admin));
  const decision = decideDepartment({ ...input, departments });
  if (!decision.ok) return decision;

  const inchargeId = await findIncharge(admin, decision.department.id, location);
  return {
    ok: true,
    departmentId: decision.department.id,
    departmentName: decision.department.name,
    inchargeId,
    basis: decision.basis,
    note: decision.note,
  };
}

/** Category-only department lookup, for callers with no AI analysis (civic
 * incidents created while AI was unavailable). */
export async function departmentIdForCategory(
  admin: SupabaseClient,
  category: ProblemCategory
): Promise<string | null> {
  const { data } = await admin
    .from("departments")
    .select("id")
    .eq("name", departmentNameForCategory(category))
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

export type RouteReportResult =
  | { outcome: "routed"; departmentId: string; departmentName: string; inchargeId: string | null; basis: RoutingBasis }
  | { outcome: "already_routed" }
  | { outcome: "unresolved"; reason: string }
  | { outcome: "failed" };

/**
 * Routes one AI-analyzed report. The unique report_assignments.report_id
 * constraint is the idempotency guard: only the call that actually inserts
 * the assignment advances the status and notifies, so a retry or a
 * concurrent run can't double-route or double-notify. An unresolved route
 * leaves the report at ai_analyzed ("Routing pending"), still fully visible
 * to government users by jurisdiction — it never invents a department.
 */
export async function routeReport(
  admin: SupabaseClient,
  input: {
    reportId: string;
    title: string;
    categoryLabel: string;
    citizenCategory: ProblemCategory;
    aiCategory: ProblemCategory | null;
    aiRecommendation: string | null;
    priority: string | null;
    location: JurisdictionLike;
    departments?: ConfiguredDepartment[];
  }
): Promise<RouteReportResult> {
  const resolution = await resolveAssignment(admin, input, input.location);
  if (!resolution.ok) {
    console.warn("[routing] unresolved — report left at ai_analyzed", {
      reportId: input.reportId,
      reason: resolution.reason,
    });
    return { outcome: "unresolved", reason: resolution.reason };
  }

  const { error: insertError } = await admin.from("report_assignments").insert({
    report_id: input.reportId,
    department_id: resolution.departmentId,
    incharge_id: resolution.inchargeId,
    assignment_method: "auto",
  });
  if (insertError) {
    if (insertError.code === "23505") return { outcome: "already_routed" };
    console.error("[routing] assignment insert failed", { reportId: input.reportId, code: insertError.code });
    return { outcome: "failed" };
  }

  const { data: advanced } = await admin
    .from("reports")
    .update({ status: "routed" })
    .eq("id", input.reportId)
    .eq("status", "ai_analyzed")
    .select("id");
  if (advanced?.length) {
    await logStatusChange(admin, input.reportId, "ai_analyzed", "routed", null, resolution.note);
  }

  if (!resolution.inchargeId) {
    console.warn("[routing] routed without an in-charge — none configured for this department/jurisdiction", {
      reportId: input.reportId,
      department: resolution.departmentName,
    });
  } else {
    await notifyInchargeOfAssignment(admin, {
      reportId: input.reportId,
      inchargeId: resolution.inchargeId,
      title: input.title,
      categoryLabel: input.categoryLabel,
      departmentName: resolution.departmentName,
      priority: input.priority,
      jurisdiction: input.location,
    });
  }

  return {
    outcome: "routed",
    departmentId: resolution.departmentId,
    departmentName: resolution.departmentName,
    inchargeId: resolution.inchargeId,
    basis: resolution.basis,
  };
}
