"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logStatusChange } from "@/lib/actions/status-history";
import { statusToDb } from "@/lib/db-enums";
import { validateImageFile } from "@/lib/upload-limits";
import type { IssueStatus } from "@/lib/types";

export interface DepartmentActionState {
  error?: string;
  success?: boolean;
}

const FORWARD_STATUSES: IssueStatus[] = ["ACKNOWLEDGED", "IN_PROGRESS"];

async function assertInchargeOrAdmin(reportId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." } as const;

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile || (profile.role !== "department_incharge" && profile.role !== "admin")) {
    return { error: "Only the assigned department in-charge can update this report." } as const;
  }

  const admin = createAdminClient();
  const { data: report } = await admin.from("reports").select("id, status").eq("id", reportId).maybeSingle();
  if (!report) return { error: "Report not found." } as const;

  if (profile.role !== "admin") {
    const { data: assignment } = await admin
      .from("report_assignments")
      .select("incharge_id")
      .eq("report_id", reportId)
      .maybeSingle();
    if (!assignment || assignment.incharge_id !== user.id) {
      return { error: "This report isn't assigned to you." } as const;
    }
  }

  return { user, admin, report } as const;
}

/** Acknowledge or move a report to in-progress. Resolving requires evidence
 * — see submitResolution — so "resolved" is never accepted here. */
export async function updateReportStatus(
  reportId: string,
  _prevState: DepartmentActionState,
  formData: FormData
): Promise<DepartmentActionState> {
  const auth = await assertInchargeOrAdmin(reportId);
  if ("error" in auth) return { error: auth.error };
  const { user, admin, report } = auth;

  const nextStatus = String(formData.get("status") ?? "") as IssueStatus;
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!FORWARD_STATUSES.includes(nextStatus)) {
    return { error: "Invalid status." };
  }

  const { error } = await admin.from("reports").update({ status: statusToDb[nextStatus] }).eq("id", reportId);
  if (error) return { error: "Unable to update status. Please try again." };

  await logStatusChange(admin, reportId, report.status, statusToDb[nextStatus], user.id, notes);

  revalidatePath(`/reports/${reportId}`);
  revalidatePath("/department");
  return { success: true };
}

export async function submitResolution(
  reportId: string,
  _prevState: DepartmentActionState,
  formData: FormData
): Promise<DepartmentActionState> {
  const auth = await assertInchargeOrAdmin(reportId);
  if ("error" in auth) return { error: auth.error };
  const { user, admin, report } = auth;

  const notes = String(formData.get("notes") ?? "").trim();
  const afterPhoto = formData.get("afterPhoto");

  if (!notes || notes.length < 5) {
    return { error: "Add resolution notes describing what was done." };
  }
  if (notes.length > 1000) {
    return { error: "Notes are too long (1000 characters max)." };
  }
  if (!(afterPhoto instanceof File) || afterPhoto.size === 0) {
    return { error: "Upload a photo showing the resolved issue." };
  }
  const photoError = validateImageFile(afterPhoto);
  if (photoError) return { error: photoError };

  let afterMediaId: string;
  try {
    const buffer = Buffer.from(await afterPhoto.arrayBuffer());
    const ext = afterPhoto.name.split(".").pop() || "jpg";
    const path = `resolution/${reportId}/${randomUUID()}.${ext}`;

    const { error: uploadError } = await admin.storage
      .from("report-media")
      .upload(path, buffer, { contentType: afterPhoto.type || "image/jpeg" });
    if (uploadError) return { error: "Evidence upload failed. Please try again." };

    const { data: mediaRow, error: mediaError } = await admin
      .from("report_media")
      .insert({
        report_id: reportId,
        uploaded_by: user.id,
        kind: "after",
        file_path: path,
        file_type: "image",
        mime_type: afterPhoto.type || "image/jpeg",
      })
      .select("id")
      .single();
    if (mediaError || !mediaRow) return { error: "Evidence upload failed. Please try again." };
    afterMediaId = mediaRow.id;
  } catch {
    return { error: "Evidence upload failed. Please try again." };
  }

  const { data: beforeMedia } = await admin
    .from("report_media")
    .select("id")
    .eq("report_id", reportId)
    .eq("kind", "evidence")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const { error: resolutionError } = await admin.from("resolution_evidence").insert({
    report_id: reportId,
    before_media_id: beforeMedia?.id ?? null,
    after_media_id: afterMediaId,
    resolution_notes: notes,
    resolved_by: user.id,
  });
  if (resolutionError) return { error: "Unable to save the report. Please try again." };

  const { error: statusError } = await admin.from("reports").update({ status: "resolved" }).eq("id", reportId);
  if (statusError) return { error: "Unable to save the report. Please try again." };

  await logStatusChange(admin, reportId, report.status, "resolved", user.id, notes);

  // Notify the citizen who reported it.
  const { data: fullReport } = await admin.from("reports").select("reporter_id, title").eq("id", reportId).single();
  if (fullReport) {
    await admin.from("notifications").insert({
      recipient_id: fullReport.reporter_id,
      type: "report_resolved",
      title: "Your report was resolved",
      body: `"${fullReport.title}" has been marked resolved.`,
      related_report_id: reportId,
    });
  }

  revalidatePath(`/reports/${reportId}`);
  revalidatePath("/department");
  return { success: true };
}
