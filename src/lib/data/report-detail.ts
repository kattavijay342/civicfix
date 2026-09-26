import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { categoryFromDb, priorityFromDb, statusFromDb } from "@/lib/db-enums";
import { aiAnalysisExtendedSchema, type AIAnalysisExtended } from "@/lib/ai";
import type { CivicLocation, IssueStatus, Priority, ProblemCategory } from "@/lib/types";
import type { DuplicateRelationType } from "@/lib/duplicate-detection";

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
  /** Phase 6A extras — null for reports analyzed before this migration, or
   * if the stored JSON somehow fails re-validation (never trust it blindly
   * even though it was written by our own Zod-validated insert). */
  extended: AIAnalysisExtended | null;
}

export interface ReportAssignment {
  departmentName: string;
  inchargeName: string | null;
  inchargeId: string | null;
  assignedAt: string;
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
  /** Who made this transition — null for system-driven transitions
   * (AI_ANALYZED/ROUTED, logged with changed_by: null in reports.ts).
   * Compare against reporterId to label an event "You" vs "Department"
   * (see RealStatusTimeline) — never resolved to a name here, so a citizen
   * viewing their own report never sees another user's identity. */
  changedBy: string | null;
}

export interface ResolutionEvidenceEntry {
  beforeUrl: string | null;
  afterUrl: string | null;
  notes: string;
  resolvedAt: string;
}

/** Phase 6D — the original reporter's own confirmation signal on a
 * resolution. A citizen-reported signal only, never an official government
 * verification (see src/lib/citizen-summary.ts). */
export interface ResolutionFeedbackEntry {
  confirmed: boolean;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
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
  duplicateOf: {
    id: string;
    title: string;
    category: ProblemCategory;
    status: IssueStatus;
    location: CivicLocation;
    relationType: DuplicateRelationType;
    reason: string | null;
  } | null;
  resolutionFeedback: ResolutionFeedbackEntry | null;
  reopenedAt: string | null;
}

/** Re-validates the stored `extended` JSONB against the same Zod schema
 * used on write (src/lib/ai.ts) — defends against a row written before this
 * schema existed (null), a hand-edited row, or a future schema change. */
function parseExtended(raw: unknown): AIAnalysisExtended | null {
  if (!raw) return null;
  const result = aiAnalysisExtendedSchema.safeParse(raw);
  return result.success ? result.data : null;
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
  accuracy_meters?: number | null;
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
    accuracy: row.accuracy_meters ?? null,
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

  const [locationRes, mediaRes, aiRes, assignmentRes, followUpsRes, historyRes, resolutionRes, duplicateRes, feedbackRes] =
    await Promise.all([
      admin.from("report_locations").select("*").eq("report_id", reportId).maybeSingle(),
      admin.from("report_media").select("*").eq("report_id", reportId),
      admin.from("ai_analyses").select("*").eq("report_id", reportId).maybeSingle(),
      admin.from("report_assignments").select("*").eq("report_id", reportId).maybeSingle(),
      admin.from("follow_ups").select("*").eq("report_id", reportId).order("follow_up_date", { ascending: false }),
      admin.from("status_history").select("*").eq("report_id", reportId).order("created_at", { ascending: true }),
      admin.from("resolution_evidence").select("*").eq("report_id", reportId).maybeSingle(),
      admin
        .from("report_duplicate_flags")
        .select("possible_duplicate_of, relation_type, reason")
        .eq("report_id", reportId)
        .maybeSingle(),
      // Not yet present pre-migration-0012 environments — .maybeSingle()
      // returning an error there just leaves resolutionFeedback null below,
      // it never breaks the rest of this read (same defensive pattern used
      // throughout Phase 6B/6C for newly-added columns/tables).
      admin.from("resolution_feedback").select("*").eq("report_id", reportId).maybeSingle(),
    ]);

  const location: CivicLocation = locationRes.data
    ? toCivicLocation(locationRes.data)
    : { displayName: "Location not recorded", source: "manual" };

  const media: ReportMedia[] = await Promise.all(
    (mediaRes.data ?? []).map(async (m) => {
      const { data: signed } = await admin.storage.from("report-media").createSignedUrl(m.file_path, 900);
      return { id: m.id, kind: m.kind, url: signed?.signedUrl ?? null, mimeType: m.mime_type };
    })
  );

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
      assignedAt: assignmentRes.data.assigned_at,
    };
  }

  const followUpAuthorIds = [...new Set((followUpsRes.data ?? []).map((f) => f.government_user_id))];
  const authorNameById = new Map<string, string | null>();
  if (followUpAuthorIds.length > 0) {
    const { data: authors } = await admin.from("profiles").select("id, full_name").in("id", followUpAuthorIds);
    for (const a of authors ?? []) authorNameById.set(a.id, a.full_name);
  }

  // Only ever public-safe fields of the OTHER report (title/category/status/
  // location — all already shown for any report on this same detail page,
  // and already surfaced pre-submission by DuplicateIssueCard) — never that
  // report's reporter identity, media, or any other citizen's private data.
  let duplicateOf: ReportDetail["duplicateOf"] = null;
  if (duplicateRes.data?.possible_duplicate_of) {
    const [{ data: dup }, { data: dupLocation }] = await Promise.all([
      admin.from("reports").select("id, title, category, status").eq("id", duplicateRes.data.possible_duplicate_of).maybeSingle(),
      admin.from("report_locations").select("*").eq("report_id", duplicateRes.data.possible_duplicate_of).maybeSingle(),
    ]);
    if (dup) {
      duplicateOf = {
        id: dup.id,
        title: dup.title,
        category: categoryFromDb[dup.category],
        status: statusFromDb[dup.status],
        location: dupLocation ? toCivicLocation(dupLocation) : { displayName: "Location not recorded", source: "manual" },
        relationType: (duplicateRes.data.relation_type as DuplicateRelationType) ?? "duplicate",
        reason: duplicateRes.data.reason ?? null,
      };
    }
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
          extended: parseExtended(aiRes.data.extended),
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
      changedBy: h.changed_by,
    })),
    resolutionEvidence,
    duplicateOf,
    resolutionFeedback: feedbackRes.data
      ? {
          confirmed: feedbackRes.data.confirmed,
          comment: feedbackRes.data.comment,
          createdAt: feedbackRes.data.created_at,
          updatedAt: feedbackRes.data.updated_at,
        }
      : null,
    reopenedAt: report.reopened_at ?? null,
  };
}
