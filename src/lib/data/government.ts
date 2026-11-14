import "server-only";
import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  mapReportsToIssues,
  applyIssueFilters,
  toPagedIssues,
  clampPage,
  ISSUE_LIST_SELECT,
  ISSUE_LIST_PAGE_SIZE,
} from "@/lib/data/report-mapping";
import type {
  AIInsight,
  CivicIssue,
  DepartmentPerformance,
  DuplicateGroup,
  IssueListFilters,
  PagedIssues,
  ProblemCategory,
} from "@/lib/types";
import { categoryFromDb } from "@/lib/db-enums";
import {
  compareCategoryPeriods,
  mapAreaBreakdownRows,
  type AreaBreakdownRow,
  type AreaBreakdownRowRaw,
  type CategoryCountRow,
  type CategoryPeriodComparison,
} from "@/lib/government-analytics";

/** Only `.rpc()` is needed by the G8 loaders below — narrowed so unit tests
 * can pass a fake (src/lib/data/government.test.ts) while production passes
 * the caller's own RLS-scoped session client. */
type RpcClient = Pick<SupabaseClient, "rpc">;

/**
 * Reports visible to the calling government user. RLS
 * (report_in_my_jurisdiction, see supabase/migrations/0002_rls_policies.sql)
 * already restricts the underlying `reports` select to that user's
 * configured gov_state/district/constituency/area — there is no
 * application-level jurisdiction filtering happening here, only reads.
 */
export async function getGovernmentIssues(): Promise<CivicIssue[]> {
  const supabase = await createClient();
  const { data: reports } = await supabase
    .from("reports")
    .select("id, title, category, status, priority, created_at, description")
    .order("created_at", { ascending: false })
    .limit(200);
  return mapReportsToIssues(supabase, createAdminClient(), reports ?? []);
}

/**
 * Real server-side pagination (Phase 4 Step 7) for the full, filterable
 * "All Issues" view (see /government/issues) — the dashboard's own
 * getGovernmentIssues() above stays a bounded summary feed; this is the
 * complete, paginated access path so a jurisdiction with more than 200
 * issues is never silently truncated.
 */
export async function getGovernmentIssuesPage(page: number, filters?: IssueListFilters): Promise<PagedIssues> {
  const supabase = await createClient();
  const currentPage = clampPage(page);
  const from = (currentPage - 1) * ISSUE_LIST_PAGE_SIZE;
  const to = from + ISSUE_LIST_PAGE_SIZE - 1;

  let query = supabase.from("reports").select(ISSUE_LIST_SELECT, { count: "exact" });
  query = applyIssueFilters(query, filters);

  // Department isn't a column on `reports` itself — resolve the set of
  // report ids assigned to it first (same "resolve ids, then filter"
  // pattern getAssignedIssuesPage already uses for a single in-charge's
  // own assignments), scoped through the caller's own session so RLS still
  // restricts report_assignments to jurisdiction-visible rows.
  if (filters?.department) {
    const { data: assignments } = await supabase
      .from("report_assignments")
      .select("report_id")
      .eq("department_id", filters.department);
    const ids = (assignments ?? []).map((a) => a.report_id);
    query = query.in("id", ids.length > 0 ? ids : ["00000000-0000-0000-0000-000000000000"]);
  }

  const { data: reports, count } = await query.order("created_at", { ascending: false }).range(from, to);

  return toPagedIssues(supabase, createAdminClient(), reports ?? [], count ?? 0, currentPage, ISSUE_LIST_PAGE_SIZE);
}

export interface AreaOverview {
  totalIssues: number;
  resolved: number;
  /** Every non-resolved status, reopened included (total − resolved). */
  pending: number;
  /** G8 — OPEN (not resolved) critical-priority issues, from
   * get_insight_metrics().critical_unresolved. null when that RPC failed:
   * never falls back to get_area_overview()'s all-time critical count,
   * which includes resolved reports. */
  critical: number | null;
  resolutionRate: number;
}

/** Row shapes returned by the RPC functions in
 * supabase/migrations/0007_dashboard_aggregates.sql. Declared here (rather
 * than relying on inference) because this project's Supabase clients
 * aren't instantiated with a generated `Database` type, so `.rpc()`
 * otherwise types its result as `{}`.
 *
 * `on_time_resolution_rate`/`on_time_rate` are deliberately NOT read below
 * (Phase 6E audit) — they're computed in SQL from a hardcoded per-priority
 * day threshold (0007's own `case priority when 'critical' then 3 ...`),
 * never a real government-configured due date. Reading and displaying that
 * number as "SLA compliance" would be exactly the fabricated-SLA the Phase
 * 6E spec explicitly forbids. The columns stay in the already-shipped SQL
 * function (editing 0007 is against the rules) — the application layer
 * just stops treating them as real. */
