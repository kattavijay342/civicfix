"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, retryAfterMessage } from "@/lib/rate-limit";
import { beginIdempotentAction } from "@/lib/idempotency";
import { createNotification } from "@/lib/notifications/create";
import { findGovernmentUsersForJurisdiction } from "@/lib/notifications/targeting";
import { logStatusChange } from "@/lib/actions/status-history";
import { statusFromDb } from "@/lib/db-enums";

export interface ResolutionFeedbackState {
  error?: string;
  success?: boolean;
  reopened?: boolean;
}

/**
 * The original reporter's confirmation signal on a resolution — "was this
 * actually fixed?" Only the reporter of THIS report may submit it (never
 * trusted from the client: report_id -> reporter_id is looked up server-side
 * with the admin client, then compared against the caller's own session
 * user id). A "no" reopens the report; a "yes" just records confirmation.
 * This is a citizen-reported signal only — it never becomes an official
 * government resolution or a "verified" badge (see src/lib/citizen-summary.ts).
 */
export async function submitResolutionFeedback(
  reportId: string,
  _prevState: ResolutionFeedbackState,
  formData: FormData
): Promise<ResolutionFeedbackState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const admin = createAdminClient();
  const { data: report } = await admin
    .from("reports")
    .select("id, title, reporter_id, status")
    .eq("id", reportId)
    .maybeSingle();
  if (!report) return { error: "Report not found." };
  if (report.reporter_id !== user.id) {
    return { error: "Only the person who reported this issue can submit feedback." };
  }

  const currentStatus = statusFromDb[report.status] ?? "REPORTED";
  if (currentStatus !== "RESOLVED") {
    return { error: "Feedback can only be submitted while a report is marked resolved." };
  }

  const rateLimit = await checkRateLimit(`submit_resolution_feedback:${user.id}`, 20, 60 * 60);
  if (!rateLimit.allowed) return { error: retryAfterMessage(rateLimit.retryAfterSeconds) };

  const confirmedRaw = String(formData.get("confirmed") ?? "");
  if (confirmedRaw !== "yes" && confirmedRaw !== "no") {
    return { error: "Please choose whether the issue was actually resolved." };
  }
  const confirmed = confirmedRaw === "yes";

  const comment = String(formData.get("comment") ?? "").trim() || null;
  if (comment && comment.length > 1000) {
    return { error: "Comment is too long (1000 characters max)." };
  }

  const clientKey = String(formData.get("idempotencyKey") ?? "").trim() || null;
  const idempotency = await beginIdempotentAction<ResolutionFeedbackState>(
    admin,
    user.id,
    "submit_resolution_feedback",
    clientKey
  );
  if (idempotency.kind === "replay") return idempotency.result;
  if (idempotency.kind === "in_progress") {
    return { error: "This feedback is already being saved. Please wait a moment." };
  }

  const result = await performSubmitFeedback(admin, reportId, report, user.id, confirmed, comment);

  if (result.error) await idempotency.release();
  else await idempotency.commit(result);

  revalidatePath(`/reports/${reportId}`);
  revalidatePath("/department");
  return result;
}

/** Exported so the actual DB-facing logic (upsert/edit, reopen transition,
 * notification dispatch, never-throws-on-failure) can be unit-tested with
 * the fake Supabase client — see resolution-feedback.test.ts. The outer
 * submitResolutionFeedback wraps this with cookie-bound session/auth
 * plumbing that, like every other "use server" action in this codebase
 * (see department.ts, follow-up.ts), is verified live instead (scripts/
 * verify-phase6d-live.mjs), not with vitest. */
export async function performSubmitFeedback(
  admin: ReturnType<typeof createAdminClient>,
  reportId: string,
  report: { title: string; reporter_id: string },
  citizenId: string,
  confirmed: boolean,
  comment: string | null
): Promise<ResolutionFeedbackState> {
  // report_id is unique on this table, and callers only ever reach here
  // after confirming citizenId === report.reporter_id (see
  // submitResolutionFeedback above), so this can only ever touch this
  // citizen's own row — editable so a citizen can re-submit feedback for a
  // fresh resolution after a reopen cycle.
  const { data: existing } = await admin
    .from("resolution_feedback")
    .select("id")
    .eq("report_id", reportId)
    .maybeSingle();

  const writeError = existing
    ? (
        await admin
          .from("resolution_feedback")
          .update({ confirmed, comment, updated_at: new Date().toISOString() })
          .eq("id", existing.id)
      ).error
    : (
        await admin
          .from("resolution_feedback")
          .insert({ report_id: reportId, citizen_id: citizenId, confirmed, comment })
      ).error;
  if (writeError) return { error: "Unable to save your feedback. Please try again." };

  await logStatusChange(
    admin,
    reportId,
    "resolved",
    confirmed ? "resolved" : "reopened",
    citizenId,
    confirmed
      ? "Citizen confirmed the issue was resolved."
      : `Citizen reported the issue is still unresolved.${comment ? ` "${comment}"` : ""}`
  );

  const { data: assignment } = await admin
    .from("report_assignments")
    .select("incharge_id")
    .eq("report_id", reportId)
    .maybeSingle();

  if (!confirmed) {
    const { error: statusError } = await admin
      .from("reports")
      .update({ status: "reopened", reopened_at: new Date().toISOString() })
      .eq("id", reportId);
    if (statusError) return { error: "Unable to save your feedback. Please try again." };

    if (assignment?.incharge_id) {
      await createNotification(admin, {
        recipientId: assignment.incharge_id,
        type: "issue_reopened",
        title: "Issue reopened by citizen",
        body: `"${report.title}" was reopened — the citizen reports it isn't actually resolved.${comment ? ` "${comment}"` : ""}`,
        relatedReportId: reportId,
      });
    }

    const { data: location } = await admin
      .from("report_locations")
      .select("state, district, constituency, area")
      .eq("report_id", reportId)
      .maybeSingle();
    if (location) {
      const govUserIds = await findGovernmentUsersForJurisdiction(admin, location);
      for (const govUserId of govUserIds) {
        await createNotification(admin, {
          recipientId: govUserId,
          type: "issue_reopened",
          title: "Issue reopened by citizen",
          body: `"${report.title}" was reopened in your jurisdiction — the citizen reports it isn't actually resolved.`,
          relatedReportId: reportId,
        });
      }
    }

    return { success: true, reopened: true };
  }

  if (assignment?.incharge_id) {
    await createNotification(admin, {
      recipientId: assignment.incharge_id,
      type: "resolution_feedback_recorded",
      title: "Citizen confirmed your resolution",
      body: `The citizen confirmed "${report.title}" was actually resolved.`,
      relatedReportId: reportId,
    });
  }

  return { success: true, reopened: false };
}
