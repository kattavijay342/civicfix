import "server-only";
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
  pending: number;
  critical: number;
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
export async function getAreaOverview(): Promise<AreaOverview> {
  const supabase = await createClient();
  const { data: raw, error } = await supabase.rpc("get_area_overview").maybeSingle();
  const data = raw as unknown as AreaOverviewRow | null;

  if (error || !data) {
    console.error("get_area_overview failed", error);
    return { totalIssues: 0, resolved: 0, pending: 0, critical: 0, resolutionRate: 0 };
  }

  return {
    totalIssues: Number(data.total_issues),
    resolved: Number(data.resolved),
    pending: Number(data.pending),
    critical: Number(data.critical),
    resolutionRate: Number(data.resolution_rate),
  };
}

/**
 * Backed by get_department_performance() (same migration as above) instead
 * of pulling every visible report + assignment + resolution row into Node.
 */
export async function getDepartmentPerformance(): Promise<DepartmentPerformance[]> {
  const supabase = await createClient();
  const { data: raw, error } = await supabase.rpc("get_department_performance");
  const data = raw as unknown as DepartmentPerformanceRow[] | null;

  if (error) {
    console.error("get_department_performance failed", error);
    return [];
  }

  return (data ?? []).map((row) => ({
    name: row.name,
    resolutionRate: Number(row.resolution_rate),
    totalIssues: Number(row.total_issues),
    resolvedIssues: Number(row.resolved_issues),
    pendingIssues: Number(row.pending_issues),
    // Phase 6E — no real SLA/due date exists anywhere in this product
    // (see the AreaOverviewRow/DepartmentPerformanceRow comment above);
    // null tells every UI consumer to render the honest "no configured
    // SLA" state instead of a fabricated compliance percentage.
    onTimeRate: null,
    avgResolutionDays: Number(row.avg_resolution_days),
    // Period-over-period change isn't tracked yet — a real trend needs a
    // second, comparable time window's worth of the same aggregate, which
    // is a larger addition than this pass's scope. Left at 0 (as before)
    // rather than fabricated.
    trend: 0,
  }));
}

/** Deterministic, real-data-derived insights (Step 16). No LLM call here —
 * these are computed directly from stored reports so they're always exactly
 * as accurate as the underlying data, with zero added latency/cost.
 * Backed by get_insight_metrics() (Phase 4 Step 8) for the actual counting
 * — only the human-readable copy/tone is composed here. */
