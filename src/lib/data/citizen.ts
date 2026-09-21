import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { categoryLabels } from "@/lib/categories";
import {
  mapReportsToIssues,
  applyIssueFilters,
  toPagedIssues,
  clampPage,
  ISSUE_LIST_SELECT,
  ISSUE_LIST_PAGE_SIZE,
} from "@/lib/data/report-mapping";
import type { CivicIssue, IssueListFilters, PagedIssues, ProblemCategory } from "@/lib/types";

/** All of a citizen's own reports, mapped into the existing CivicIssue
 * shape so Phase 1's IssueCard / DonutChart / DashboardStat components can
 * render real data unchanged. RLS on `reports` already restricts this to
 * the caller's own rows even without the .eq() filter below — it's kept
 * explicit for clarity and as defense in depth. */
export async function getCitizenIssues(userId: string): Promise<CivicIssue[]> {
  const supabase = await createClient();
  const { data: reports } = await supabase
    .from("reports")
    .select("id, title, category, status, priority, created_at, description")
    .eq("reporter_id", userId)
    .order("created_at", { ascending: false })
    .limit(200);

  return mapReportsToIssues(supabase, createAdminClient(), reports ?? []);
}

/**
 * Real server-side pagination (Phase 4 Step 7) for the "My Reports" list —
 * replaces loading up to 200 full report rows into the browser at once.
 * `.range()` + `{ count: "exact" }` push both the windowing and the total
 * count into Postgres; RLS still restricts this to the caller's own rows.
 */
export async function getCitizenIssuesPage(
  userId: string,
  page: number,
  filters?: IssueListFilters
): Promise<PagedIssues> {
  const supabase = await createClient();
  const currentPage = clampPage(page);
  const from = (currentPage - 1) * ISSUE_LIST_PAGE_SIZE;
  const to = from + ISSUE_LIST_PAGE_SIZE - 1;

  let query = supabase
    .from("reports")
    .select(ISSUE_LIST_SELECT, { count: "exact" })
    .eq("reporter_id", userId);
  query = applyIssueFilters(query, filters);

  const { data: reports, count } = await query.order("created_at", { ascending: false }).range(from, to);

  return toPagedIssues(supabase, createAdminClient(), reports ?? [], count ?? 0, currentPage, ISSUE_LIST_PAGE_SIZE);
}

export interface CitizenOverview {
  totalReports: number;
  highPriority: number;
  inProgress: number;
  resolved: number;
  pending: number;
}

export function summarizeCitizenIssues(issues: CivicIssue[]): CitizenOverview {
  return {
    totalReports: issues.length,
    highPriority: issues.filter((i) => i.priority === "HIGH" || i.priority === "CRITICAL").length,
    inProgress: issues.filter((i) => i.status === "IN_PROGRESS").length,
    resolved: issues.filter((i) => i.status === "RESOLVED").length,
    pending: issues.filter((i) => i.status !== "RESOLVED").length,
  };
}

export function reportsByCategoryFrom(issues: CivicIssue[]) {
  const counts = new Map<ProblemCategory, number>();
  for (const i of issues) counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
  return [...counts.entries()].map(([category, count]) => ({
    category,
    label: categoryLabels[category],
    count,
  }));
}
