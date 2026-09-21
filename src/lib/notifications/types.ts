/**
 * The complete set of notification types this app actually produces.
 * Deliberately NOT a superset of every type a spec might imagine — only
 * types with a real, wired event behind them. Phase 6D added
 * `resolution_feedback_recorded`/`issue_reopened` once reopening became a
 * real feature of the status lifecycle (src/lib/status-transitions.ts).
 */
export type NotificationType =
  | "report_created"
  | "ai_analysis_completed"
  | "report_assigned"
  | "status_changed"
  | "report_resolved"
  | "reminder_due"
  | "critical_issue"
  | "follow_up_recorded"
  | "resolution_feedback_recorded"
  | "issue_reopened";

export type NotificationPriority = "low" | "normal" | "high" | "critical";

/**
 * The discretionary categories a user can turn off (src/lib/notifications/
 * preferences.ts). Every NotificationType maps to exactly one. There is no
 * "system" category to expose here because this app has no discretionary
 * system-alert notification type yet — only genuinely per-type categories
 * a user would plausibly want to mute.
 */
export type NotificationCategory = "report_updates" | "critical_issues" | "follow_ups" | "resolution_updates";

export const CATEGORY_BY_TYPE: Record<NotificationType, NotificationCategory> = {
  report_created: "report_updates",
  ai_analysis_completed: "report_updates",
  report_assigned: "report_updates",
  status_changed: "report_updates",
  report_resolved: "resolution_updates",
  reminder_due: "follow_ups",
  critical_issue: "critical_issues",
  follow_up_recorded: "follow_ups",
  resolution_feedback_recorded: "resolution_updates",
  issue_reopened: "resolution_updates",
};

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  report_updates: "Report updates (created, AI analysis, routing, status changes)",
  critical_issues: "Critical issue alerts",
  follow_ups: "Follow-up notes recorded by government (scheduled reminders are always delivered)",
  resolution_updates: "Resolution updates",
};
