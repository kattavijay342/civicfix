import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotificationType, NotificationPriority } from "./types";
import { CATEGORY_BY_TYPE } from "./types";
import { isCategoryEnabled, type NotificationPreferences } from "./preferences";

/** Sensible default priority per type — callers may override (e.g. a
 * `status_changed` notification about a report that happens to be
 * critical-priority could reasonably be surfaced as "high"), but most call
 * sites don't need to think about this at all. */
const DEFAULT_PRIORITY: Record<NotificationType, NotificationPriority> = {
  report_created: "normal",
  ai_analysis_completed: "normal",
  report_assigned: "normal",
  status_changed: "normal",
  report_resolved: "normal",
  reminder_due: "high",
  critical_issue: "critical",
  follow_up_recorded: "normal",
  resolution_feedback_recorded: "normal",
  issue_reopened: "high",
};

export interface CreateNotificationInput {
  recipientId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  relatedReportId?: string | null;
  priority?: NotificationPriority;
  actionUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Only for `reminder_due`: the Phase 4/5 reminder scheduler has its own
   * guaranteed-delivery contract (atomic claim, retry with backoff, a
   * terminal "sent"/"failed" status the creator can rely on) — a reminder
   * silently suppressed by an unrelated preference toggle would report
   * "sent" while the recipient never saw it, breaking that contract in a
   * confusing way. Every other type stays preference-gated. */
  bypassPreferences?: boolean;
}

export interface CreatedNotification {
  id: string;
}

/**
 * The single, validated path every real notification goes through (Phase
 * 6C) — replaces the three previously-scattered raw `.insert()` call sites.
 * Always called with the service-role client from trusted server code
 * (Server Actions, the reminder scheduler) — a client can never reach this
 * directly, and RLS has no INSERT policy for `authenticated` at all, so
 * even a compromised client couldn't forge a notification for another user
 * by calling the table directly.
 *
 * Honors the recipient's notification_preferences (opt-out, defaults to
 * "on" — see src/lib/notifications/preferences.ts) for the type's category;
 * returns `null` when skipped for that reason so callers can tell the
 * difference from a real failure without treating it as one.
 */
export async function createNotification(
  admin: SupabaseClient,
  input: CreateNotificationInput
): Promise<CreatedNotification | null> {
  if (!input.bypassPreferences) {
    const { data: recipient } = await admin
      .from("profiles")
      .select("notification_preferences")
      .eq("id", input.recipientId)
      .maybeSingle();

    const prefs = (recipient?.notification_preferences as NotificationPreferences | null) ?? null;
    const category = CATEGORY_BY_TYPE[input.type];
    if (!isCategoryEnabled(prefs, category)) {
      return null;
    }
  }

  // The core insert uses ONLY the columns that existed before Phase 6C —
  // this must keep working exactly as it always has (report_assigned,
  // status_changed, report_resolved, reminder_due are live, working
  // notification types today) regardless of whether migration 0011 has
  // been applied yet in a given environment. priority/action_url/metadata/
  // channel are added afterward as a separate, best-effort update — if
  // those columns don't exist yet, that update fails harmlessly and the
  // notification itself still exists with its core fields, exactly as
  // before this phase. (Same defensive split as the accuracy_meters fix in
  // src/lib/actions/reports.ts.)
  const { data, error } = await admin
    .from("notifications")
    .insert({
      recipient_id: input.recipientId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      related_report_id: input.relatedReportId ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    // Never let a notification failure break the real event it's attached
    // to (report creation, status change, ...) — log and move on, matching
    // the existing "best-effort, non-fatal" pattern used elsewhere in this
    // codebase (e.g. duplicate detection in src/lib/actions/reports.ts).
    console.error("createNotification failed", input.type, error);
    return null;
  }

  const { error: enrichError } = await admin
    .from("notifications")
    .update({
      priority: input.priority ?? DEFAULT_PRIORITY[input.type],
      action_url: input.actionUrl ?? null,
      metadata: input.metadata ?? null,
      channel: "in_app",
    })
    .eq("id", data.id);
  if (enrichError) {
    console.error("createNotification: enrichment update failed (non-fatal)", input.type, enrichError);
  }

  return { id: data.id };
}
