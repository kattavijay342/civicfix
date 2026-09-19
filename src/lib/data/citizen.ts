import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { categoryFromDb, priorityFromDb, statusFromDb } from "@/lib/db-enums";
import { categoryLabels } from "@/lib/categories";
import type { CivicIssue, ProblemCategory } from "@/lib/types";

function daysBetween(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24)));
}

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

  if (!reports || reports.length === 0) return [];

  const ids = reports.map((r) => r.id);
  const admin = createAdminClient();

  const [{ data: locations }, { data: assignments }, { data: departments }, { data: media }, { data: followUps }] =
    await Promise.all([
      supabase.from("report_locations").select("*").in("report_id", ids),
      supabase.from("report_assignments").select("report_id, department_id").in("report_id", ids),
      supabase.from("departments").select("id, name"),
      supabase.from("report_media").select("report_id, id, file_path").eq("kind", "evidence").in("report_id", ids),
      supabase
        .from("follow_ups")
        .select("report_id, follow_up_date, next_follow_up_date")
        .in("report_id", ids)
        .order("follow_up_date", { ascending: false }),
    ]);

  const locationByReport = new Map((locations ?? []).map((l) => [l.report_id, l]));
  const departmentNameById = new Map((departments ?? []).map((d) => [d.id, d.name]));
  const departmentByReport = new Map(
    (assignments ?? []).map((a) => [a.report_id, departmentNameById.get(a.department_id) ?? "Unassigned"])
  );
  const followUpCountByReport = new Map<string, number>();
  const lastFollowUpByReport = new Map<string, string>();
  const nextFollowUpByReport = new Map<string, string>();
  for (const f of followUps ?? []) {
    followUpCountByReport.set(f.report_id, (followUpCountByReport.get(f.report_id) ?? 0) + 1);
    if (!lastFollowUpByReport.has(f.report_id)) {
      lastFollowUpByReport.set(f.report_id, new Date(f.follow_up_date).toLocaleDateString());
    }
    if (f.next_follow_up_date && !nextFollowUpByReport.has(f.report_id)) {
      nextFollowUpByReport.set(f.report_id, new Date(f.next_follow_up_date).toLocaleDateString());
    }
  }

  const firstMediaByReport = new Map<string, string>();
  for (const m of media ?? []) {
    if (!firstMediaByReport.has(m.report_id)) firstMediaByReport.set(m.report_id, m.file_path);
  }
  const imageUrlByReport = new Map<string, string>();
  await Promise.all(
    [...firstMediaByReport.entries()].map(async ([reportId, path]) => {
      const { data } = await admin.storage.from("report-media").createSignedUrl(path, 3600);
      if (data?.signedUrl) imageUrlByReport.set(reportId, data.signedUrl);
    })
  );

  return reports.map((r) => {
    const loc = locationByReport.get(r.id);
    return {
      id: r.id,
      title: r.title,
      category: categoryFromDb[r.category],
      location: loc
        ? {
            displayName: loc.display_name,
            state: loc.state ?? undefined,
            district: loc.district ?? undefined,
            constituency: loc.constituency ?? undefined,
            area: loc.area ?? loc.ward ?? undefined,
            landmark: loc.landmark ?? undefined,
            latitude: loc.latitude,
            longitude: loc.longitude,
            source: loc.location_source,
          }
        : { displayName: "Location not recorded", source: "manual" },
      priority: r.priority ? priorityFromDb[r.priority] : "LOW",
      status: statusFromDb[r.status],
      reportedDate: r.created_at,
      department: departmentByReport.get(r.id) ?? "Not yet routed",
      imageUrl: imageUrlByReport.get(r.id),
      daysPending: r.status === "resolved" ? 0 : daysBetween(r.created_at),
      followUps: followUpCountByReport.get(r.id) ?? 0,
      lastFollowUp: lastFollowUpByReport.get(r.id),
      nextFollowUp: nextFollowUpByReport.get(r.id),
      description: r.description,
    };
  });
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
