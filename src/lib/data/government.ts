import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { mapReportsToIssues } from "@/lib/data/report-mapping";
import type { AIInsight, CivicIssue, DepartmentPerformance, DuplicateGroup } from "@/lib/types";
import { categoryFromDb } from "@/lib/db-enums";

/** SLA used for the "On-Time Resolution Rate" metric (Step 8). Configured
 * here rather than hardcoded per-report — change these to match real
 * departmental SLAs when they're defined. */
const SLA_DAYS_BY_PRIORITY: Record<string, number> = {
  critical: 3,
  high: 7,
  medium: 14,
  low: 21,
};

/**
 * Reports visible to the calling government user. RLS
 * (report_in_my_jurisdiction, see supabase/migrations/0002_rls_policies.sql)
 * already restricts the underlying `reports` select to that user's
 * configured gov_state/district/constituency/area — there is no
 * application-level jurisdiction filtering happening here, only reads.
 */
export async function getGovernmentIssues(): Promise<CivicIssue[]> {
  const supabase = await createClient();
  const { data: reports } = await supabase.from("reports").select("*").order("created_at", { ascending: false });
  return mapReportsToIssues(supabase, createAdminClient(), reports ?? []);
}

export interface AreaOverview {
  totalIssues: number;
  resolved: number;
  pending: number;
  critical: number;
  resolutionRate: number;
  onTimeResolutionRate: number;
}

export async function getAreaOverview(): Promise<AreaOverview> {
  const supabase = await createClient();
  const { data: reports } = await supabase
    .from("reports")
    .select("id, status, priority, created_at");

  const rows = reports ?? [];
  const totalIssues = rows.length;
  const resolved = rows.filter((r) => r.status === "resolved").length;
  const pending = totalIssues - resolved;
  const critical = rows.filter((r) => r.priority === "critical").length;
  const resolutionRate = totalIssues ? Math.round((resolved / totalIssues) * 100) : 0;

  const onTimeResolutionRate = await computeOnTimeRate(
    rows.filter((r) => r.status === "resolved").map((r) => r.id)
  );

  return { totalIssues, resolved, pending, critical, resolutionRate, onTimeResolutionRate };
}

async function computeOnTimeRate(resolvedReportIds: string[]): Promise<number> {
  if (resolvedReportIds.length === 0) return 0;
  const admin = createAdminClient();

  const [{ data: reports }, { data: evidence }] = await Promise.all([
    admin.from("reports").select("id, priority, created_at").in("id", resolvedReportIds),
    admin.from("resolution_evidence").select("report_id, resolved_at").in("report_id", resolvedReportIds),
  ]);

  const resolvedAtByReport = new Map((evidence ?? []).map((e) => [e.report_id, e.resolved_at]));
  let eligible = 0;
  let onTime = 0;

  for (const r of reports ?? []) {
    const resolvedAt = resolvedAtByReport.get(r.id);
    if (!resolvedAt) continue; // no resolution_evidence row — not eligible
    eligible += 1;
    const slaDays = SLA_DAYS_BY_PRIORITY[r.priority ?? "medium"] ?? 14;
    const takenDays = (new Date(resolvedAt).getTime() - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24);
    if (takenDays <= slaDays) onTime += 1;
  }

  return eligible ? Math.round((onTime / eligible) * 100) : 0;
}

export async function getDepartmentPerformance(): Promise<DepartmentPerformance[]> {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: departments } = await supabase.from("departments").select("id, name");
  const { data: reports } = await supabase.from("reports").select("id, status, priority, created_at");
  const reportById = new Map((reports ?? []).map((r) => [r.id, r]));
  const reportIds = (reports ?? []).map((r) => r.id);

  if (reportIds.length === 0) {
    return (departments ?? []).map((d) => ({
      name: d.name,
      resolutionRate: 0,
      totalIssues: 0,
      resolvedIssues: 0,
      pendingIssues: 0,
      onTimeRate: 0,
      avgResolutionDays: 0,
      trend: 0,
    }));
  }

  const { data: assignments } = await admin.from("report_assignments").select("report_id, department_id").in(
    "report_id",
    reportIds
  );
  const { data: evidence } = await admin
    .from("resolution_evidence")
    .select("report_id, resolved_at")
    .in("report_id", reportIds);
  const resolvedAtByReport = new Map((evidence ?? []).map((e) => [e.report_id, e.resolved_at]));

  const reportIdsByDept = new Map<string, string[]>();
  for (const a of assignments ?? []) {
    const list = reportIdsByDept.get(a.department_id) ?? [];
    list.push(a.report_id);
    reportIdsByDept.set(a.department_id, list);
  }

  return (departments ?? []).map((dept) => {
    const ids = reportIdsByDept.get(dept.id) ?? [];
    const deptReports = ids.map((id) => reportById.get(id)).filter((r): r is NonNullable<typeof r> => !!r);

    const totalIssues = deptReports.length;
    const resolvedIssues = deptReports.filter((r) => r.status === "resolved").length;
    const pendingIssues = totalIssues - resolvedIssues;
    const resolutionRate = totalIssues ? Math.round((resolvedIssues / totalIssues) * 100) : 0;

    let onTimeEligible = 0;
    let onTime = 0;
    let totalResolutionDays = 0;
    let resolutionDaysCount = 0;

    for (const r of deptReports) {
      const resolvedAt = resolvedAtByReport.get(r.id);
      if (!resolvedAt) continue;
      onTimeEligible += 1;
      const slaDays = SLA_DAYS_BY_PRIORITY[r.priority ?? "medium"] ?? 14;
      const takenDays = (new Date(resolvedAt).getTime() - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24);
      if (takenDays <= slaDays) onTime += 1;
      totalResolutionDays += takenDays;
      resolutionDaysCount += 1;
    }

    return {
      name: dept.name,
      resolutionRate,
      totalIssues,
      resolvedIssues,
      pendingIssues,
      onTimeRate: onTimeEligible ? Math.round((onTime / onTimeEligible) * 100) : 0,
      avgResolutionDays: resolutionDaysCount ? Math.round((totalResolutionDays / resolutionDaysCount) * 10) / 10 : 0,
      trend: 0,
    };
  });
}

