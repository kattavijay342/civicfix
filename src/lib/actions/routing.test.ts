import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { routeReport, resolveAssignment } from "./routing";
import { makeFakeClient, forceNextError, clearForcedErrors, type FakeDb } from "../../../test/fake-supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

const NARASARAOPET = {
  state: "Andhra Pradesh",
  district: "Palnadu",
  constituency: "Narasaraopet",
  area: "Narasaraopet Municipality",
};
const TENALI_SCOPE = {
  gov_state: "Andhra Pradesh",
  gov_district: "Guntur",
  gov_constituency: "Tenali",
  gov_area: "Tenali Municipality",
};
const NARASARAOPET_SCOPE = {
  gov_state: NARASARAOPET.state,
  gov_district: NARASARAOPET.district,
  gov_constituency: NARASARAOPET.constituency,
  gov_area: NARASARAOPET.area,
};

function inchargeRow(profile_id: string, department_id: string, scope: Record<string, string | null>, is_active = true) {
  return { profile_id, department_id, is_active, created_at: "2026-09-01T00:00:00Z", ...scope };
}
function inchargeProfile(id: string, department_id: string, role = "department_incharge") {
  return { id, role, department_id, notification_preferences: null };
}

let db: FakeDb;
let admin: SupabaseClient;

beforeEach(() => {
  db = {
    departments: [
      { id: "dept-roads", name: "Roads & Infrastructure" },
      { id: "dept-water", name: "Water Supply" },
    ],
    department_incharges: [
      inchargeRow("roads-narasaraopet", "dept-roads", NARASARAOPET_SCOPE),
      inchargeRow("roads-tenali", "dept-roads", TENALI_SCOPE),
      inchargeRow("water-narasaraopet", "dept-water", NARASARAOPET_SCOPE),
    ],
    profiles: [
      inchargeProfile("roads-narasaraopet", "dept-roads"),
      inchargeProfile("roads-tenali", "dept-roads"),
      inchargeProfile("water-narasaraopet", "dept-water"),
    ],
    reports: [{ id: "report-1", status: "reported" }],
    report_assignments: [],
    status_history: [],
    notifications: [],
  };
  admin = makeFakeClient(db, { report_assignments: ["report_id"] }) as unknown as SupabaseClient;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  clearForcedErrors();
  vi.restoreAllMocks();
});

const roadsInput = {
  reportId: "report-1",
  title: "Large pothole near RTC Bus Stand",
  categoryLabel: "Road / Pothole",
  category: "ROAD" as const,
  priority: "high",
  location: NARASARAOPET,
};

