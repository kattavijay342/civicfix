import { evaluateInchargeAccess, type InchargeAccessInput } from "@/lib/incharge-access";

/**
 * G5 — Government "Action Required" classification.
 *
 * Pure (no I/O) so every queue rule and the ordering can be unit-tested;
 * the loader is src/lib/data/action-required.ts. Every rule reads a stored
 * fact — nothing here invents an SLA, an escalation level or a score.
 *
 * Only UNRESOLVED reports (status <> 'resolved') are ever classified. An
 * unresolved report needs action when ANY rule below matches:
 *
 *   critical            priority = 'critical' OR severity = 'critical'
 *   high_priority       priority = 'high' (and not already critical)
 *   follow_up_due       a reminder with status 'scheduled' and scheduled_at
 *                       before the end of today (IST), OR the report's most
 *                       recent follow_ups row has a next_follow_up_date on or
 *                       before today (IST)
 *   reopened            status = 'reopened' (citizen said the fix failed)
 *   pending_over_7_days whole days since created_at > 7 — the same boundary
 *                       as the existing aging buckets' "8–14 days" bucket
 *                       (src/lib/aging.ts)
 *   routing_pending     no report_assignments row, or a row with no in-charge
 *   incharge_unavailable the assigned in-charge is no longer EFFECTIVE —
 *                       deactivated, moved department, demoted or re-scoped
 *                       (G4's evaluateInchargeAccess, reused unchanged)
 */

export const PENDING_THRESHOLD_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export type ActionReason =
  | "critical"
  | "high_priority"
  | "follow_up_due"
  | "reopened"
  | "pending_over_7_days"
  | "routing_pending"
  | "incharge_unavailable";

/** The queues the command center shows as tiles/filters. routing_pending
 * covers both "never routed / no in-charge" and "in-charge unavailable" —
 * either way nobody effective currently owns the report. */
export type ActionQueue = "critical" | "pending_over_7_days" | "follow_up_due" | "reopened" | "routing_pending";
export const ACTION_QUEUES: readonly ActionQueue[] = [
  "critical",
  "pending_over_7_days",
  "follow_up_due",
  "reopened",
  "routing_pending",
];

export function isActionQueue(value: unknown): value is ActionQueue {
  return typeof value === "string" && (ACTION_QUEUES as readonly string[]).includes(value);
}

export function queuesFor(reasons: readonly ActionReason[]): ActionQueue[] {
  const queues = new Set<ActionQueue>();
  for (const r of reasons) {
    if (r === "critical") queues.add("critical");
    else if (r === "pending_over_7_days") queues.add("pending_over_7_days");
    else if (r === "follow_up_due") queues.add("follow_up_due");
    else if (r === "reopened") queues.add("reopened");
    else if (r === "routing_pending" || r === "incharge_unavailable") queues.add("routing_pending");
  }
  return ACTION_QUEUES.filter((q) => queues.has(q));
}

/** "Today" in IST (fixed UTC+5:30, no DST) — the same calendar-day
 * convention the existing Follow-up Center and notification grouping use. */
export function istToday(nowMs: number): { date: string; startIso: string; endIso: string } {
  const nowIst = new Date(nowMs + IST_OFFSET_MS);
  const startMs = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()) - IST_OFFSET_MS;
  return {
    date: nowIst.toISOString().slice(0, 10),
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(startMs + DAY_MS).toISOString(),
  };
}

export function wholeDaysSince(iso: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / DAY_MS));
}

export interface ReminderFact {
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  createdAt: string;
}

export interface FollowUpFact {
  followUpDate: string;
  nextFollowUpDate: string | null;
  status: string;
}

/** Everything the classifier needs about one report — all stored facts. */
export interface ActionCandidate {
  status: string;
  priority: string | null;
  severity: string | null;
  createdAt: string;
  updatedAt: string;
  assignment: { departmentId: string; inchargeId: string | null; assignedAt: string } | null;
  /** Result of G4's effective-assignment rule for the assigned in-charge;
   * ignored when there is no assignment or no in-charge. */
  inchargeEffective: boolean;
  reminders: ReminderFact[];
  followUps: FollowUpFact[];
}