interface AreaOverviewRow {
  total_issues: number;
  resolved: number;
  pending: number;
  critical: number;
  resolution_rate: number;
}

interface DepartmentPerformanceRow {
  department_id: string;
  name: string;
  total_issues: number;
  resolved_issues: number;
  pending_issues: number;
  resolution_rate: number;
  avg_resolution_days: number;
}

interface InsightMetricsRow {
  top_category: string | null;
  top_category_count: number;
  total_reports: number;
  critical_unresolved: number;
  aging_count: number;
  last_7_days: number;
  prior_7_days: number;
}

/** Phase 6A — geographic concentration. Deliberately a SEPARATE function
 * (get_area_concentration(), migration 0009) rather than added columns on
 * get_insight_metrics(): Postgres's CREATE OR REPLACE FUNCTION cannot
 * change a function's OUT-parameter row type (see migration 0009's
 * doc comment), and get_insight_metrics() already has real callers, so
 * this stays fully additive instead of requiring a DROP FUNCTION. */
interface AreaConcentrationRow {
  top_area: string | null;
  top_area_count: number;
}

/**
 * Backed by the get_area_overview() SQL function (Phase 4 Step 8, see
 * supabase/migrations/0007_dashboard_aggregates.sql) instead of pulling
 * every visible report into Node and reducing in JS. Called through the
 * caller's own session client, so it runs under their role — the existing
 * `reports_select` RLS policy still does all the jurisdiction/ownership
 * filtering, exactly as it does for ordinary table reads.
 */
export async function loadInsightMetrics(client: RpcClient): Promise<InsightMetricsRow | null> {
  const { data, error } = await client.rpc("get_insight_metrics").maybeSingle();
  if (error) console.error("get_insight_metrics failed", error);
  return error ? null : ((data as unknown as InsightMetricsRow | null) ?? null);
}

/** One get_insight_metrics() call per request, shared by the overview's
 * open-critical KPI and getAIInsights() below (React request cache). */
const getInsightMetricsRow = cache(async () => loadInsightMetrics(await createClient()));

export async function loadAreaOverview(client: RpcClient, insightMetrics: InsightMetricsRow | null): Promise<AreaOverview> {
  const { data: raw, error } = await client.rpc("get_area_overview").maybeSingle();
  const data = raw as unknown as AreaOverviewRow | null;
  const critical = insightMetrics ? Number(insightMetrics.critical_unresolved) : null;

  if (error || !data) {
    console.error("get_area_overview failed", error);
    return { totalIssues: 0, resolved: 0, pending: 0, critical, resolutionRate: 0 };
  }

  return {
    totalIssues: Number(data.total_issues),
    resolved: Number(data.resolved),
    pending: Number(data.pending),
    // get_area_overview().critical counts resolved criticals too — G8's
    // Critical KPI is open criticals only (see AreaOverview.critical).
    critical,
    resolutionRate: Number(data.resolution_rate),
  };
}

export async function getAreaOverview(): Promise<AreaOverview> {
  const [supabase, insightMetrics] = await Promise.all([createClient(), getInsightMetricsRow()]);
  return loadAreaOverview(supabase, insightMetrics);
}

/**
 * Backed by get_department_performance() (same migration as above) instead
 * of pulling every visible report + assignment + resolution row into Node.
 */
export async function loadDepartmentPerformance(client: RpcClient): Promise<DepartmentPerformance[]> {
  const { data: raw, error } = await client.rpc("get_department_performance");
  const data = raw as unknown as DepartmentPerformanceRow[] | null;

  if (error) {
    console.error("get_department_performance failed", error);
    return [];
  }

  return (data ?? []).map((row) => {
    const resolvedIssues = Number(row.resolved_issues);
    return {
      name: row.name,
      resolutionRate: Number(row.resolution_rate),
      totalIssues: Number(row.total_issues),
      resolvedIssues,
      pendingIssues: Number(row.pending_issues),
      // Phase 6E — no real SLA/due date exists anywhere in this product
      // (see the AreaOverviewRow/DepartmentPerformanceRow comment above);
      // null tells every UI consumer to render the honest "no configured
      // SLA" state instead of a fabricated compliance percentage.
      onTimeRate: null,
      // The SQL returns 0 when there is nothing to average; G8 shows "—".
      avgResolutionDays: resolvedIssues === 0 ? null : Number(row.avg_resolution_days),
      // G8 — no period-over-period field at all: nothing here compares two
      // real windows of this aggregate, so none is shown (previously a
      // hardcoded 0 rendered as "+0%").
    };
  });
}

