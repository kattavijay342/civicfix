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
import {
  FORWARD_STATUSES,
  canAdvanceStatus,
  canSubmitResolution,
  transitionErrorMessage,
} from "@/lib/status-transitions";
import { checkInchargeAccess } from "@/lib/data/incharge-access";
import { INCHARGE_ACCESS_MESSAGES } from "@/lib/incharge-access";
import type { IssueStatus } from "@/lib/types";

export interface DepartmentActionState {
  error?: string;
  success?: boolean;
}

const CONCURRENT_UPDATE_MESSAGE = "This report was just updated by someone else. Refresh the page to see its latest status.";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Authorizes a department workflow mutation. The caller's identity is the
 * authenticated Supabase session only — the report id is the one thing the
 * client supplies, and it is used purely as a lookup key. For an in-charge,
 * checkInchargeAccess re-verifies the assignment AND their live standing
 * (still a department_incharge, same department, active, jurisdiction
 * still covers the report) so a stale assignment grants nothing.
 * Admins keep the override they have always had; government users and
 * citizens are refused.
 */
async function assertInchargeOrAdmin(reportId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." } as const;

  const admin = createAdminClient();
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!profile || (profile.role !== "department_incharge" && profile.role !== "admin")) {
    return { error: INCHARGE_ACCESS_MESSAGES.not_incharge } as const;
  }

  const { data: report } = await admin
    .from("reports")
    .select("id, status, reporter_id, title")
    .eq("id", reportId)
    .maybeSingle();
  if (!report) return { error: "Report not found." } as const;

  if (profile.role !== "admin") {
    const access = await checkInchargeAccess(admin, user.id, reportId);
    if (!access.ok) return { error: INCHARGE_ACCESS_MESSAGES[access.reason] } as const;
  }

  return { user, admin, report } as const;
}

/**
 * Moves a report one step forward: Routed/Reopened -> Acknowledged, or
 * Acknowledged -> In Progress. Resolving requires evidence — see
 * submitResolution — so "resolved" is never accepted here. The requested
 * status is only an intent: it must equal the single valid next step for
 * the report's CURRENT stored status, so a stale page can't skip a stage.
 */
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
  if (notes && notes.length > 1000) {
    return { error: "Notes are too long (1000 characters max)." };
  }

  // Claimed before the transition check so a double-submit of the SAME
  // click replays its original success instead of reporting "already
  // acknowledged" for the request that actually did the work.
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

  const previousStatus: string = report.status;
  const currentStatus = statusFromDb[previousStatus] ?? "REPORTED";
  if (!canAdvanceStatus(currentStatus, nextStatus)) {
    await idempotency.release();
    return { error: transitionErrorMessage(currentStatus, nextStatus) };
  }

  // Compare-and-set on the status we validated against: if another request
  // (a second tab, a double click with a fresh key) moved the report in
  // the meantime, zero rows match and nothing — history, notification —
  // is written twice.
  const { data: updated, error } = await admin
    .from("reports")
    .update({ status: statusToDb[nextStatus] })
    .eq("id", reportId)
    .eq("status", previousStatus)
    .select("id");

  if (error || !updated || updated.length === 0) {
    await idempotency.release();
    return { error: error ? "Unable to update status. Please try again." : CONCURRENT_UPDATE_MESSAGE };
  }

  const result: DepartmentActionState = { success: true };
  await idempotency.commit(result);

  await logStatusChange(admin, reportId, previousStatus, statusToDb[nextStatus], user.id, notes);
  await notifyStatusChanged(admin, reportId, report.reporter_id, report.title, statusToDb[nextStatus]);

  revalidateWorkflowPaths(reportId);
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

  const currentStatus = statusFromDb[report.status] ?? "REPORTED";
  if (!canSubmitResolution(currentStatus)) {
    await idempotency.release();
    return { error: transitionErrorMessage(currentStatus, "RESOLVED") };
  }

  const result = await performResolution(reportId, user.id, admin, { ...report }, notes, afterPhoto);

  if (result.error) {
    await idempotency.release();
    return result;
  }
  await idempotency.commit(result);

  revalidateWorkflowPaths(reportId);
  return result;
}