/** Deterministic, real-data-derived insights (Step 16). No LLM call here —
 * these are computed directly from stored reports so they're always exactly
 * as accurate as the underlying data, with zero added latency/cost. */
export async function getAIInsights(): Promise<AIInsight[]> {
  const supabase = await createClient();
  const { data: reports } = await supabase
    .from("reports")
    .select("id, category, status, priority, created_at");

  const rows = reports ?? [];
  const insights: AIInsight[] = [];
  if (rows.length === 0) return insights;

  const categoryCounts = new Map<string, number>();
  for (const r of rows) categoryCounts.set(r.category, (categoryCounts.get(r.category) ?? 0) + 1);
  const topCategory = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topCategory && topCategory[1] > 1) {
    insights.push({
      id: "top-category",
      text: `${categoryFromDb[topCategory[0]] ?? topCategory[0]} accounts for ${topCategory[1]} of ${rows.length} reports — the most common issue type in your jurisdiction.`,
      tone: "neutral",
    });
  }

  const criticalUnresolved = rows.filter((r) => r.priority === "critical" && r.status !== "resolved").length;
  if (criticalUnresolved > 0) {
    insights.push({
      id: "critical-unresolved",
      text: `${criticalUnresolved} critical-priority report${criticalUnresolved === 1 ? "" : "s"} still unresolved — these need attention first.`,
      tone: "down",
    });
  }

  const agingThresholdDays = 15;
  const aging = rows.filter(
    (r) =>
      r.status !== "resolved" &&
      (Date.now() - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24) > agingThresholdDays
  ).length;
  if (aging > 0) {
    insights.push({
      id: "aging",
      text: `${aging} report${aging === 1 ? " has" : "s have"} been pending for more than ${agingThresholdDays} days.`,
      tone: "down",
    });
  }

  const last7Days = rows.filter(
    (r) => (Date.now() - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24) <= 7
  ).length;
  const prior7Days = rows.filter((r) => {
    const ageDays = (Date.now() - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24);
    return ageDays > 7 && ageDays <= 14;
  }).length;
  if (last7Days > 0 || prior7Days > 0) {
    const tone = last7Days > prior7Days ? "up" : last7Days < prior7Days ? "down" : "neutral";
    insights.push({
      id: "weekly-trend",
      text: `${last7Days} new report${last7Days === 1 ? "" : "s"} in the last 7 days, vs ${prior7Days} the week before.`,
      tone: tone === "up" ? "down" : tone === "down" ? "up" : "neutral", // more new reports is a "down" signal for workload
    });
  }

  return insights;
}

export async function getDuplicateGroups(): Promise<DuplicateGroup[]> {
  const supabase = await createClient();
  const { data: flags } = await supabase
    .from("report_duplicate_flags")
    .select("report_id, possible_duplicate_of")
    .eq("reviewed", false);

  if (!flags || flags.length === 0) return [];

  const primaryIds = flags.map((f) => f.report_id);
  const { data: reports } = await supabase.from("reports").select("*").in("id", primaryIds);
  if (!reports || reports.length === 0) return [];

  const admin = createAdminClient();
  const issues = await mapReportsToIssues(supabase, admin, reports);
  const issueById = new Map(issues.map((i) => [i.id, i]));

  const groups: DuplicateGroup[] = [];
  for (const flag of flags) {
    const issue = issueById.get(flag.report_id);
    if (!issue) continue;
    groups.push({
      primary: {
        id: issue.id,
        title: issue.title,
        location: issue.location,
        category: issue.category,
        status: issue.status,
      },
      similarCount: 1,
    });
  }
  return groups;
}
