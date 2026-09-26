import { describe, it, expect } from "vitest";
import { makeFakeClient, type FakeDb } from "../../../test/fake-supabase";
import { loadActionRequired } from "@/lib/data/action-required";

/**
 * G5 loader. `readClient` stands in for the caller's RLS-scoped session
 * (its tables hold only what reports_select/can_view_report would return);
 * `admin` holds everything. The live RLS boundary itself is proven by
 * scripts/verify-g5-action-required-live.mjs.
 */

const NOW = Date.parse("2026-09-26T06:30:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();
const NRT = { gov_state: "Andhra Pradesh", gov_district: "Palnadu", gov_constituency: "Narasaraopet", gov_area: "Narasaraopet Municipality" };
const NRT_LOC = { state: "Andhra Pradesh", district: "Palnadu", constituency: "Narasaraopet", area: "Narasaraopet Municipality" };

function report(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: `Report ${id}`, category: "road", status: "routed", priority: "low", severity: "low", created_at: daysAgo(1), updated_at: daysAgo(1), ...extra };
}

/** Admin fake that refuses report-scoped reads — the loader must take
 * those from the caller's session client only. */
function guardedAdmin(db: FakeDb) {
  const inner = makeFakeClient(db);
  return {
    from(table: string) {
      if (!["profiles", "department_incharges"].includes(table)) {
        throw new Error(`service-role read of ${table} is not allowed in the G5 loader`);
      }
      return inner.from(table);
    },
  };
}

function worlds() {
  const admin: FakeDb = {
    profiles: [
      { id: "incharge-a", role: "department_incharge", department_id: "dept-roads", full_name: "Roads In-charge", mobile_number: "+919876500003" },
      { id: "incharge-old", role: "department_incharge", department_id: "dept-roads", full_name: "Deactivated Person", mobile_number: "+919999999999" },
    ],
    department_incharges: [
      { profile_id: "incharge-a", department_id: "dept-roads", is_active: true, ...NRT },
      { profile_id: "incharge-old", department_id: "dept-roads", is_active: false, ...NRT },
    ],
  };
  const visible: FakeDb = {
    reports: [
      report("r-critical", { priority: "critical", severity: "critical" }),
      report("r-stale", { priority: "medium" }),
      report("r-fine"),
      report("r-unrouted", { status: "reported", priority: null, severity: null }),
      report("r-resolved", { status: "resolved", priority: "critical" }),
    ],
    report_locations: ["r-critical", "r-stale", "r-fine", "r-unrouted"].map((id) => ({ report_id: id, display_name: "RTC Bus Stand", ...NRT_LOC })),
    report_assignments: [
      { report_id: "r-critical", department_id: "dept-roads", incharge_id: "incharge-a", assigned_at: daysAgo(1) },
      { report_id: "r-stale", department_id: "dept-roads", incharge_id: "incharge-old", assigned_at: daysAgo(1) },
      { report_id: "r-fine", department_id: "dept-roads", incharge_id: "incharge-a", assigned_at: daysAgo(1) },
    ],
    departments: [{ id: "dept-roads", name: "Roads & Infrastructure" }],
    follow_ups: [],
    reminders: [],
  };
  return { admin, visible };
}

describe("G5 loadActionRequired", () => {
  it("classifies, orders and counts only reports the caller's session returned", async () => {
    const { admin, visible } = worlds();
    const data = await loadActionRequired(makeFakeClient(visible) as never, guardedAdmin(admin) as never, NOW);

    expect(data.unavailable).toBe(false);
    expect(data.unresolvedScanned).toBe(4); // resolved excluded
    // critical first; the other two tie on flags and age, so id decides.
    expect(data.items.map((i) => i.reportId)).toEqual(["r-critical", "r-stale", "r-unrouted"]);
    expect(data.items.find((i) => i.reportId === "r-fine")).toBeUndefined();
    expect(data.counts).toMatchObject({ actionRequired: 3, critical: 1, routingPending: 2, reopened: 0, followUpsDue: 0, pendingOver7Days: 0, awaitingAcknowledgement: 3 });
  });

  it("shows contact details only for an effective in-charge; a deactivated one is 'unavailable' with nothing exposed", async () => {
    const { admin, visible } = worlds();
    const data = await loadActionRequired(makeFakeClient(visible) as never, guardedAdmin(admin) as never, NOW);

    const critical = data.items.find((i) => i.reportId === "r-critical")!;
    expect(critical.incharge).toEqual({ name: "Roads In-charge", phone: "+919876500003" });
    expect(critical.inchargeState).toBe("assigned");

    const stale = data.items.find((i) => i.reportId === "r-stale")!;
    expect(stale.incharge).toBeNull();
    expect(stale.inchargeState).toBe("unavailable");
    expect(stale.reasonLabels).toContain("Department in-charge unavailable");
    expect(JSON.stringify(data)).not.toContain("Deactivated Person");
    expect(JSON.stringify(data)).not.toContain("+919999999999");
  });

  it("never leaks in-charge ids or internal profile ids into the item payload", async () => {
    const { admin, visible } = worlds();
    const data = await loadActionRequired(makeFakeClient(visible) as never, guardedAdmin(admin) as never, NOW);
    const payload = JSON.stringify(data.items);
    expect(payload).not.toContain("incharge-a");
    expect(payload).not.toContain("incharge-old");
    expect(payload).not.toContain("dept-roads");
  });

  it("a session that can see nothing (other jurisdiction / no scope) gets an honest empty result", async () => {
    const { admin } = worlds();
    const data = await loadActionRequired(makeFakeClient({}) as never, guardedAdmin(admin) as never, NOW);
    expect(data.items).toEqual([]);
    expect(Object.values(data.counts).every((v) => v === 0)).toBe(true);
    expect(data.unavailable).toBe(false);
  });
});
