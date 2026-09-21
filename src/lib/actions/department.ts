"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logStatusChange } from "@/lib/actions/status-history";
import { notifyStatusChanged } from "@/lib/actions/notifications";
import { createNotification } from "@/lib/notifications/create";
import { statusToDb, statusFromDb } from "@/lib/db-enums";
import { validateImageFile, validateImageBuffer } from "@/lib/upload-limits";
import { checkRateLimit, retryAfterMessage } from "@/lib/rate-limit";
import { beginIdempotentAction } from "@/lib/idempotency";
import { STATUS_ORDER, FORWARD_STATUSES, canSubmitResolution } from "@/lib/status-transitions";
import type { IssueStatus } from "@/lib/types";

export interface DepartmentActionState {
  error?: string;
  success?: boolean;
}

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
  const { data: report } = await admin
    .from("reports")
    .select("id, status, reporter_id, title")
    .eq("id", reportId)
    .maybeSingle();
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

  const rateLimit = await checkRateLimit(`update_report_status:${user.id}`, 60, 60 * 60);
  if (!rateLimit.allowed) return { error: retryAfterMessage(rateLimit.retryAfterSeconds) };

  const nextStatus = String(formData.get("status") ?? "") as IssueStatus;
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!FORWARD_STATUSES.includes(nextStatus)) {
    return { error: "Invalid status." };
  }

  const currentStatus = statusFromDb[report.status] ?? "REPORTED";
  if (STATUS_ORDER[nextStatus] <= STATUS_ORDER[currentStatus]) {
    return { error: `This report is already at or past "${currentStatus.replace("_", " ").toLowerCase()}".` };
  }

  const clientKey = String(formData.get("idempotencyKey") ?? "").trim() || null;
  const idempotency = await beginIdempotentAction<DepartmentActionState>(
    admin,
    user.id,
    "update_report_status",
    clientKey
  );
  if (idempotency.kind === "replay") return idempotency.result;
  if (idempotency.kind === "in_progress") {
    return { error: "This update is already being saved. Please wait a moment." };
  }

  const { error } = await admin.from("reports").update({ status: statusToDb[nextStatus] }).eq("id", reportId);
  const result: DepartmentActionState = error ? { error: "Unable to update status. Please try again." } : { success: true };

  if (error) {
    await idempotency.release();
    return result;
  }
  await idempotency.commit(result);

  await logStatusChange(admin, reportId, report.status, statusToDb[nextStatus], user.id, notes);
  await notifyStatusChanged(admin, reportId, report.reporter_id, report.title, statusToDb[nextStatus]);

  revalidatePath(`/reports/${reportId}`);
  revalidatePath("/department");
  return result;
}

export async function submitResolution(
  reportId: string,
  _prevState: DepartmentActionState,
  formData: FormData
): Promise<DepartmentActionState> {
  const auth = await assertInchargeOrAdmin(reportId);
  if ("error" in auth) return { error: auth.error };
  const { user, admin, report } = auth;

  const rateLimit = await checkRateLimit(`file_upload:${user.id}`, 20, 60 * 60);
  if (!rateLimit.allowed) return { error: retryAfterMessage(rateLimit.retryAfterSeconds) };

  const currentStatus = statusFromDb[report.status] ?? "REPORTED";
  if (!canSubmitResolution(currentStatus)) {
    return currentStatus === "RESOLVED"
      ? { error: "This report has already been resolved." }
      : { error: "Acknowledge the report and mark it in progress before submitting a resolution." };
  }

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

  const clientKey = String(formData.get("idempotencyKey") ?? "").trim() || null;
  const idempotency = await beginIdempotentAction<DepartmentActionState>(
    admin,
    user.id,
    "submit_resolution",
    clientKey
  );
  if (idempotency.kind === "replay") return idempotency.result;
  if (idempotency.kind === "in_progress") {
    return { error: "This resolution is already being saved. Please wait a moment." };
  }

  const result = await performResolution(reportId, user.id, admin, report, notes, afterPhoto);

  if (result.error) {
    await idempotency.release();
    return result;
  }
  await idempotency.commit(result);

  revalidatePath(`/reports/${reportId}`);
  revalidatePath("/department");
  return result;
}

async function performResolution(
  reportId: string,
  userId: string,
  admin: ReturnType<typeof createAdminClient>,
  report: { status: string },
  notes: string,
  afterPhoto: File
): Promise<DepartmentActionState> {
  let afterMediaId: string;
  try {
    const buffer = Buffer.from(await afterPhoto.arrayBuffer());
    const { error: bufferError, extension } = validateImageBuffer(buffer);
    if (bufferError) return { error: bufferError };
    const path = `resolution/${reportId}/${randomUUID()}.${extension}`;

    const { error: uploadError } = await admin.storage
      .from("report-media")
      .upload(path, buffer, { contentType: afterPhoto.type || "image/jpeg" });
    if (uploadError) return { error: "Evidence upload failed. Please try again." };

    const { data: mediaRow, error: mediaError } = await admin
      .from("report_media")
      .insert({
        report_id: reportId,
        uploaded_by: userId,
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
    resolved_by: userId,
  });
  if (resolutionError) return { error: "Unable to save the report. Please try again." };

  const { error: statusError } = await admin.from("reports").update({ status: "resolved" }).eq("id", reportId);
  if (statusError) return { error: "Unable to save the report. Please try again." };

  await logStatusChange(admin, reportId, report.status, "resolved", userId, notes);

  // Notify the citizen who reported it.
  const { data: fullReport } = await admin.from("reports").select("reporter_id, title").eq("id", reportId).single();
  if (fullReport) {
    await createNotification(admin, {
      recipientId: fullReport.reporter_id,
      type: "report_resolved",
      title: "Your report was resolved",
      body: `"${fullReport.title}" has been marked resolved.`,
      relatedReportId: reportId,
    });
  }

  return { success: true };
}