export async function getDepartmentPerformance(): Promise<DepartmentPerformance[]> {
  return loadDepartmentPerformance(await createClient());
}

/** Deterministic, real-data-derived insights (Step 16). No LLM call here —
 * these are computed directly from stored reports so they're always exactly
 * as accurate as the underlying data, with zero added latency/cost.
 * Backed by get_insight_metrics() (Phase 4 Step 8) for the actual counting
 * — only the human-readable copy/tone is composed here. */
export async function getAIInsights(): Promise<AIInsight[]> {
  const supabase = await createClient();
  const [metrics, concentrationRes] = await Promise.all([
    getInsightMetricsRow(),
    supabase.rpc("get_area_concentration").maybeSingle(),
  ]);
  const concentration = concentrationRes.data as unknown as AreaConcentrationRow | null;
  if (concentrationRes.error) {
    // Independent of get_insight_metrics — a failure here (e.g. migration
    // 0009 not applied yet) never removes the four existing insights below.
    console.error("get_area_concentration failed", concentrationRes.error);
  }

  const insights: AIInsight[] = [];
  if (!metrics || Number(metrics.total_reports) === 0) return insights;

  const totalReports = Number(metrics.total_reports);
  const topCategoryCount = Number(metrics.top_category_count);
  if (metrics.top_category && topCategoryCount > 1) {
    insights.push({
      id: "top-category",
      text: `${categoryFromDb[metrics.top_category] ?? metrics.top_category} accounts for ${topCategoryCount} of ${totalReports} reports — the most common issue type in your jurisdiction.`,
      tone: "neutral",
    });
  }

  const criticalUnresolved = Number(metrics.critical_unresolved);
  if (criticalUnresolved > 0) {
    insights.push({
      id: "critical-unresolved",
      text: `${criticalUnresolved} critical-priority report${criticalUnresolved === 1 ? "" : "s"} still unresolved — these need attention first.`,
      tone: "down",
    });
  }

  const aging = Number(metrics.aging_count);
  const agingThresholdDays = 15;
  if (aging > 0) {
    insights.push({
      id: "aging",
      text: `${aging} report${aging === 1 ? " has" : "s have"} been pending for more than ${agingThresholdDays} days.`,
      tone: "down",
    });
  }

  const last7Days = Number(metrics.last_7_days);
  const prior7Days = Number(metrics.prior_7_days);
  if (last7Days > 0 || prior7Days > 0) {
    const tone = last7Days > prior7Days ? "up" : last7Days < prior7Days ? "down" : "neutral";
    insights.push({
      id: "weekly-trend",
      text: `${last7Days} new report${last7Days === 1 ? "" : "s"} in the last 7 days, vs ${prior7Days} the week before.`,
      tone: tone === "up" ? "down" : tone === "down" ? "up" : "neutral", // more new reports is a "down" signal for workload
    });
  }

  // Real, deterministic geographic-concentration pattern (Phase 6A) — backed
  // by the separate get_area_concentration() function (migration 0009), not
  // an LLM call. Only surfaced when more than one report actually shares the
  // area, otherwise it's not a meaningful "concentration."
  const topAreaCount = Number(concentration?.top_area_count ?? 0);
  if (concentration?.top_area && topAreaCount > 1) {
    insights.push({
      id: "area-concentration",
      text: `${topAreaCount} reports in the last 30 days are concentrated around ${concentration.top_area} — worth a closer look.`,
      tone: "down",
    });
  }

  return insights;
}

export async function getDuplicateGroups(): Promise<DuplicateGroup[]> {
  const supabase = await createClient();
  const { data: flags } = await supabase
    .from("report_duplicate_flags")
    .select("report_id, possible_duplicate_of, relation_type, reason")
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
      relationType: (flag.relation_type as "duplicate" | "related" | undefined) ?? "duplicate",
      reason: flag.reason ?? null,
    });
  }
  return groups;
}

// ============================================================
// Phase 6E — Government Operations & Civic Performance Intelligence.
// All backed by supabase/migrations/0013_phase6e_government_intelligence.sql
// — same `security invoker` pattern as get_area_overview() above, so RLS
// jurisdiction/assignment scoping applies automatically with zero
// duplicated filtering logic here.
// ============================================================

