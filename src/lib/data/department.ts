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
import type { CivicIssue, IssueListFilters, PagedIssues } from "@/lib/types";

/** Reports assigned to the calling department in-charge. RLS
 * (report_assigned_to_me) restricts `reports` to rows where this user is
 * the assignment's incharge_id. */
export async function getAssignedIssues(userId: string): Promise<CivicIssue[]> {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: assignments } = await admin
    .from("report_assignments")
    .select("report_id")
    .eq("incharge_id", userId);

  const reportIds = (assignments ?? []).map((a) => a.report_id);
  if (reportIds.length === 0) return [];

  const { data: reports } = await supabase
    .from("reports")
    .select("id, title, category, status, priority, created_at, description")
    .in("id", reportIds)
    .order("created_at", { ascending: false })
    .limit(200);

  return mapReportsToIssues(supabase, admin, reports ?? []);
}

/**
 * Real server-side pagination (Phase 4 Step 7) for the "Assigned Reports"
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

  const { data: assignments } = await admin
    .from("report_assignments")
    .select("report_id")
    .eq("incharge_id", userId);
  const reportIds = (assignments ?? []).map((a) => a.report_id);

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

export interface AssignedIssueStats {
  assigned: number;
  inProgress: number;
  resolved: number;
}

/** Cheap COUNT-only queries for the dashboard header stats — avoids pulling
 * full report/location/media rows just to count them (Phase 4 Step 8). */
export async function getAssignedIssueStats(userId: string): Promise<AssignedIssueStats> {
  const admin = createAdminClient();
  const { data: assignments } = await admin.from("report_assignments").select("report_id").eq("incharge_id", userId);
  const reportIds = (assignments ?? []).map((a) => a.report_id);
  if (reportIds.length === 0) return { assigned: 0, inProgress: 0, resolved: 0 };

  const [{ count: inProgress }, { count: resolved }] = await Promise.all([
    admin
      .from("reports")
      .select("*", { count: "exact", head: true })
      .in("id", reportIds)
      .in("status", ["in_progress", "acknowledged"]),
    admin.from("reports").select("*", { count: "exact", head: true }).in("id", reportIds).eq("status", "resolved"),
  ]);

  return { assigned: reportIds.length, inProgress: inProgress ?? 0, resolved: resolved ?? 0 };
}