export type FollowUpState =
  | { kind: "reminder_due"; at: string; overdue: boolean }
  | { kind: "follow_up_due"; on: string; overdue: boolean }
  | { kind: "reminder_scheduled"; at: string }
  | { kind: "reminder_sent"; at: string }
  | { kind: "follow_up_recorded"; at: string }
  | { kind: "none" };

export interface Classification {
  reasons: ActionReason[];
  ageDays: number;
  followUpState: FollowUpState;
  lastActivityAt: string;
}

/** Timestamps arrive as "…+00:00" from PostgREST but "…Z" from JS, so they
 * are always compared as epoch ms, never as strings. */
const ms = (iso: string) => new Date(iso).getTime();

function latestFollowUp(followUps: FollowUpFact[]): FollowUpFact | null {
  let latest: FollowUpFact | null = null;
  for (const f of followUps) if (!latest || ms(f.followUpDate) > ms(latest.followUpDate)) latest = f;
  return latest;
}

/** The single most useful follow-up fact for the card, most urgent first. */
export function followUpStateFor(candidate: Pick<ActionCandidate, "reminders" | "followUps">, nowMs: number): FollowUpState {
  const today = istToday(nowMs);
  const scheduled = candidate.reminders
    .filter((r) => r.status === "scheduled")
    .sort((a, b) => ms(a.scheduledAt) - ms(b.scheduledAt));
  const dueReminder = scheduled.find((r) => ms(r.scheduledAt) < ms(today.endIso));
  if (dueReminder) {
    return { kind: "reminder_due", at: dueReminder.scheduledAt, overdue: ms(dueReminder.scheduledAt) < nowMs };
  }

  // next_follow_up_date is a plain `date` ("YYYY-MM-DD"), so a string
  // comparison against today's IST date is exact.
  const latest = latestFollowUp(candidate.followUps);
  const nextDate = latest?.nextFollowUpDate?.slice(0, 10) ?? null;
  if (latest?.status === "pending" && nextDate && nextDate <= today.date) {
    return { kind: "follow_up_due", on: nextDate, overdue: nextDate < today.date };
  }

  if (scheduled[0]) return { kind: "reminder_scheduled", at: scheduled[0].scheduledAt };

  const lastSent = candidate.reminders
    .filter((r) => r.status === "sent" && r.sentAt)
    .sort((a, b) => ms(b.sentAt!) - ms(a.sentAt!))[0];
  const followUpAt = latest?.followUpDate ?? null;
  if (lastSent && (!followUpAt || ms(lastSent.sentAt!) >= ms(followUpAt))) return { kind: "reminder_sent", at: lastSent.sentAt! };
  if (followUpAt) return { kind: "follow_up_recorded", at: followUpAt };
  return { kind: "none" };
}

export function classifyCandidate(candidate: ActionCandidate, nowMs: number): Classification {
  const reasons: ActionReason[] = [];
  const ageDays = wholeDaysSince(candidate.createdAt, nowMs);
  const followUpState = followUpStateFor(candidate, nowMs);

  // Last recorded activity: the report row itself (status changes bump
  // updated_at), its routing, and any follow-up/reminder on it.
  const activityMs = [
    candidate.createdAt,
    candidate.updatedAt,
    candidate.assignment?.assignedAt,
    ...candidate.reminders.map((r) => r.sentAt ?? r.createdAt),
    ...candidate.followUps.map((f) => f.followUpDate),
  ]
    .filter((v): v is string => !!v)
    .map(ms);
  const lastActivityAt = new Date(Math.max(...activityMs)).toISOString();

  if (candidate.status === "resolved") return { reasons, ageDays, followUpState, lastActivityAt };

  const critical = candidate.priority === "critical" || candidate.severity === "critical";
  if (critical) reasons.push("critical");
  else if (candidate.priority === "high") reasons.push("high_priority");
  if (followUpState.kind === "reminder_due" || followUpState.kind === "follow_up_due") reasons.push("follow_up_due");
  if (candidate.status === "reopened") reasons.push("reopened");
  if (ageDays > PENDING_THRESHOLD_DAYS) reasons.push("pending_over_7_days");
  if (!candidate.assignment || !candidate.assignment.inchargeId) reasons.push("routing_pending");
  else if (!candidate.inchargeEffective) reasons.push("incharge_unavailable");

  return { reasons, ageDays, followUpState, lastActivityAt };
}

