import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { categoryFromDb, priorityFromDb, statusFromDb } from "@/lib/db-enums";
import type { CivicLocation, IssueStatus, Priority, ProblemCategory } from "@/lib/types";

export interface ReportMedia {
  id: string;
  kind: "evidence" | "before" | "after";
  url: string | null;
  mimeType: string | null;
}

export interface ReportAiAnalysis {
  problemSummary: string;
  category: ProblemCategory;
  severity: Priority;
  priority: Priority;
  reasoning: string;
  recommendedDepartment: string;
  recommendedAction: string;
  confidence: number;
  model: string;
}

export interface ReportAssignment {
  departmentName: string;
  inchargeName: string | null;
  inchargeId: string | null;
}

export interface FollowUpEntry {
  id: string;
  notes: string;
  followUpDate: string;
  nextFollowUpDate: string | null;
  status: "pending" | "done";
  authorName: string | null;
}

export interface StatusHistoryEntry {
  oldStatus: IssueStatus | null;
  newStatus: IssueStatus;
  notes: string | null;
  createdAt: string;
}

export interface ResolutionEvidenceEntry {
  beforeUrl: string | null;
  afterUrl: string | null;
  notes: string;
  resolvedAt: string;
}

export interface ReportDetail {
  id: string;
  title: string;
  description: string;
  category: ProblemCategory;
  status: IssueStatus;
  priority: Priority | null;
  severity: Priority | null;
  createdAt: string;
  updatedAt: string;
  reporterId: string;
  location: CivicLocation;
  media: ReportMedia[];
  aiAnalysis: ReportAiAnalysis | null;
  assignment: ReportAssignment | null;
  followUps: FollowUpEntry[];
  statusHistory: StatusHistoryEntry[];
  resolutionEvidence: ResolutionEvidenceEntry | null;
  duplicateOf: { id: string; title: string } | null;
}

function toCivicLocation(row: {
  display_name: string;
  state: string | null;
  district: string | null;
  constituency: string | null;
  area: string | null;
  village: string | null;
  ward: string | null;
  municipality: string | null;
  landmark: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  location_source: string;
}): CivicLocation {
  return {
    displayName: row.display_name,
    state: row.state ?? undefined,
    district: row.district ?? undefined,
    constituency: row.constituency ?? undefined,
    village: row.village ?? undefined,
    municipality: row.municipality ?? undefined,
    area: row.area ?? row.ward ?? undefined,
    landmark: row.landmark ?? undefined,
    address: row.address ?? undefined,
    latitude: row.latitude,
    longitude: row.longitude,
    source: (row.location_source as CivicLocation["source"]) ?? "manual",
  };
}

/**
 * Loads everything a report detail view needs. Uses the caller's own
 * session (RLS-enforced) for the existence/visibility check, then the
 * admin client only to sign private Storage URLs for media that belongs to
 * a report we already confirmed the caller may see.
 */
