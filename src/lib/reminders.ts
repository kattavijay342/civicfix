import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReminderStatus } from "@/lib/reminders-shared";
import { createNotification } from "@/lib/notifications/create";

export const REMINDER_MAX_ATTEMPTS = 3;
/** Fixed backoff before a failed-but-retryable reminder becomes due again —
 * mirrors the short-fixed-delay retry approach already used for AI analysis
 * (src/lib/actions/reports.ts) rather than true exponential backoff, which
 * would be overkill for a 3-attempt ceiling. */
const RETRY_BACKOFF_MS = 2 * 60 * 1000;

export interface Reminder {
  id: string;
  report_id: string;
  created_by: string;
  department_id: string;
  recipient_id: string;
  title: string;
  message: string;
  scheduled_at: string;
  status: ReminderStatus;
  notification_id: string | null;
  attempt_count: number;
  processed_at: string | null;
  sent_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProcessRemindersSummary {
  claimed: number;
  sent: number;
  failedPermanently: number;
  retried: number;
}

/**
 * Atomically claims every reminder that is due (status = 'scheduled' AND
 * scheduled_at <= now) and processes each one: creates the recipient's
 * in-app notification, then resolves the reminder to a terminal or
 * retry-pending state.
 *
 * Safe to call concurrently or repeatedly (Step 10/11): the claim step is a
 * single conditional UPDATE ... WHERE status = 'scheduled' ... RETURNING —
 * Postgres row locking means two overlapping calls can never both claim the
 * same row, so a reminder can never produce two notifications. Only the
 * process that successfully claims a row proceeds to update it further, so
 * the per-row resolution update afterwards is uncontested.
 */
export async function processDueReminders(admin: SupabaseClient): Promise<ProcessRemindersSummary> {
  const nowIso = new Date().toISOString();

  const { data: claimed, error: claimError } = await admin
    .from("reminders")
    .update({ status: "processing", processed_at: nowIso })
    .eq("status", "scheduled")
    .lte("scheduled_at", nowIso)
    .select("*");

  if (claimError) {
    throw new Error(`Failed to claim due reminders: ${claimError.message}`);
  }

  const rows = (claimed ?? []) as Reminder[];
  const summary: ProcessRemindersSummary = { claimed: rows.length, sent: 0, failedPermanently: 0, retried: 0 };

  for (const reminder of rows) {
    const nextAttempt = reminder.attempt_count + 1;
    await resolveClaimedReminder(admin, reminder, nextAttempt, summary);
  }

  return summary;
}

async function resolveClaimedReminder(
  admin: SupabaseClient,
  reminder: Reminder,
  nextAttempt: number,
  summary: ProcessRemindersSummary
): Promise<void> {
  try {
    const { data: recipient } = await admin
      .from("profiles")
      .select("id, full_name")
      .eq("id", reminder.recipient_id)
      .maybeSingle();

    if (!recipient) {
      // Permanent failure — retrying can never fix a deleted recipient.
      await admin
        .from("reminders")
        .update({
          status: "failed",
          attempt_count: nextAttempt,
          failure_reason: "Recipient no longer exists.",
        })
        .eq("id", reminder.id);
      summary.failedPermanently += 1;
      return;
    }

    const { data: report } = await admin.from("reports").select("title").eq("id", reminder.report_id).maybeSingle();
    const reportTitle = report?.title ?? "a report";

    // createNotification() never throws (it logs and returns null on
    // failure, so a bad notification never breaks the *creating* action) —
    // but a reminder's entire job IS to guarantee a notification, so this
    // caller explicitly throws on `null` to preserve the existing
    // retry/failure semantics below.
    const notification = await createNotification(admin, {
      recipientId: reminder.recipient_id,
      type: "reminder_due",
      title: reminder.title,
      body: `Reminder for "${reportTitle}": ${reminder.message}`,
      relatedReportId: reminder.report_id,
      bypassPreferences: true,
    });

    if (!notification) {
      throw new Error("Notification creation returned no row.");
    }

    await admin
      .from("reminders")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        attempt_count: nextAttempt,
        notification_id: notification.id,
        failure_reason: null,
      })
      .eq("id", reminder.id);
    summary.sent += 1;
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Unknown processing error.";
    console.error("Reminder processing failed", reminder.id, reason);

    if (nextAttempt >= REMINDER_MAX_ATTEMPTS) {
      await admin
        .from("reminders")
        .update({ status: "failed", attempt_count: nextAttempt, failure_reason: reason })
        .eq("id", reminder.id);
      summary.failedPermanently += 1;
    } else {
      await admin
        .from("reminders")
        .update({
          status: "scheduled",
          attempt_count: nextAttempt,
          failure_reason: reason,
          scheduled_at: new Date(Date.now() + RETRY_BACKOFF_MS).toISOString(),
        })
        .eq("id", reminder.id);
      summary.retried += 1;
    }
  }
}
