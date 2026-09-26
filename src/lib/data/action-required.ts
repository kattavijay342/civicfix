import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { categoryFromDb, priorityFromDb, severityFromDb, statusFromDb } from "@/lib/db-enums";
import {
  classifyCandidate,
  compareActionItems,
  countActionQueues,
  isInchargeEffective,
  queuesFor,
  reasonLabel,
  type ActionCandidate,
  type ActionCounts,
  type ActionQueue,
  type ActionReason,
  type FollowUpState,
} from "@/lib/action-required";
import type { InchargeAccessInput } from "@/lib/incharge-access";
import type { IssueStatus, Priority, ProblemCategory } from "@/lib/types";

/**
 * G5 — the Government "Action Required" command center's data.
 *
 * Authorization: every report-scoped read goes through the CALLER's own
 * session client, so the existing reports_select / can_view_report RLS
 * (report_in_my_jurisdiction) decides which reports exist at all — nothing
 * here takes a jurisdiction, report id, department id or user id from the
 * client. The service-role client is used for exactly one thing: reading
 * the in-charge's profile/department_incharges standing (profiles RLS hides
 * other users from government accounts) for in-charges named on reports
 * RLS has ALREADY returned to this caller.
 *
 * Cost: a fixed number of batched queries (ids chunked to keep PostgREST
 * URLs short) regardless of how many reports qualify — never one query per
 * report.
 */

/** Hard ceiling on unresolved reports scanned per load. The page states
 * honestly when it was reached instead of silently dropping the rest. */
export const ACTION_SCAN_LIMIT = 500;
const ID_CHUNK = 150;

export interface ActionInchargeContact {
  name: string;
  phone: string | null;
}

export interface ActionRequiredItem {
  reportId: string;
  title: string;
  category: ProblemCategory;
  location: string;
  status: IssueStatus;
  priority: Priority | null;
  severity: Priority | null;
  department: string | null;
  /** Only ever set for an EFFECTIVE in-charge (see isInchargeEffective). */
  incharge: ActionInchargeContact | null;
  inchargeState: "assigned" | "unavailable" | "unassigned" | "not_routed";
  ageDays: number;
  createdAt: string;
  lastActivityAt: string;
  reasons: ActionReason[];
  reasonLabels: string[];
  queues: ActionQueue[];
  followUpState: FollowUpState;
}

export interface ActionRequiredData {
  items: ActionRequiredItem[];
  counts: ActionCounts;
  unresolvedScanned: number;
  truncated: boolean;
  /** true when the reports read itself failed — the UI then says so rather
   * than claiming "no action required". */
  unavailable: boolean;
}

async function inChunks<T>(ids: string[], run: (chunk: string[]) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  if (ids.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) chunks.push(ids.slice(i, i + ID_CHUNK));
  const results = await Promise.all(chunks.map((c) => run(c)));
  return results.flatMap((r) => r.data ?? []);
}

interface ReportRow {
  id: string;
  title: string;
  category: string;
  status: string;
  priority: string | null;
  severity: string | null;
  created_at: string;
  updated_at: string;
}
interface LocationRow {
  report_id: string;
  display_name: string;
  state: string | null;
  district: string | null;
  constituency: string | null;
  area: string | null;
}
interface AssignmentRow {
  report_id: string;
  department_id: string;
  incharge_id: string | null;
  assigned_at: string;
}
interface FollowUpRow {
  report_id: string;
  follow_up_date: string;
  next_follow_up_date: string | null;
  status: string;
}
interface ReminderRow {
  report_id: string;
  status: string;
  scheduled_at: string;
  sent_at: string | null;
  created_at: string;
}
interface InchargeProfileRow {
  id: string;
  role: string;
  department_id: string | null;
  full_name: string | null;
  mobile_number: string | null;
}
type InchargeScopeRow = InchargeAccessInput["inchargeRows"][number] & { profile_id: string };

export async function getActionRequired(nowMs: number = Date.now()): Promise<ActionRequiredData> {
  const supabase = await createClient();
  return loadActionRequired(supabase, createAdminClient(), nowMs);
}

/** Exported for the loader's own tests; production callers use
 * getActionRequired(). `readClient` MUST be the caller's session client. */