/**
 * Whether the assigned in-charge still effectively owns the report — G4's
 * evaluateInchargeAccess evaluated FOR the in-charge (not the caller), so a
 * deactivated/moved/demoted/re-scoped in-charge is never shown as valid or
 * sent a reminder.
 */
export function isInchargeEffective(input: {
  assignment: { incharge_id: string | null; department_id: string } | null;
  profile: InchargeAccessInput["profile"];
  inchargeRows: InchargeAccessInput["inchargeRows"];
  location: InchargeAccessInput["location"];
}): boolean {
  const inchargeId = input.assignment?.incharge_id;
  if (!inchargeId) return false;
  return evaluateInchargeAccess({ userId: inchargeId, ...input }).ok;
}

export interface SortableActionItem {
  reportId: string;
  reasons: readonly ActionReason[];
  createdAt: string;
}

/**
 * Deterministic precedence: critical → high priority → follow-up due →
 * reopened → oldest unresolved (created_at ascending, i.e. longest age) →
 * report id. Age IS created_at here (both measure the same timestamp), so
 * "longest unresolved" and "older created_at" collapse into one key; the
 * id is the final tiebreak so equal timestamps never reorder between loads.
 */
export function compareActionItems(a: SortableActionItem, b: SortableActionItem): number {
  const flags: ActionReason[] = ["critical", "high_priority", "follow_up_due", "reopened"];
  for (const flag of flags) {
    const diff = Number(b.reasons.includes(flag)) - Number(a.reasons.includes(flag));
    if (diff !== 0) return diff;
  }
  const at = new Date(a.createdAt).getTime();
  const bt = new Date(b.createdAt).getTime();
  if (at !== bt) return at - bt;
  return a.reportId < b.reportId ? -1 : a.reportId > b.reportId ? 1 : 0;
}

export interface ActionCounts {
  actionRequired: number;
  critical: number;
  pendingOver7Days: number;
  followUpsDue: number;
  reopened: number;
  routingPending: number;
  highPriority: number;
  /** Existing Phase 6E "Awaiting acknowledgement" fact (status = 'routed'),
   * preserved from the panel G5 replaces — informational, not a queue. */
  awaitingAcknowledgement: number;
}

export function countActionQueues(items: ReadonlyArray<{ reasons: readonly ActionReason[]; status: string }>): ActionCounts {
  const counts: ActionCounts = {
    actionRequired: 0,
    critical: 0,
    pendingOver7Days: 0,
    followUpsDue: 0,
    reopened: 0,
    routingPending: 0,
    highPriority: 0,
    awaitingAcknowledgement: 0,
  };
  for (const item of items) {
    if (item.status === "routed") counts.awaitingAcknowledgement += 1;
    if (item.reasons.length === 0) continue;
    counts.actionRequired += 1;
    const queues = queuesFor(item.reasons);
    if (queues.includes("critical")) counts.critical += 1;
    if (queues.includes("pending_over_7_days")) counts.pendingOver7Days += 1;
    if (queues.includes("follow_up_due")) counts.followUpsDue += 1;
    if (queues.includes("reopened")) counts.reopened += 1;
    if (queues.includes("routing_pending")) counts.routingPending += 1;
    if (item.reasons.includes("high_priority")) counts.highPriority += 1;
  }
  return counts;
}

/** Human "why" label for one reason — derived only from the same facts. */
export function reasonLabel(
  reason: ActionReason,
  ctx: { ageDays: number; status: string; followUpState: FollowUpState }
): string {
  switch (reason) {
    case "critical":
      return "Critical issue";
    case "high_priority":
      return "High priority";
    case "follow_up_due": {
      const s = ctx.followUpState;
      const overdue = (s.kind === "reminder_due" || s.kind === "follow_up_due") && s.overdue;
      return overdue ? "Follow-up overdue" : "Follow-up due today";
    }
    case "reopened":
      return "Reopened";
    case "pending_over_7_days":
      return `Pending for ${ctx.ageDays} days`;
    case "routing_pending":
      if (ctx.status === "reported") return "Routing pending — awaiting AI analysis";
      if (ctx.status === "ai_analyzed") return "Routing pending — no department matched";
      return "Unassigned — no in-charge";
    case "incharge_unavailable":
      return "Department in-charge unavailable";
  }
}
