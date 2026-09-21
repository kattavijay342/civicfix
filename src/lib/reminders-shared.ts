/** Types/constants shared between server code (src/lib/reminders.ts,
 * src/lib/actions/reminders.ts) and client components (ReminderForm,
 * ReminderRow) — kept free of "server-only"/supabase-js imports so client
 * bundles can pull it in directly. */

export type ReminderStatus = "scheduled" | "processing" | "sent" | "failed" | "cancelled";

export const REMINDER_TITLE_MAX = 150;
export const REMINDER_MESSAGE_MAX = 1000;