export async function loadActionRequired(
  readClient: SupabaseClient,
  admin: SupabaseClient,
  nowMs: number
): Promise<ActionRequiredData> {
  const { data: reportData, error } = await readClient
    .from("reports")
    .select("id, title, category, status, priority, severity, created_at, updated_at")
    .neq("status", "resolved")
    .order("created_at", { ascending: true })
    .limit(ACTION_SCAN_LIMIT + 1);

  if (error) {
    console.error("action-required reports read failed", error);
    return { items: [], counts: countActionQueues([]), unresolvedScanned: 0, truncated: false, unavailable: true };
  }

  const truncated = (reportData ?? []).length > ACTION_SCAN_LIMIT;
  const reports = ((reportData ?? []) as ReportRow[]).slice(0, ACTION_SCAN_LIMIT);
  const ids = reports.map((r) => r.id);

  const [locations, assignments, followUps, reminders, departmentsRes] = await Promise.all([
    inChunks<LocationRow>(ids, (c) =>
      readClient.from("report_locations").select("report_id, display_name, state, district, constituency, area").in("report_id", c)
    ),
    inChunks<AssignmentRow>(ids, (c) =>
      readClient.from("report_assignments").select("report_id, department_id, incharge_id, assigned_at").in("report_id", c)
    ),
    inChunks<FollowUpRow>(ids, (c) =>
      readClient.from("follow_ups").select("report_id, follow_up_date, next_follow_up_date, status").in("report_id", c)
    ),
    inChunks<ReminderRow>(ids, (c) =>
      readClient.from("reminders").select("report_id, status, scheduled_at, sent_at, created_at").in("report_id", c)
    ),
    readClient.from("departments").select("id, name"),
  ]);

  // In-charge standing — only for in-charges named on reports RLS already
  // returned. Service role because profiles RLS hides other users.
  const inchargeIds = [...new Set(assignments.map((a) => a.incharge_id).filter((v): v is string => !!v))];
  const [inchargeProfiles, inchargeScopes] = await Promise.all([
    inChunks<InchargeProfileRow>(inchargeIds, (c) =>
      admin.from("profiles").select("id, role, department_id, full_name, mobile_number").in("id", c)
    ),
    inChunks<InchargeScopeRow>(inchargeIds, (c) =>
      admin
        .from("department_incharges")
        .select("profile_id, department_id, is_active, gov_state, gov_district, gov_constituency, gov_area")
        .in("profile_id", c)
    ),
  ]);

  const locationBy = new Map(locations.map((l) => [l.report_id, l]));
  const assignmentBy = new Map(assignments.map((a) => [a.report_id, a]));
  const departmentName = new Map(((departmentsRes.data ?? []) as Array<{ id: string; name: string }>).map((d) => [d.id, d.name]));
  const profileBy = new Map(inchargeProfiles.map((p) => [p.id, p]));
  const scopesBy = new Map<string, InchargeScopeRow[]>();
  for (const s of inchargeScopes) scopesBy.set(s.profile_id, [...(scopesBy.get(s.profile_id) ?? []), s]);
  const group = <T extends { report_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.report_id, [...(m.get(r.report_id) ?? []), r]);
    return m;
  };
  const followUpsBy = group(followUps);
  const remindersBy = group(reminders);

  const classified = reports.map((r) => {
    const assignment = assignmentBy.get(r.id) ?? null;
    const location = locationBy.get(r.id) ?? null;
    const inchargeId = assignment?.incharge_id ?? null;
    const profile = inchargeId ? profileBy.get(inchargeId) ?? null : null;
    const effective = isInchargeEffective({
      assignment,
      profile: profile ? { role: profile.role, department_id: profile.department_id } : null,
      inchargeRows: inchargeId ? scopesBy.get(inchargeId) ?? [] : [],
      location,
    });

    const candidate: ActionCandidate = {
      status: r.status,
      priority: r.priority,
      severity: r.severity,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      assignment: assignment
        ? { departmentId: assignment.department_id, inchargeId: assignment.incharge_id, assignedAt: assignment.assigned_at }
        : null,
      inchargeEffective: effective,
      reminders: (remindersBy.get(r.id) ?? []).map((x) => ({
        status: x.status,
        scheduledAt: x.scheduled_at,
        sentAt: x.sent_at,
        createdAt: x.created_at,
      })),
      followUps: (followUpsBy.get(r.id) ?? []).map((f) => ({
        followUpDate: f.follow_up_date,
        nextFollowUpDate: f.next_follow_up_date,
        status: f.status,
      })),
    };
    const c = classifyCandidate(candidate, nowMs);

    const item: ActionRequiredItem = {
      reportId: r.id,
      title: r.title,
      category: categoryFromDb[r.category] ?? "OTHER",
      location: location?.display_name ?? "Location not recorded",
      status: statusFromDb[r.status],
      priority: r.priority ? priorityFromDb[r.priority] : null,
      severity: r.severity ? severityFromDb[r.severity] : null,
      department: assignment ? departmentName.get(assignment.department_id) ?? null : null,
      // Contact details only for an in-charge who still effectively owns
      // the report — never a stale/deactivated one.
      incharge: effective && profile ? { name: profile.full_name ?? "Name not on file", phone: profile.mobile_number } : null,
      inchargeState: !assignment ? "not_routed" : !inchargeId ? "unassigned" : effective ? "assigned" : "unavailable",
      ageDays: c.ageDays,
      createdAt: r.created_at,
      lastActivityAt: c.lastActivityAt,
      reasons: c.reasons,
      reasonLabels: c.reasons.map((reason) => reasonLabel(reason, { ageDays: c.ageDays, status: r.status, followUpState: c.followUpState })),
      queues: queuesFor(c.reasons),
      followUpState: c.followUpState,
    };
    return { item, status: r.status };
  });

  const counts = countActionQueues(classified.map(({ item, status }) => ({ reasons: item.reasons, status })));
  const items = classified
    .map(({ item }) => item)
    .filter((i) => i.reasons.length > 0)
    .sort(compareActionItems);

  return { items, counts, unresolvedScanned: reports.length, truncated, unavailable: false };
}