export async function getAIInsights(): Promise<AIInsight[]> {
  const supabase = await createClient();
  const [metricsRes, concentrationRes] = await Promise.all([
    supabase.rpc("get_insight_metrics").maybeSingle(),
    supabase.rpc("get_area_concentration").maybeSingle(),
  ]);
  const metrics = metricsRes.data as unknown as InsightMetricsRow | null;
  const concentration = concentrationRes.data as unknown as AreaConcentrationRow | null;
  if (concentrationRes.error) {
    // Independent of get_insight_metrics — a failure here (e.g. migration
    // 0009 not applied yet) never removes the four existing insights below.
    console.error("get_area_concentration failed", concentrationRes.error);
  }

  const insights: AIInsight[] = [];
  if (metricsRes.error || !metrics || Number(metrics.total_reports) === 0) return insights;

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

interface CategoryTrendRow {
  category: string;
  report_count: number;
}

/** Per-category report counts within a trailing window (default 30 days) —
 * real database records only, no predictive claims (spec §16). Returns
 * null (distinct from a genuine empty array) when the RPC itself is
 * unreachable, so the UI can tell "no data available" apart from "zero
 * reports in this period" instead of asserting the latter when it doesn't
 * actually know. */
export async function getCategoryTrends(days = 30): Promise<CategoryTrend[] | null> {
  const supabase = await createClient();
  const { data: raw, error } = await supabase.rpc("get_category_trends", { p_days: days });
  if (error) {
    console.error("get_category_trends failed", error);
    return null;
  }
  const data = raw as unknown as CategoryTrendRow[] | null;
  return (data ?? []).map((row) => ({
    category: categoryFromDb[row.category] ?? (row.category as ProblemCategory),
    count: Number(row.report_count),
  }));
}

const ATTENTION_LIMIT = 5;

export interface NeedsAttention {
  criticalUnresolved: CivicIssue[];
  highPriorityUnresolved: CivicIssue[];
  longPending: CivicIssue[];
  /** Also covers "citizen reports unresolved" — Phase 6D's
   * submitResolutionFeedback always flips a report to `reopened` the
   * moment a citizen says "no," so these are the same real event today,
   * not two independent facts (see the Phase 6E plan's design decision on
   * this exact point). Presented as one honest group, not a fabricated
   * second bucket. */
  reopened: CivicIssue[];
}

/** Small, bounded, already-RLS-scoped queries (LIMIT 5 each, run in
 * parallel) rather than one heavyweight SQL function — matches this
 * codebase's existing convention for "a handful of flagged rows" reads
 * (e.g. report_duplicate_flags). */
export async function getNeedsAttention(): Promise<NeedsAttention> {
  const supabase = await createClient();
  const admin = createAdminClient();
  const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();

  const [criticalRes, highRes, longPendingRes, reopenedRes] = await Promise.all([
    supabase
      .from("reports")
      .select(ISSUE_LIST_SELECT)
      .eq("priority", "critical")
      .neq("status", "resolved")
      .order("created_at", { ascending: true })
      .limit(ATTENTION_LIMIT),
    supabase
      .from("reports")
      .select(ISSUE_LIST_SELECT)
      .eq("priority", "high")
      .neq("status", "resolved")
      .order("created_at", { ascending: true })
      .limit(ATTENTION_LIMIT),
    supabase
      .from("reports")
      .select(ISSUE_LIST_SELECT)
      .neq("status", "resolved")
      .lt("created_at", fifteenDaysAgo)
      .order("created_at", { ascending: true })
      .limit(ATTENTION_LIMIT),
    supabase
      .from("reports")
      .select(ISSUE_LIST_SELECT)
      .eq("status", "reopened")
      .order("created_at", { ascending: false })
      .limit(ATTENTION_LIMIT),
  ]);

  const [criticalUnresolved, highPriorityUnresolved, longPending, reopened] = await Promise.all([
    mapReportsToIssues(supabase, admin, criticalRes.data ?? []),
    mapReportsToIssues(supabase, admin, highRes.data ?? []),
    mapReportsToIssues(supabase, admin, longPendingRes.data ?? []),
    mapReportsToIssues(supabase, admin, reopenedRes.data ?? []),
  ]);

  return { criticalUnresolved, highPriorityUnresolved, longPending, reopened };
}

/** Real UTC bounds for "today" in IST (fixed UTC+5:30, no DST) — same
 * calendar-day convention already used for notification grouping
 * (src/app/notifications/page.tsx's groupByDay). */
function istTodayBoundsUtc(): { start: string; end: string } {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  const startMs = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()) - IST_OFFSET_MS;
  return { start: new Date(startMs).toISOString(), end: new Date(startMs + 24 * 60 * 60 * 1000).toISOString() };
}

export interface ActionCenterCounts {
  critical: number;
  followUpDueToday: number;
  reopened: number;
  awaitingAcknowledgement: number;
}

/** "Today's Attention" — cheap, count-only queries (head: true, no rows
 * transferred) for the Government Action Center panel. Every count links
 * to a real filtered issue list; nothing here auto-executes an action. */
export async function getActionCenterCounts(): Promise<ActionCenterCounts> {
  const supabase = await createClient();
  const { start, end } = istTodayBoundsUtc();

  const [criticalRes, reopenedRes, awaitingAckRes, followUpRes] = await Promise.all([
    supabase.from("reports").select("*", { count: "exact", head: true }).eq("priority", "critical").neq("status", "resolved"),
    supabase.from("reports").select("*", { count: "exact", head: true }).eq("status", "reopened"),
    supabase.from("reports").select("*", { count: "exact", head: true }).eq("status", "routed"),
    supabase
      .from("reminders")
      .select("*", { count: "exact", head: true })
      .eq("status", "scheduled")
      .gte("scheduled_at", start)
      .lt("scheduled_at", end),
  ]);

  return {
    critical: criticalRes.count ?? 0,
    reopened: reopenedRes.count ?? 0,
    awaitingAcknowledgement: awaitingAckRes.count ?? 0,
    followUpDueToday: followUpRes.count ?? 0,
  };
}
