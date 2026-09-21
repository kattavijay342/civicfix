"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { REMINDER_TITLE_MAX, REMINDER_MESSAGE_MAX } from "@/lib/reminders-shared";
import { checkRateLimit, retryAfterMessage } from "@/lib/rate-limit";
import { beginIdempotentAction } from "@/lib/idempotency";

export interface ReminderFormState {
  error?: string;
  success?: boolean;
}

const IST_OFFSET = "+05:30";

/**
 * Parses a `datetime-local` input value ("YYYY-MM-DDTHH:mm") as India
 * Standard Time explicitly, rather than trusting the browser's or server's
 * local system timezone (Phase 4 Step 7) — the two can disagree (e.g. a
 * server running in UTC), which would silently shift every reminder.
 */
function parseIstDateTimeLocal(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00${IST_OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Creates a scheduled reminder instructing the department in-charge
 * currently assigned to a report. Only government/admin users may create
 * one (mirrors src/lib/actions/follow-up.ts's role restriction — this is
 * the same oversight/monitoring role, just with a scheduled due time).
 *
 * The recipient/department are never taken from the client — both are
 * resolved server-side from the report's existing report_assignments row,
 * so there is no way to target an unauthorized department or user.
 */
export async function createReminder(
  reportId: string,
  _prevState: ReminderFormState,
  formData: FormData
): Promise<ReminderFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile || (profile.role !== "government" && profile.role !== "admin")) {
    return { error: "Only government users can schedule reminders." };
  }

  // RLS-gated visibility check: report_in_my_jurisdiction / admin — same
  // pattern as addFollowUp, so an out-of-jurisdiction report is reported as
  // simply "not found", never distinguishing unauthorized from nonexistent.
  const { data: report } = await supabase.from("reports").select("id").eq("id", reportId).maybeSingle();
  if (!report) return { error: "Report not found." };

  const rateLimit = await checkRateLimit(`create_reminder:${user.id}`, 30, 60 * 60);
  if (!rateLimit.allowed) return { error: retryAfterMessage(rateLimit.retryAfterSeconds) };

  const admin = createAdminClient();

  const { data: assignment } = await admin
    .from("report_assignments")
    .select("department_id, incharge_id")
    .eq("report_id", reportId)
    .maybeSingle();

  if (!assignment || !assignment.incharge_id) {
    return { error: "This report has no department in-charge assigned yet." };
  }

  const title = String(formData.get("title") ?? "").trim();
  const message = String(formData.get("message") ?? "").trim();
  const scheduledAtRaw = String(formData.get("scheduledAt") ?? "").trim();

  if (title.length < 3 || title.length > REMINDER_TITLE_MAX) {
    return { error: `Title must be between 3 and ${REMINDER_TITLE_MAX} characters.` };
  }
  if (message.length < 5 || message.length > REMINDER_MESSAGE_MAX) {
    return { error: `Instruction must be between 5 and ${REMINDER_MESSAGE_MAX} characters.` };
  }

  const scheduledAt = parseIstDateTimeLocal(scheduledAtRaw);
  if (!scheduledAt) {
    return { error: "Please choose a valid date and time." };
  }
  if (scheduledAt.getTime() <= Date.now()) {
    return { error: "Please choose a date and time in the future." };
  }

  const clientKey = String(formData.get("idempotencyKey") ?? "").trim() || null;
  const idempotency = await beginIdempotentAction<ReminderFormState>(admin, user.id, "create_reminder", clientKey);
  if (idempotency.kind === "replay") return idempotency.result;
  if (idempotency.kind === "in_progress") {
    return { error: "This reminder is already being scheduled. Please wait a moment." };
  }

  const { error } = await admin.from("reminders").insert({
    report_id: reportId,
    created_by: user.id,
    department_id: assignment.department_id,
    recipient_id: assignment.incharge_id,
    title,
    message,
    scheduled_at: scheduledAt.toISOString(),
  });

  // Postgres unique_violation on reminders_dedupe_idx (report_id,
  // recipient_id, scheduled_at) — see supabase/migrations/0008_reminder_dedupe.sql.
  const isDuplicate = error?.code === "23505";

  const result: ReminderFormState = isDuplicate
    ? { error: "A reminder for this report and time is already scheduled." }
    : error
      ? { error: "Unable to schedule the reminder. Please try again." }
      : { success: true };

  if (error) await idempotency.release();
  else await idempotency.commit(result);

  if (!error) revalidatePath(`/reports/${reportId}`);
  return result;
}

/** Withdraws a reminder before it becomes due. Only its creator or an admin
 * may cancel it, and only while it's still "scheduled" — a reminder already
 * claimed/sent/failed has a real processing history and shouldn't silently
 * disappear (Step 4: no invalid state transitions). */
export async function cancelReminder(reminderId: string, reportId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile) return { error: "Profile not found." };

  const admin = createAdminClient();
  const { data: reminder } = await admin
    .from("reminders")
    .select("id, created_by, status")
    .eq("id", reminderId)
    .maybeSingle();

  if (!reminder) return { error: "Reminder not found." };
  if (profile.role !== "admin" && reminder.created_by !== user.id) {
    return { error: "Only the reminder's creator can cancel it." };
  }
  if (reminder.status !== "scheduled") {
    return { error: `This reminder is already "${reminder.status}" and can no longer be cancelled.` };
  }

  const { error } = await admin.from("reminders").update({ status: "cancelled" }).eq("id", reminderId);
  if (error) return { error: "Unable to cancel the reminder. Please try again." };

  revalidatePath(`/reports/${reportId}`);
  return {};
}
