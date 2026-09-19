import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { mapReportsToIssues } from "@/lib/data/report-mapping";
import type { CivicIssue } from "@/lib/types";

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
    .select("*")
    .in("id", reportIds)
    .order("created_at", { ascending: false });

  return mapReportsToIssues(supabase, admin, reports ?? []);
}
