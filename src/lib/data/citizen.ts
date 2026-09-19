import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { categoryLabels } from "@/lib/categories";
import { mapReportsToIssues } from "@/lib/data/report-mapping";
import type { CivicIssue, ProblemCategory } from "@/lib/types";

/** All of a citizen's own reports, mapped into the existing CivicIssue
 * shape so Phase 1's IssueCard / DonutChart / DashboardStat components can
 * render real data unchanged. RLS on `reports` already restricts this to
 * the caller's own rows even without the .eq() filter below — it's kept
 * explicit for clarity and as defense in depth. */
export async function getCitizenIssues(userId: string): Promise<CivicIssue[]> {
  const supabase = await createClient();
  const { data: reports } = await supabase
    .from("reports")
    .select("*")
    .eq("reporter_id", userId)
    .order("created_at", { ascending: false });

  return mapReportsToIssues(supabase, createAdminClient(), reports ?? []);
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
