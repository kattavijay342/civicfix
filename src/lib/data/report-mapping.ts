import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { categoryFromDb, priorityFromDb, statusFromDb } from "@/lib/db-enums";
import type { CivicIssue } from "@/lib/types";

function daysBetween(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24)));
}

/**
 * Batch-loads locations/assignments/departments/media/follow-ups for a set
 * of report rows and maps them into the existing CivicIssue shape, so
 * Phase 1 components (IssueCard, JurisdictionExplorer, SortablePendingIssues,
 * MapPreview, ...) render real data unchanged.
 *
 * `readClient` is used for ordinary table reads (RLS applies — callers pass
 * whatever set of reports RLS already scoped for them). `admin` is used
 * only to sign private Storage URLs for media belonging to those same
 * already-authorized reports.
 */
export async function mapReportsToIssues(
  readClient: SupabaseClient,
  admin: SupabaseClient,
  reports: Array<{
    id: string;
    title: string;
    category: string;
    status: string;
    priority: string | null;
    created_at: string;
    description: string;
  }>
): Promise<CivicIssue[]> {
  if (reports.length === 0) return [];
  const ids = reports.map((r) => r.id);

  const [{ data: locations }, { data: assignments }, { data: departments }, { data: media }, { data: followUps }] =
    await Promise.all([
      readClient.from("report_locations").select("*").in("report_id", ids),
      readClient.from("report_assignments").select("report_id, department_id").in("report_id", ids),
      readClient.from("departments").select("id, name"),
      readClient.from("report_media").select("report_id, id, file_path").eq("kind", "evidence").in("report_id", ids),
      readClient
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