describe("routeReport — valid assignment", () => {
  it("routes a Narasaraopet pothole to the Narasaraopet Roads in-charge only", async () => {
    const result = await routeReport(admin, roadsInput);

    expect(result).toMatchObject({
      outcome: "routed",
      departmentId: "dept-roads",
      inchargeId: "roads-narasaraopet",
      basis: "category_mapping",
    });
    expect(db.report_assignments).toHaveLength(1);
    expect(db.report_assignments[0]).toMatchObject({
      report_id: "report-1",
      department_id: "dept-roads",
      incharge_id: "roads-narasaraopet",
      assignment_method: "auto",
    });
    expect(db.reports[0].status).toBe("routed");
    expect(db.status_history[0]).toMatchObject({ old_status: "reported", new_status: "routed" });
    expect(String(db.status_history[0].notes)).toContain("configured category mapping");
  });

  it("routes with no AI input at all, and with no priority yet (AI runs afterwards)", async () => {
    const result = await routeReport(admin, { ...roadsInput, priority: null });
    expect(result).toMatchObject({ outcome: "routed", departmentId: "dept-roads", inchargeId: "roads-narasaraopet" });
    expect(db.notifications[0]).toMatchObject({ recipient_id: "roads-narasaraopet", priority: "normal" });
  });

  it("routes a legacy report left at ai_analyzed, logging its real previous status", async () => {
    db.reports[0].status = "ai_analyzed";
    await routeReport(admin, roadsInput);
    expect(db.reports[0].status).toBe("routed");
    expect(db.status_history[0]).toMatchObject({ old_status: "ai_analyzed", new_status: "routed" });
  });

  it("notifies exactly the assigned in-charge, in-app, with no citizen data", async () => {
    await routeReport(admin, roadsInput);

    expect(db.notifications).toHaveLength(1);
    const n = db.notifications[0];
    expect(n).toMatchObject({
      recipient_id: "roads-narasaraopet",
      type: "report_assigned",
      title: "New issue assigned to your department",
      related_report_id: "report-1",
      channel: "in_app",
      action_url: "/reports/report-1",
      priority: "high",
    });
    expect(n.body).toContain("Narasaraopet Municipality");
    expect(n.body).toContain("high priority");
  });

  it("does not pick a same-jurisdiction in-charge of the wrong department", async () => {
    // Remove the Roads in-charge: the Water in-charge in the same area must NOT inherit it.
    db.department_incharges = db.department_incharges.filter((r) => r.profile_id !== "roads-narasaraopet");
    const result = await routeReport(admin, roadsInput);

    expect(result).toMatchObject({ outcome: "routed", departmentId: "dept-roads", inchargeId: null });
    expect(db.report_assignments[0].incharge_id).toBeNull();
    expect(db.notifications).toHaveLength(0);
  });

  it("does not pick a same-department in-charge from another jurisdiction", async () => {
    const tenali = await resolveAssignment(
      admin,
      { category: "ROAD" },
      NARASARAOPET
    );
    expect(tenali).toMatchObject({ ok: true, inchargeId: "roads-narasaraopet" });

    db.department_incharges = db.department_incharges.filter((r) => r.profile_id !== "roads-narasaraopet");
    const withoutLocal = await resolveAssignment(
      admin,
      { category: "ROAD" },
      NARASARAOPET
    );
    expect(withoutLocal).toMatchObject({ ok: true, departmentId: "dept-roads", inchargeId: null });
  });

  it("ignores inactive rows and accounts no longer in-charge of that department", async () => {
    db.department_incharges[0].is_active = false;
    let r = await resolveAssignment(admin, { category: "ROAD" }, NARASARAOPET);
    expect(r).toMatchObject({ ok: true, inchargeId: null });

    db.department_incharges[0].is_active = true;
    db.profiles[0].role = "citizen"; // demoted, stale routing row left behind
    r = await resolveAssignment(admin, { category: "ROAD" }, NARASARAOPET);
    expect(r).toMatchObject({ ok: true, inchargeId: null });

    db.profiles[0].role = "department_incharge";
    db.profiles[0].department_id = "dept-water"; // moved to another department
    r = await resolveAssignment(admin, { category: "ROAD" }, NARASARAOPET);
    expect(r).toMatchObject({ ok: true, inchargeId: null });
  });
});

describe("routeReport — invalid / unknown department", () => {
  it("a water leakage report routes to Water Supply, never to Roads", async () => {
    const result = await routeReport(admin, { ...roadsInput, category: "WATER_LEAKAGE" });
    expect(result).toMatchObject({ outcome: "routed", departmentId: "dept-water", basis: "category_mapping" });
    expect(db.notifications.map((n) => n.recipient_id)).toEqual(["water-narasaraopet"]);
  });

  it("leaves the report unrouted (reported) when no configured department fits — nothing invented", async () => {
    db.departments = db.departments.filter((d) => d.id !== "dept-roads");
    const result = await routeReport(admin, roadsInput);

    expect(result).toEqual({ outcome: "unresolved", reason: "department_not_configured" });
    expect(db.report_assignments).toHaveLength(0);
    expect(db.reports[0].status).toBe("reported");
    expect(db.status_history).toHaveLength(0);
    expect(db.notifications).toHaveLength(0);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("routeReport — duplicate side-effect prevention", () => {
  it("a second routing run is a no-op: no second assignment, status row, or notification", async () => {
    await routeReport(admin, roadsInput);
    db.reports[0].status = "reported"; // simulate a racing run that read the old status
    const second = await routeReport(admin, roadsInput);

    expect(second).toEqual({ outcome: "already_routed" });
    expect(db.report_assignments).toHaveLength(1);
    expect(db.status_history).toHaveLength(1);
    expect(db.notifications).toHaveLength(1);
  });

  it("never re-notifies an in-charge who already has the assignment notification", async () => {
    db.notifications.push({ id: "n0", recipient_id: "roads-narasaraopet", type: "report_assigned", related_report_id: "report-1" });
    await routeReport(admin, roadsInput);
    expect(db.notifications).toHaveLength(1);
  });

  it("does not claim success when the assignment insert fails", async () => {
    forceNextError("report_assignments", "connection reset");
    const result = await routeReport(admin, roadsInput);

    expect(result).toEqual({ outcome: "failed" });
    expect(db.reports[0].status).toBe("reported");
    expect(db.status_history).toHaveLength(0);
    expect(db.notifications).toHaveLength(0);
  });

  it("never moves a report backwards if it already advanced past routed", async () => {
    db.reports[0].status = "acknowledged";
    await routeReport(admin, roadsInput);
    expect(db.reports[0].status).toBe("acknowledged");
    expect(db.status_history).toHaveLength(0);
  });
});
