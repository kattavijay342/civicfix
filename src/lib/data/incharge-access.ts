import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateInchargeAccess, type InchargeAccess, type InchargeAccessInput } from "@/lib/incharge-access";

const SCOPE_COLUMNS = "department_id, is_active, gov_state, gov_district, gov_constituency, gov_area";
const LOCATION_COLUMNS = "report_id, state, district, constituency, area";

type InchargeRow = InchargeAccessInput["inchargeRows"][number];

async function loadInchargeBasics(admin: SupabaseClient, userId: string) {
  const [{ data: profile }, { data: rows }] = await Promise.all([
    admin.from("profiles").select("role, department_id").eq("id", userId).maybeSingle(),
    admin.from("department_incharges").select(SCOPE_COLUMNS).eq("profile_id", userId),
  ]);
  return { profile: profile ?? null, inchargeRows: (rows ?? []) as InchargeRow[] };
}

/**
 * Whether `userId` may currently act on (and view as an in-charge) this
 * report — the assignment AND the in-charge's live department/active/
 * jurisdiction standing (see evaluateInchargeAccess). Everything is read
 * fresh from the database with the service role; nothing comes from the
 * client. `userId` must be the authenticated session's own id.
 */
export async function checkInchargeAccess(
  admin: SupabaseClient,
  userId: string,
  reportId: string
): Promise<InchargeAccess> {
  const [basics, { data: assignment }, { data: location }] = await Promise.all([
    loadInchargeBasics(admin, userId),
    admin.from("report_assignments").select("incharge_id, department_id").eq("report_id", reportId).maybeSingle(),
    admin.from("report_locations").select(LOCATION_COLUMNS).eq("report_id", reportId).maybeSingle(),
  ]);
  return evaluateInchargeAccess({
    userId,
    profile: basics.profile,
    assignment: assignment ?? null,
    inchargeRows: basics.inchargeRows,
    location: location ?? null,
  });
}

export interface EffectiveAssignment {
  reportId: string;
  assignedAt: string;
}

/**
 * The report ids this in-charge is EFFECTIVELY assigned — every
 * report_assignments row naming them, minus any the in-charge no longer
 * qualifies for (moved department, deactivated, re-scoped). Newest
 * assignment first. Three batched queries regardless of list size.
 */
export async function getEffectiveAssignments(admin: SupabaseClient, userId: string): Promise<EffectiveAssignment[]> {
  const [basics, { data: assignments }] = await Promise.all([
    loadInchargeBasics(admin, userId),
    admin
      .from("report_assignments")
      .select("report_id, incharge_id, department_id, assigned_at")
      .eq("incharge_id", userId)
      .order("assigned_at", { ascending: false }),
  ]);
  const rows = assignments ?? [];
  if (rows.length === 0) return [];

  const { data: locations } = await admin
    .from("report_locations")
    .select(LOCATION_COLUMNS)
    .in(
      "report_id",
      rows.map((a) => a.report_id)
    );
  const locationByReport = new Map((locations ?? []).map((l) => [l.report_id, l]));

  return rows
    .filter(
      (a) =>
        evaluateInchargeAccess({
          userId,
          profile: basics.profile,
          assignment: a,
          inchargeRows: basics.inchargeRows,
          location: locationByReport.get(a.report_id) ?? null,
        }).ok
    )
    .map((a) => ({ reportId: a.report_id, assignedAt: a.assigned_at }));
}