export interface AgingBuckets {
  "0_1": number;
  "2_3": number;
  "4_7": number;
  "8_14": number;
  "15_30": number;
  "30_plus": number;
}

interface AgingBucketsRow {
  bucket_0_1: number;
  bucket_2_3: number;
  bucket_4_7: number;
  bucket_8_14: number;
  bucket_15_30: number;
  bucket_30_plus: number;
}

/** Real day buckets for currently-unresolved issues, computed in SQL from
 * `created_at` — boundaries mirrored (and unit-tested) in src/lib/aging.ts's
 * `agingBucketForDays`. Returns null only when the RPC itself is
 * unreachable (e.g. migration 0013 not yet applied) — the UI shows an
 * honest "not enough data" state rather than a fabricated zeroed chart. */
export async function getAgingBuckets(): Promise<AgingBuckets | null> {
  const supabase = await createClient();
  const { data: raw, error } = await supabase.rpc("get_aging_buckets").maybeSingle();
  if (error || !raw) {
    if (error) console.error("get_aging_buckets failed", error);
    return null;
  }
  const data = raw as unknown as AgingBucketsRow;
  return {
    "0_1": Number(data.bucket_0_1),
    "2_3": Number(data.bucket_2_3),
    "4_7": Number(data.bucket_4_7),
    "8_14": Number(data.bucket_8_14),
    "15_30": Number(data.bucket_15_30),
    "30_plus": Number(data.bucket_30_plus),
  };
}

export interface ResolutionQuality {
  resolved: number;
  citizenConfirmed: number;
  confirmationPending: number;
  currentlyReopened: number;
  reopenedTotalEver: number;
  reopenedPercentage: number;
}

interface ResolutionQualityRow {
  resolved: number;
  citizen_confirmed: number;
  confirmation_pending: number;
  currently_reopened: number;
  reopened_total_ever: number;
  reopened_percentage: number;
}

/** Phase 6D's resolution_feedback/reopened_at, aggregated — factual
 * operational counts only, never an interpretive "this department is bad"
 * conclusion (Phase 6E spec §7/§41). */
export async function getResolutionQuality(): Promise<ResolutionQuality | null> {
  const supabase = await createClient();
  const { data: raw, error } = await supabase.rpc("get_resolution_quality").maybeSingle();
  if (error || !raw) {
    if (error) console.error("get_resolution_quality failed", error);
    return null;
  }
  const data = raw as unknown as ResolutionQualityRow;
  return {
    resolved: Number(data.resolved),
    citizenConfirmed: Number(data.citizen_confirmed),
    confirmationPending: Number(data.confirmation_pending),
    currentlyReopened: Number(data.currently_reopened),
    reopenedTotalEver: Number(data.reopened_total_ever),
    reopenedPercentage: Number(data.reopened_percentage),
  };
}

export interface DepartmentWorkload {
  departmentId: string;
  name: string;
  activeIssues: number;
  currentlyReopened: number;
  awaitingAcknowledgement: number;
  inProgressOver7Days: number;
}

interface DepartmentWorkloadRow {
  department_id: string;
  name: string;
  active_issues: number;
  currently_reopened: number;
  awaiting_acknowledgement: number;
  in_progress_over_7_days: number;
}

/** Neutral operational workload facts per department — deliberately never
 * sorted/labeled as a ranking (no "Best"/"Worst"/"Top Performing", per
 * spec §8/§10/§41). */
export async function getDepartmentWorkload(): Promise<DepartmentWorkload[]> {
  const supabase = await createClient();
  const { data: raw, error } = await supabase.rpc("get_department_workload");
  if (error) {
    console.error("get_department_workload failed", error);
    return [];
  }
  const data = raw as unknown as DepartmentWorkloadRow[] | null;
  return (data ?? []).map((row) => ({
    departmentId: row.department_id,
    name: row.name,
    activeIssues: Number(row.active_issues),
    currentlyReopened: Number(row.currently_reopened),
    awaitingAcknowledgement: Number(row.awaiting_acknowledgement),
    inProgressOver7Days: Number(row.in_progress_over_7_days),
  }));
}

export interface DepartmentTrend {
  departmentId: string;
  name: string;
  received: number;
  resolved: number;
  reopened: number;
  active: number;
}

interface DepartmentTrendRow {
  department_id: string;
  name: string;
  received: number;
  resolved: number;
  reopened: number;
  active: number;
}

