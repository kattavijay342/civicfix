"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, retryAfterMessage } from "@/lib/rate-limit";
import { beginIdempotentAction } from "@/lib/idempotency";
import { createNotification } from "@/lib/notifications/create";
import { checkInchargeAccess } from "@/lib/data/incharge-access";

export interface FollowUpFormState {
  error?: string;
  success?: boolean;
}

/** Government users monitor and record follow-ups. They never reassign a
 * report — department/in-charge routing is fixed by resolveAssignment(). */
export async function addFollowUp(
  reportId: string,
  _prevState: FollowUpFormState,
  formData: FormData
): Promise<FollowUpFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile || (profile.role !== "government" && profile.role !== "admin")) {
    return { error: "Only government users can record follow-ups." };
  }

  // RLS-gated visibility check: report_in_my_jurisdiction / admin.
  const { data: report } = await supabase.from("reports").select("id, title").eq("id", reportId).maybeSingle();
  if (!report) return { error: "Report not found." };

  const rateLimit = await checkRateLimit(`add_follow_up:${user.id}`, 30, 60 * 60);
  if (!rateLimit.allowed) return { error: retryAfterMessage(rateLimit.retryAfterSeconds) };

  const notes = String(formData.get("notes") ?? "").trim();
  const nextFollowUpDate = String(formData.get("nextFollowUpDate") ?? "").trim() || null;

  if (!notes || notes.length < 3) {
    return { error: "Add a short note for this follow-up." };
  }
  if (notes.length > 1000) {
    return { error: "Note is too long (1000 characters max)." };
  }

  const admin = createAdminClient();

  const clientKey = String(formData.get("idempotencyKey") ?? "").trim() || null;
  const idempotency = await beginIdempotentAction<FollowUpFormState>(admin, user.id, "add_follow_up", clientKey);
  if (idempotency.kind === "replay") return idempotency.result;
  if (idempotency.kind === "in_progress") {
    return { error: "This follow-up is already being saved. Please wait a moment." };
  }

  const { error } = await admin.from("follow_ups").insert({
    report_id: reportId,
    government_user_id: user.id,
    notes,
    next_follow_up_date: nextFollowUpDate,
  });

  const result: FollowUpFormState = error
    ? { error: "Unable to save the follow-up. Please try again." }
    : { success: true };

  if (error) await idempotency.release();
  else await idempotency.commit(result);

  if (!error) {
    const { data: assignment } = await admin
      .from("report_assignments")
      .select("incharge_id")
      .eq("report_id", reportId)
      .maybeSingle();
    // Only an in-charge who still effectively owns the report is notified
    // (G4 rule) — never a deactivated/moved/re-scoped one.
    if (assignment?.incharge_id && (await checkInchargeAccess(admin, assignment.incharge_id, reportId)).ok) {
      await createNotification(admin, {
        recipientId: assignment.incharge_id,
        type: "follow_up_recorded",
        title: "Government follow-up recorded",
        body: `A follow-up note was recorded on "${report.title}": ${notes}`,
        relatedReportId: reportId,
      });
    }
    revalidatePath(`/reports/${reportId}`);
  }
  return result;
}