function revalidateWorkflowPaths(reportId: string) {
  revalidatePath(`/reports/${reportId}`);
  revalidatePath("/department");
  revalidatePath("/government/issues");
}

/** Best-effort removal of an evidence upload whose resolution didn't land,
 * so a failed/conflicting attempt leaves no orphaned "after" photo. */
async function discardUploadedEvidence(admin: AdminClient, mediaId: string, path: string) {
  await admin.from("report_media").delete().eq("id", mediaId);
  await admin.storage.from("report-media").remove([path]);
}

async function performResolution(
  reportId: string,
  userId: string,
  admin: AdminClient,
  report: { status: string; reporter_id: string; title: string },
  notes: string,
  afterPhoto: File
): Promise<DepartmentActionState> {
  let afterMediaId: string;
  let afterPath: string;
  try {
    const buffer = Buffer.from(await afterPhoto.arrayBuffer());
    const { error: bufferError, extension } = validateImageBuffer(buffer);
    if (bufferError) return { error: bufferError };
    afterPath = `resolution/${reportId}/${randomUUID()}.${extension}`;

    const { error: uploadError } = await admin.storage
      .from("report-media")
      .upload(afterPath, buffer, { contentType: afterPhoto.type || "image/jpeg" });
    if (uploadError) return { error: "Evidence upload failed. Please try again." };

    const { data: mediaRow, error: mediaError } = await admin
      .from("report_media")
      .insert({
        report_id: reportId,
        uploaded_by: userId,
        kind: "after",
        file_path: afterPath,
        file_type: "image",
        mime_type: afterPhoto.type || "image/jpeg",
      })
      .select("id")
      .single();
    if (mediaError || !mediaRow) {
      await admin.storage.from("report-media").remove([afterPath]);
      return { error: "Evidence upload failed. Please try again." };
    }
    afterMediaId = mediaRow.id;
  } catch {
    return { error: "Evidence upload failed. Please try again." };
  }

  // Claim the transition atomically first (same compare-and-set as
  // updateReportStatus): exactly one concurrent resolver can win, and a
  // loser never writes evidence, history or a notification.
  const { data: claimed, error: claimError } = await admin
    .from("reports")
    .update({ status: "resolved" })
    .eq("id", reportId)
    .eq("status", report.status)
    .select("id");
  if (claimError || !claimed || claimed.length === 0) {
    await discardUploadedEvidence(admin, afterMediaId, afterPath);
    return { error: claimError ? "Unable to save the resolution. Please try again." : CONCURRENT_UPDATE_MESSAGE };
  }

  const { data: beforeMedia } = await admin
    .from("report_media")
    .select("id")
    .eq("report_id", reportId)
    .eq("kind", "evidence")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  // resolution_evidence is one-row-per-report (unique report_id). After a
  // citizen reopen, the report is resolved AGAIN: the existing row is
  // updated to describe the current resolution (fresh resolved_at, which
  // the resolution-feedback flow compares against), while the earlier
  // resolution stays traceable through status_history notes and its own
  // report_media "after" photo, which is never deleted.
  const evidence = {
    before_media_id: beforeMedia?.id ?? null,
    after_media_id: afterMediaId,
    resolution_notes: notes,
    resolved_by: userId,
    resolved_at: new Date().toISOString(),
  };
  const { data: existingEvidence } = await admin
    .from("resolution_evidence")
    .select("id")
    .eq("report_id", reportId)
    .maybeSingle();
  const { error: evidenceError } = existingEvidence
    ? await admin.from("resolution_evidence").update(evidence).eq("id", existingEvidence.id)
    : await admin.from("resolution_evidence").insert({ report_id: reportId, ...evidence });

  if (evidenceError) {
    // Undo our own claim (only if nothing else has moved it since).
    await admin.from("reports").update({ status: report.status }).eq("id", reportId).eq("status", "resolved");
    await discardUploadedEvidence(admin, afterMediaId, afterPath);
    return { error: "Unable to save the resolution. Please try again." };
  }

  await logStatusChange(admin, reportId, report.status, "resolved", userId, notes);

  await createNotification(admin, {
    recipientId: report.reporter_id,
    type: "report_resolved",
    title: "Your report was resolved",
    body: `"${report.title}" has been marked resolved.`,
    relatedReportId: reportId,
  });

  return { success: true };
}
