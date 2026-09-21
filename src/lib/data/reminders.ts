import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ReminderStatus } from "@/lib/reminders-shared";

export interface ReminderView {
  id: string;
  title: string;
  message: string;
  scheduledAt: string;
  status: ReminderStatus;
  createdByName: string | null;
  recipientName: string | null;
  createdAt: string;
  sentAt: string | null;
  failureReason: string | null;
  isOwnCreation: boolean;
}

/**
 * Reminders for a single report. Relies entirely on the `reminders_select`
 * RLS policy for the authorization boundary (creator, recipient, admin, any
 * government user who can already view the report, or the assigned
 * department in-charge) — the admin client below is only used afterwards,
 * to resolve display names for rows RLS already allowed this caller to see.
 */
export async function getReportReminders(reportId: string, callerId: string): Promise<ReminderView[]> {
  const supabase = await createClient();
  const { data: reminders } = await supabase
    .from("reminders")
    .select("*")
    .eq("report_id", reportId)
    .order("scheduled_at", { ascending: false });

  if (!reminders || reminders.length === 0) return [];

  const admin = createAdminClient();
  const profileIds = [...new Set(reminders.flatMap((r) => [r.created_by, r.recipient_id]))];
  const { data: profiles } = await admin.from("profiles").select("id, full_name").in("id", profileIds);
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));

  return reminders.map((r) => ({
    id: r.id,
    title: r.title,
    message: r.message,
    scheduledAt: r.scheduled_at,
    status: r.status as ReminderStatus,
    createdByName: nameById.get(r.created_by) ?? null,
    recipientName: nameById.get(r.recipient_id) ?? null,
    createdAt: r.created_at,
    sentAt: r.sent_at,
    failureReason: r.failure_reason,
    isOwnCreation: r.created_by === callerId,
  }));
}

// ============================================================
// Phase 6E — jurisdiction-wide Follow-up Center. Reuses the EXISTING
// reminders_select RLS policy (supabase/migrations/0004_reminders.sql) —
// "created_by = me OR recipient_id = me OR admin OR (government AND
// can_view_report) OR (department_incharge AND assigned_to_me)" — exactly
// as getReportReminders() above already does, just querying across every
// report the caller can see instead of one. No new jurisdiction logic.
// ============================================================

export interface FollowUpCenterItem {
  id: string;
  reportId: string;
  reportTitle: string;
  title: string;
  scheduledAt: string;
  status: ReminderStatus;
  recipientName: string | null;
}

export interface FollowUpCenterGroups {
  dueToday: FollowUpCenterItem[];
  overdue: FollowUpCenterItem[];
  upcoming: FollowUpCenterItem[];
  completed: FollowUpCenterItem[];
}

/** Real UTC bounds for "today" in IST (fixed UTC+5:30, no DST) — same
 * calendar-day convention already used for notification grouping
 * (src/app/notifications/page.tsx's groupByDay). Duplicated locally rather
 * than extracted to a shared module — this codebase already has a few
 * small, intentionally-duplicated helpers like this one (e.g.
 * DepartmentActionsPanel's own STATUS_ORDER copy). */
function istTodayEndUtc(): string {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  const startMs = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()) - IST_OFFSET_MS;
  return new Date(startMs + 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Every reminder visible to the caller (bounded to the 100 soonest-due/
 * most-recent), grouped into Due today / Overdue / Upcoming / Completed.
 * "Overdue" is legitimate here — unlike the fabricated SLA metric
 * (src/lib/data/government.ts) — because `scheduled_at` is a real,
 * explicitly-chosen due time the creator set (src/lib/actions/reminders.ts),
 * not an invented one: a still-`scheduled` reminder whose time has already
 * passed genuinely is overdue.
 */
export async function getFollowUpCenter(): Promise<FollowUpCenterGroups> {
  const supabase = await createClient();
  const { data: reminders } = await supabase
    .from("reminders")
    .select("*")
    .order("scheduled_at", { ascending: true })
    .limit(100);

  if (!reminders || reminders.length === 0) {
    return { dueToday: [], overdue: [], upcoming: [], completed: [] };
  }

  const admin = createAdminClient();
  const reportIds = [...new Set(reminders.map((r) => r.report_id))];
  const recipientIds = [...new Set(reminders.map((r) => r.recipient_id))];
  const [{ data: reports }, { data: profiles }] = await Promise.all([
    admin.from("reports").select("id, title").in("id", reportIds),
    admin.from("profiles").select("id, full_name").in("id", recipientIds),
  ]);
  const titleByReport = new Map((reports ?? []).map((r) => [r.id, r.title]));
  const nameByProfile = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));

  const todayEnd = istTodayEndUtc();
  const nowIso = new Date().toISOString();

  const groups: FollowUpCenterGroups = { dueToday: [], overdue: [], upcoming: [], completed: [] };
  for (const r of reminders) {
    const item: FollowUpCenterItem = {
      id: r.id,
      reportId: r.report_id,
      reportTitle: titleByReport.get(r.report_id) ?? "Report",
      title: r.title,
      scheduledAt: r.scheduled_at,
      status: r.status as ReminderStatus,
      recipientName: nameByProfile.get(r.recipient_id) ?? null,
    };

    if (r.status !== "scheduled") {
      groups.completed.push(item);
    } else if (r.scheduled_at < nowIso) {
      groups.overdue.push(item);
    } else if (r.scheduled_at < todayEnd) {
      groups.dueToday.push(item);
    } else {
      groups.upcoming.push(item);
    }
  }
  return groups;
}