export async function getReportDetail(reportId: string): Promise<ReportDetail | null> {
  const supabase = await createClient();
  const { data: report } = await supabase.from("reports").select("*").eq("id", reportId).maybeSingle();
  if (!report) return null;

  const admin = createAdminClient();

  const [locationRes, mediaRes, aiRes, assignmentRes, followUpsRes, historyRes, resolutionRes, duplicateRes] =
    await Promise.all([
      admin.from("report_locations").select("*").eq("report_id", reportId).maybeSingle(),
      admin.from("report_media").select("*").eq("report_id", reportId),
      admin.from("ai_analyses").select("*").eq("report_id", reportId).maybeSingle(),
      admin.from("report_assignments").select("*").eq("report_id", reportId).maybeSingle(),
      admin.from("follow_ups").select("*").eq("report_id", reportId).order("follow_up_date", { ascending: false }),
      admin.from("status_history").select("*").eq("report_id", reportId).order("created_at", { ascending: true }),
      admin.from("resolution_evidence").select("*").eq("report_id", reportId).maybeSingle(),
      admin.from("report_duplicate_flags").select("possible_duplicate_of").eq("report_id", reportId).maybeSingle(),
    ]);

  const location: CivicLocation = locationRes.data
    ? toCivicLocation(locationRes.data)
    : { displayName: "Location not recorded", source: "manual" };

  const media: ReportMedia[] = [];
  for (const m of mediaRes.data ?? []) {
    const { data: signed } = await admin.storage.from("report-media").createSignedUrl(m.file_path, 3600);
    media.push({ id: m.id, kind: m.kind, url: signed?.signedUrl ?? null, mimeType: m.mime_type });
  }

  let assignment: ReportAssignment | null = null;
  if (assignmentRes.data) {
    const { data: department } = await admin
      .from("departments")
      .select("name")
      .eq("id", assignmentRes.data.department_id)
      .maybeSingle();
    let inchargeName: string | null = null;
    if (assignmentRes.data.incharge_id) {
      const { data: incharge } = await admin
        .from("profiles")
        .select("full_name")
        .eq("id", assignmentRes.data.incharge_id)
        .maybeSingle();
      inchargeName = incharge?.full_name ?? "Authorized Government User";
    }
    assignment = {
      departmentName: department?.name ?? "Unassigned",
      inchargeName,
      inchargeId: assignmentRes.data.incharge_id,
    };
  }

  const followUpAuthorIds = [...new Set((followUpsRes.data ?? []).map((f) => f.government_user_id))];
  const authorNameById = new Map<string, string | null>();
  if (followUpAuthorIds.length > 0) {
    const { data: authors } = await admin.from("profiles").select("id, full_name").in("id", followUpAuthorIds);
    for (const a of authors ?? []) authorNameById.set(a.id, a.full_name);
  }

  let duplicateOf: { id: string; title: string } | null = null;
  if (duplicateRes.data?.possible_duplicate_of) {
    const { data: dup } = await admin
      .from("reports")
      .select("id, title")
      .eq("id", duplicateRes.data.possible_duplicate_of)
      .maybeSingle();
    if (dup) duplicateOf = dup;
  }

  let resolutionEvidence: ResolutionEvidenceEntry | null = null;
  if (resolutionRes.data) {
    const beforeUrl = resolutionRes.data.before_media_id
      ? media.find((m) => m.id === resolutionRes.data.before_media_id)?.url ?? null
      : null;
    const afterUrl = resolutionRes.data.after_media_id
      ? media.find((m) => m.id === resolutionRes.data.after_media_id)?.url ?? null
      : null;
    resolutionEvidence = {
      beforeUrl,
      afterUrl,
      notes: resolutionRes.data.resolution_notes,
      resolvedAt: resolutionRes.data.resolved_at,
    };
  }

  return {
    id: report.id,
    title: report.title,
    description: report.description,
    category: categoryFromDb[report.category],
    status: statusFromDb[report.status],
    priority: report.priority ? priorityFromDb[report.priority] : null,
    severity: report.severity ? priorityFromDb[report.severity] : null,
    createdAt: report.created_at,
    updatedAt: report.updated_at,
    reporterId: report.reporter_id,
    location,
    media,
    aiAnalysis: aiRes.data
      ? {
          problemSummary: aiRes.data.problem_summary,
          category: categoryFromDb[aiRes.data.category],
          severity: priorityFromDb[aiRes.data.severity],
          priority: priorityFromDb[aiRes.data.priority],
          reasoning: aiRes.data.reasoning,
          recommendedDepartment: aiRes.data.recommended_department,
          recommendedAction: aiRes.data.recommended_action,
          confidence: Number(aiRes.data.confidence),
          model: aiRes.data.model,
        }
      : null,
    assignment,
    followUps: (followUpsRes.data ?? []).map((f) => ({
      id: f.id,
      notes: f.notes,
      followUpDate: f.follow_up_date,
      nextFollowUpDate: f.next_follow_up_date,
      status: f.status,
      authorName: authorNameById.get(f.government_user_id) ?? null,
    })),
    statusHistory: (historyRes.data ?? []).map((h) => ({
      oldStatus: h.old_status ? statusFromDb[h.old_status] : null,
      newStatus: statusFromDb[h.new_status],
      notes: h.notes,
      createdAt: h.created_at,
    })),
    resolutionEvidence,
    duplicateOf,
  };
}
