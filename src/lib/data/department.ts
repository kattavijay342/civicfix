import "server-only";
import { cache } from "react";
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
import { getEffectiveAssignments } from "@/lib/data/incharge-access";
import { loadDepartmentFollowUps, type DepartmentFollowUpItem } from "@/lib/data/reminders";
import type { CivicIssue, IssueListFilters, PagedIssues } from "@/lib/types";

/**
 * Report ids this in-charge is effectively assigned (G4): the assignment
 * names them AND they still qualify for it — see
 * src/lib/incharge-access.ts. RLS (report_assigned_to_me) then still
 * scopes the `reports` read itself to the caller's own assignments.
 */
// Memoized per request: the dashboard's stats, list and "recently
// assigned" strip all need the same set.
const effectiveAssignmentsFor = cache((userId: string) => getEffectiveAssignments(createAdminClient(), userId));

async function effectiveReportIds(userId: string): Promise<string[]> {
  return (await effectiveAssignmentsFor(userId)).map((a) => a.reportId);
}

/** Reports effectively assigned to the calling department in-charge. */
export async function getAssignedIssues(userId: string): Promise<CivicIssue[]> {
  const supabase = await createClient();
  const admin = createAdminClient();
  const reportIds = await effectiveReportIds(userId);
  if (reportIds.length === 0) return [];

  const { data: reports } = await supabase
    .from("reports")
    .select(ISSUE_LIST_SELECT)
    .in("id", reportIds)
    .order("created_at", { ascending: false })
    .limit(200);

  return mapReportsToIssues(supabase, admin, reports ?? []);
}

/**
 * Real server-side pagination (Phase 4 Step 7) for the "My Assigned Issues"
 * list — replaces loading up to 200 full report rows at once.
 */
export async function getAssignedIssuesPage(
  userId: string,
  page: number,
  filters?: IssueListFilters
): Promise<PagedIssues> {
  const supabase = await createClient();
  const admin = createAdminClient();
  const currentPage = clampPage(page);
  const reportIds = await effectiveReportIds(userId);

  if (reportIds.length === 0) {
    return { items: [], page: 1, pageSize: ISSUE_LIST_PAGE_SIZE, totalCount: 0, totalPages: 1 };
  }

  const from = (currentPage - 1) * ISSUE_LIST_PAGE_SIZE;
  const to = from + ISSUE_LIST_PAGE_SIZE - 1;

  let query = supabase
    .from("reports")
    .select(ISSUE_LIST_SELECT, { count: "exact" })
    .in("id", reportIds);
  query = applyIssueFilters(query, filters);

  const { data: reports, count } = await query.order("created_at", { ascending: false }).range(from, to);

  return toPagedIssues(supabase, admin, reports ?? [], count ?? 0, currentPage, ISSUE_LIST_PAGE_SIZE);
}

/** The most recently ROUTED-to-me reports (by report_assignments.assigned_at,
 * not report creation), for the dashboard's "Recently assigned" strip. */
export async function getRecentlyAssignedIssues(userId: string, limit = 5): Promise<CivicIssue[]> {
  const supabase = await createClient();
  const admin = createAdminClient();
  const recent = (await effectiveAssignmentsFor(userId)).slice(0, limit);
  if (recent.length === 0) return [];

  const { data: reports } = await supabase
    .from("reports")
    .select(ISSUE_LIST_SELECT)
    .in(
      "id",
      recent.map((a) => a.reportId)
    );
  const issues = await mapReportsToIssues(supabase, admin, reports ?? []);
  const order = new Map(recent.map((a, i) => [a.reportId, i]));
  return issues.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export interface AssignedIssueStats {
  assigned: number;
  /** Routed or reopened — waiting for this in-charge to acknowledge. */
  awaitingAcknowledgement: number;
  acknowledged: number;
  inProgress: number;
  resolved: number;
  /** Not yet resolved AND high/critical priority. */
  urgentOpen: number;
}

const EMPTY_STATS: AssignedIssueStats = {
  assigned: 0,
  awaitingAcknowledgement: 0,
  acknowledged: 0,
  inProgress: 0,
  resolved: 0,
  urgentOpen: 0,
};

/** Counts from one narrow status/priority read over this in-charge's
 * effective assignments — never a full report/location/media load just to
 * count (Phase 4 Step 8), and never an invented metric. */
export async function getAssignedIssueStats(userId: string): Promise<AssignedIssueStats> {
  const admin = createAdminClient();
  const reportIds = await effectiveReportIds(userId);
  if (reportIds.length === 0) return EMPTY_STATS;

  const { data: rows } = await admin.from("reports").select("status, priority").in("id", reportIds);
  const stats = { ...EMPTY_STATS, assigned: reportIds.length };
  for (const r of rows ?? []) {
    if (r.status === "routed" || r.status === "reopened") stats.awaitingAcknowledgement += 1;
    else if (r.status === "acknowledged") stats.acknowledged += 1;
    else if (r.status === "in_progress") stats.inProgress += 1;
    else if (r.status === "resolved") stats.resolved += 1;
    if (r.status !== "resolved" && (r.priority === "high" || r.priority === "critical")) stats.urgentOpen += 1;
  }
  return stats;
}

/** G6 — delivered government follow-ups addressed to this in-charge, only
 * on reports they are still effectively assigned (see
 * loadDepartmentFollowUps for the query-level restriction). */
export async function getDepartmentFollowUps(userId: string): Promise<DepartmentFollowUpItem[]> {
  const supabase = await createClient();
  return loadDepartmentFollowUps(supabase, createAdminClient(), userId, await effectiveReportIds(userId));
}
