import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ReminderStatus } from "@/lib/reminders-shared";
import { getEffectiveAssignments } from "@/lib/data/incharge-access";

export interface ReminderView {
  id: string;
  title: string;
  message: string;
  scheduledAt: string;
  status: ReminderStatus;
  createdByName: string | null;
  /** Only while the recipient is still the report's effective in-charge —
   * a deactivated/moved predecessor is never named (G6 privacy). */
  recipientName: string | null;
  /** The recipient is no longer the report's effective in-charge. */
  recipientIsFormer: boolean;
  createdAt: string;
  sentAt: string | null;
  /** When the recipient opened the delivered in-app notification — the
   * only "response" the data model actually records for a reminder. */
  seenAt: string | null;
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
export async function getReportReminders(
  reportId: string,
  callerId: string,
  effectiveInchargeId: string | null
): Promise<ReminderView[]> {
  const supabase = await createClient();
  const { data: reminders } = await supabase
    .from("reminders")
    .select("*")
    .eq("report_id", reportId)
    .order("scheduled_at", { ascending: false });

  if (!reminders || reminders.length === 0) return [];

  const admin = createAdminClient();
  const profileIds = [...new Set(reminders.flatMap((r) => [r.created_by, r.recipient_id]))];
  const notificationIds = reminders.map((r) => r.notification_id).filter((id): id is string => !!id);
  const [{ data: profiles }, { data: notifications }] = await Promise.all([
    admin.from("profiles").select("id, full_name").in("id", profileIds),
    notificationIds.length
      ? admin.from("notifications").select("id, read_at").in("id", notificationIds)
      : Promise.resolve({ data: [] as Array<{ id: string; read_at: string | null }> }),
  ]);
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));
  const readAtById = new Map((notifications ?? []).map((n) => [n.id, n.read_at]));

  return reminders.map((r) => {
    const recipientIsFormer = r.recipient_id !== effectiveInchargeId;
    return {
      id: r.id,
      title: r.title,
      message: r.message,
      scheduledAt: r.scheduled_at,
      status: r.status as ReminderStatus,
      createdByName: nameById.get(r.created_by) ?? null,
      recipientName: recipientIsFormer ? null : (nameById.get(r.recipient_id) ?? null),
      recipientIsFormer,
      createdAt: r.created_at,
      sentAt: r.sent_at,
      seenAt: (r.notification_id && readAtById.get(r.notification_id)) || null,
      failureReason: r.failure_reason,
      isOwnCreation: r.created_by === callerId,
    };
  });
}

// ============================================================
// G6 — department in-charge's "Government follow-ups" inbox.
// ============================================================

export interface DepartmentFollowUpItem {
  id: string;
  reportId: string;
  reportTitle: string;
  reportStatus: string | null;
  title: string;
  message: string;
  senderName: string | null;
  sentAt: string;
}

/**
 * Delivered follow-ups addressed to this in-charge, on reports they are
 * still EFFECTIVELY assigned (G4). The report-id restriction is part of
 * the query itself — rows for a stale assignment are never fetched — and
 * the read goes through the caller's RLS session (reminders_select /
 * reports_select). Only `sent` rows: a scheduled reminder reaches the
 * in-charge at its due time, not before. `admin` resolves sender names only.
 */
export async function loadDepartmentFollowUps(
  readClient: Pick<SupabaseClient, "from">,
  admin: Pick<SupabaseClient, "from">,
  userId: string,
  effectiveReportIds: string[],
  limit = 10
): Promise<DepartmentFollowUpItem[]> {
  if (effectiveReportIds.length === 0) return [];

  const { data: rows } = await readClient
    .from("reminders")
    .select("id, report_id, created_by, title, message, sent_at")
    .eq("recipient_id", userId)
    .eq("status", "sent")
    .in("report_id", effectiveReportIds)
    .order("sent_at", { ascending: false })
    .limit(limit);
  if (!rows || rows.length === 0) return [];

  const [{ data: reports }, { data: senders }] = await Promise.all([
    readClient.from("reports").select("id, title, status").in("id", [...new Set(rows.map((r) => r.report_id))]),
    admin.from("profiles").select("id, full_name").in("id", [...new Set(rows.map((r) => r.created_by))]),
  ]);
  const reportById = new Map((reports ?? []).map((r) => [r.id, r]));
  const senderById = new Map((senders ?? []).map((p) => [p.id, p.full_name]));

  return rows.map((r) => ({
    id: r.id,
    reportId: r.report_id,
    reportTitle: reportById.get(r.report_id)?.title ?? "Report",
    reportStatus: reportById.get(r.report_id)?.status ?? null,
    title: r.title,
    message: r.message,
    senderName: senderById.get(r.created_by) ?? null,
    sentAt: r.sent_at,
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
  const [{ data: reports }, { data: profiles }, effective] = await Promise.all([
    admin.from("reports").select("id, title").in("id", reportIds),
    admin.from("profiles").select("id, full_name").in("id", recipientIds),
    // G6 — one batched effective-assignment load per distinct recipient
    // (a handful of in-charges), so a deactivated/moved one isn't named.
    Promise.all(recipientIds.map(async (id) => [id, await getEffectiveAssignments(admin, id)] as const)),
  ]);
  const titleByReport = new Map((reports ?? []).map((r) => [r.id, r.title]));
  const nameByProfile = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));
  const effectivePairs = new Set(effective.flatMap(([id, rows]) => rows.map((a) => `${id}:${a.reportId}`)));

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
      recipientName: effectivePairs.has(`${r.recipient_id}:${r.report_id}`)
        ? (nameByProfile.get(r.recipient_id) ?? null)
        : null,
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