async function getDepartmentTrendForDays(days: number): Promise<DepartmentTrend[]> {
  const supabase = await createClient();
  const { data: raw, error } = await supabase.rpc("get_department_trend", { p_days: days });
  if (error) {
    console.error(`get_department_trend(${days}) failed`, error);
    return [];
  }
  const data = raw as unknown as DepartmentTrendRow[] | null;
  return (data ?? []).map((row) => ({
    departmentId: row.department_id,
    name: row.name,
    received: Number(row.received),
    resolved: Number(row.resolved),
    reopened: Number(row.reopened),
    active: Number(row.active),
  }));
}

export interface DepartmentTrendsByPeriod {
  7: DepartmentTrend[];
  30: DepartmentTrend[];
  90: DepartmentTrend[];
}

/** All three periods fetched together (three cheap indexed aggregate
 * calls) so a 7/30/90-day toggle in the UI is instant, client-side, with
 * no refetch and no "insufficient data" flicker. */
export async function getDepartmentTrends(): Promise<DepartmentTrendsByPeriod> {
  const [d7, d30, d90] = await Promise.all([
    getDepartmentTrendForDays(7),
    getDepartmentTrendForDays(30),
    getDepartmentTrendForDays(90),
  ]);
  return { 7: d7, 30: d30, 90: d90 };
}

export interface CategoryTrend {
  category: ProblemCategory;
  count: number;
}

export interface CategoryTrendsWithComparison {
  /** Per-category counts for the last `days` days — real database records
   * only, no predictive claims (spec §16); also fed to the AI snapshot.
   * null (distinct from a genuine empty array) when the RPC itself is
   * unreachable, so the UI never asserts "zero reports" when it doesn't
   * actually know. */
  current: CategoryTrend[] | null;
  /** Last `days` days vs the `days` before that; null when either RPC failed. */
  comparison: CategoryPeriodComparison[] | null;
}

/**
 * G8 — category counts for the last `days` days plus the previous `days`
 * days, from two calls of the existing get_category_trends() (0013): no new
 * SQL. previous = count(last 2×days) − count(last days); see
 * compareCategoryPeriods (src/lib/government-analytics.ts).
 */
export async function loadCategoryTrendsWithComparison(client: RpcClient, days: number): Promise<CategoryTrendsWithComparison> {
  const [currentRes, doubleRes] = await Promise.all([
    client.rpc("get_category_trends", { p_days: days }),
    client.rpc("get_category_trends", { p_days: days * 2 }),
  ]);
  if (currentRes.error) {
    console.error(`get_category_trends(${days}) failed`, currentRes.error);
    return { current: null, comparison: null };
  }
  const currentRows = (currentRes.data as unknown as CategoryCountRow[] | null) ?? [];
  const current = currentRows.map((row) => ({
    category: categoryFromDb[row.category] ?? (row.category as ProblemCategory),
    count: Number(row.report_count),
  }));
  if (doubleRes.error) {
    console.error(`get_category_trends(${days * 2}) failed`, doubleRes.error);
    return { current, comparison: null };
  }
  const doubleRows = (doubleRes.data as unknown as CategoryCountRow[] | null) ?? [];
  return { current, comparison: compareCategoryPeriods(currentRows, doubleRows) };
}

export async function getCategoryTrendsWithComparison(days = 30): Promise<CategoryTrendsWithComparison> {
  return loadCategoryTrendsWithComparison(await createClient(), days);
}

/**
 * G8 — per-location issue counts from get_area_breakdown()
 * (supabase/migrations/0018_g8_area_breakdown.sql): security invoker, so the
 * caller's own reports_select / report_locations_select RLS decides which
 * reports are counted at all. Returns null (never zeros) when the RPC is
 * unreachable — e.g. before migration 0018 is applied — so the UI says
 * "unavailable" instead of asserting there are no issues.
 */
export async function loadAreaBreakdown(client: RpcClient): Promise<AreaBreakdownRow[] | null> {
  const { data, error } = await client.rpc("get_area_breakdown");
  if (error) {
    console.error("get_area_breakdown failed", error);
    return null;
  }
  return mapAreaBreakdownRows((data as unknown as AreaBreakdownRowRaw[] | null) ?? []);
}

export async function getAreaBreakdown(): Promise<AreaBreakdownRow[] | null> {
  return loadAreaBreakdown(await createClient());
}

// Phase 6E's getNeedsAttention()/getActionCenterCounts() were superseded by
// the G5 Action Required command center (src/lib/data/action-required.ts),
// which covers every group/count they did from one consistent candidate set.
