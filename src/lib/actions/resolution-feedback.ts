"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, retryAfterMessage } from "@/lib/rate-limit";
import { beginIdempotentAction } from "@/lib/idempotency";
import { FEEDBACK_ACCESS_MESSAGES, evaluateFeedbackAccess, parseFeedbackInput } from "@/lib/resolution-verification";
import { performSubmitFeedback, type ResolutionFeedbackState } from "@/lib/actions/resolution-feedback-core";

export type { ResolutionFeedbackState };

/**
 * G7 — the reporting citizen verifies or rejects a department resolution.
 * Only the citizen who reported THIS report may submit it: the caller is
 * the session user, and their role and the report's reporter are read
 * server-side (evaluateFeedbackAccess) — nothing identifying comes from the
 * client. Verify records confirmation; reject (reason required) reopens
 * the report for the same department workflow (Reopened -> Acknowledged).
 * "Verified" is the citizen's own confirmation, never an official
 * government verification (see src/lib/resolution-verification.ts).
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
  if (!user) return { error: FEEDBACK_ACCESS_MESSAGES.signed_out };

  const admin = createAdminClient();
  const [{ data: profile }, { data: report }] = await Promise.all([
    admin.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    admin.from("reports").select("id, title, reporter_id, status").eq("id", reportId).maybeSingle(),
  ]);
  const access = evaluateFeedbackAccess({
    userId: user.id,
    role: profile?.role ?? null,
    reporterId: report?.reporter_id ?? null,
  });
  if (!access.ok || !report) return { error: FEEDBACK_ACCESS_MESSAGES[access.ok ? "not_found" : access.reason] };

  const rateLimit = await checkRateLimit(`submit_resolution_feedback:${user.id}`, 20, 60 * 60);
  if (!rateLimit.allowed) return { error: retryAfterMessage(rateLimit.retryAfterSeconds) };

  const input = parseFeedbackInput(formData.get("confirmed"), formData.get("comment"));
  if ("error" in input) return { error: input.error };
  const submittedResolvedAt = String(formData.get("resolvedAt") ?? "").trim() || null;

  const clientKey = String(formData.get("idempotencyKey") ?? "").trim() || null;
  const idempotency = await beginIdempotentAction<ResolutionFeedbackState>(
    admin,
    user.id,
    "submit_resolution_feedback",
    clientKey
  );
  if (idempotency.kind === "replay") return idempotency.result;
  if (idempotency.kind === "in_progress") {
    return { error: "This decision is already being saved. Please wait a moment." };
  }

  const result = await performSubmitFeedback(admin, reportId, report, user.id, {
    confirmed: input.confirmed,
    comment: input.comment,
    submittedResolvedAt,
  });

  if (result.error) await idempotency.release();
  else await idempotency.commit(result);

  revalidatePath(`/reports/${reportId}`);
  revalidatePath("/department");
  revalidatePath("/government/issues");
  return result;
}
