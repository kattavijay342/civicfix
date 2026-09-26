"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { REMINDER_TITLE_MAX, REMINDER_MESSAGE_MAX } from "@/lib/reminders-shared";
import { checkRateLimit, retryAfterMessage } from "@/lib/rate-limit";
import { beginIdempotentAction } from "@/lib/idempotency";
import { checkInchargeAccess } from "@/lib/data/incharge-access";
import { deliverReminderNow } from "@/lib/reminders";

export interface ReminderFormState {
  error?: string;
  success?: boolean;
  /** G6 — what happened to a successful submission: "scheduled" for a
   * future reminder, "sent" when an immediate follow-up was delivered,
   * "queued" when immediate delivery hit a transient error and the
   * scheduler will retry it. */
  outcome?: "scheduled" | "sent" | "queued";
}

/** Used when the government user leaves the (optional) title blank. */
const DEFAULT_FOLLOW_UP_TITLE = "Government follow-up";
/** An identical immediate follow-up to the same in-charge on the same
 * report inside this window is treated as an accidental re-send. */
const IMMEDIATE_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

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
 * Creates a government → department follow-up: a reminder for the
 * department in-charge currently assigned to a report, delivered either
 * immediately (`timing=now`, G6) or at a scheduled time. Only
 * government/admin users may create one (mirrors src/lib/actions/follow-up.ts's role restriction — this is
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

  // G5 — the stored incharge_id alone isn't enough: a deactivated, moved,
  // demoted or re-scoped in-charge must never be sent a reminder (G4's
  // effective-assignment rule, evaluated for the recipient).
  const recipientAccess = await checkInchargeAccess(admin, assignment.incharge_id, reportId);
  if (!recipientAccess.ok) {
    return { error: "Department in-charge unavailable — a reminder can't be sent until an active in-charge is assigned." };
  }

  const sendNow = String(formData.get("timing") ?? "") === "now";
  const title = String(formData.get("title") ?? "").trim() || DEFAULT_FOLLOW_UP_TITLE;
  const message = String(formData.get("message") ?? "").trim();
  const scheduledAtRaw = String(formData.get("scheduledAt") ?? "").trim();

  if (title.length < 3 || title.length > REMINDER_TITLE_MAX) {
    return { error: `Title must be between 3 and ${REMINDER_TITLE_MAX} characters.` };
  }
  if (message.length < 5 || message.length > REMINDER_MESSAGE_MAX) {
    return { error: `Message must be between 5 and ${REMINDER_MESSAGE_MAX} characters.` };
  }

  const scheduledAt = sendNow ? new Date() : parseIstDateTimeLocal(scheduledAtRaw);
  if (!scheduledAt) {
    return { error: "Please choose a valid date and time." };
  }
  if (!sendNow && scheduledAt.getTime() <= Date.now()) {
    return { error: "Please choose a date and time in the future." };
  }

  // reminders_dedupe_idx only covers still-`scheduled` rows at an exact
  // time, so an immediate follow-up (delivered at once, no shared slot)
  // needs its own guard against re-sending the same message.
  if (sendNow) {
    const { data: recent } = await admin
      .from("reminders")
      .select("id")
      .eq("report_id", reportId)
      .eq("recipient_id", assignment.incharge_id)
      .eq("message", message)
      .in("status", ["scheduled", "processing", "sent"])
      .gte("created_at", new Date(Date.now() - IMMEDIATE_DUPLICATE_WINDOW_MS).toISOString())
      .limit(1);
    if (recent && recent.length > 0) {
      return { error: "This follow-up was already sent to the department in-charge a few minutes ago." };
    }
  }

  const clientKey = String(formData.get("idempotencyKey") ?? "").trim() || null;
  const idempotency = await beginIdempotentAction<ReminderFormState>(admin, user.id, "create_reminder", clientKey);
  if (idempotency.kind === "replay") return idempotency.result;
  if (idempotency.kind === "in_progress") {
    return { error: "This reminder is already being scheduled. Please wait a moment." };
  }

  const { data: inserted, error } = await admin
    .from("reminders")
    .insert({
      report_id: reportId,
      created_by: user.id,
      department_id: assignment.department_id,
      recipient_id: assignment.incharge_id,
      title,
      message,
      scheduled_at: scheduledAt.toISOString(),
    })
    .select("id")
    .single();

  // Postgres unique_violation on reminders_dedupe_idx (report_id,
  // recipient_id, scheduled_at) — see supabase/migrations/0008_reminder_dedupe.sql.
  const isDuplicate = error?.code === "23505";

  let result: ReminderFormState;
  if (isDuplicate) {
    result = { error: "A reminder for this report and time is already scheduled." };
  } else if (error || !inserted) {
    result = { error: sendNow ? "Unable to send the follow-up. Please try again." : "Unable to schedule the reminder. Please try again." };
  } else if (!sendNow) {
    result = { success: true, outcome: "scheduled" };
  } else {
    // Same delivery path as the scheduler, including its re-check that
    // the recipient is still the effective in-charge at delivery time.
    const delivered = await deliverReminderNow(admin, inserted.id);
    result =
      delivered === "failed"
        ? { error: "Department in-charge is currently unavailable." }
        : { success: true, outcome: delivered === "sent" ? "sent" : "queued" };
  }

  if (error) await idempotency.release();
  else await idempotency.commit(result);

  if (!error) {
    revalidatePath(`/reports/${reportId}`);
    revalidatePath("/government");
    revalidatePath("/department");
  }
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
