import { describe, it, expect } from "vitest";
import { buildReportAssignedNotification, notifyInchargeOfAssignment } from "./report-assigned";
import { makeFakeClient, type FakeDb } from "../../../test/fake-supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

const input = {
  reportId: "report-1",
  inchargeId: "incharge-1",
  title: "Large pothole near RTC Bus Stand",
  categoryLabel: "Road / Pothole",
  departmentName: "Roads & Infrastructure",
  priority: "critical",
  jurisdiction: {
    state: "Andhra Pradesh",
    district: "Palnadu",
    constituency: "Narasaraopet",
    area: "Narasaraopet Municipality",
  },
};

describe("buildReportAssignedNotification", () => {
  it("carries report id, category, priority, jurisdiction and a link — nothing about the citizen", () => {
    const n = buildReportAssignedNotification(input);
    expect(n.title).toBe("New issue assigned to your department");
    expect(n.body).toBe(
      '"Large pothole near RTC Bus Stand" — Road / Pothole in Narasaraopet Municipality, Narasaraopet · critical priority. Routed to Roads & Infrastructure.'
    );
    expect(n.actionUrl).toBe("/reports/report-1");
    expect(n.priority).toBe("critical");
    expect(n.metadata).toMatchObject({ event: "REPORT_ASSIGNED", report_id: "report-1", priority: "critical" });
    expect(JSON.stringify(n)).not.toMatch(/reporter|mobile|phone|full_name/i);
  });

  it("omits priority text when AI priority is unknown", () => {
    const n = buildReportAssignedNotification({ ...input, priority: null });
    expect(n.body).not.toContain("priority");
    expect(n.priority).toBe("normal");
  });
});

describe("notifyInchargeOfAssignment", () => {
  it("sends once, and never a duplicate for the same in-charge + report", async () => {
    const db: FakeDb = { profiles: [{ id: "incharge-1", notification_preferences: null }], notifications: [] };
    const admin = makeFakeClient(db) as unknown as SupabaseClient;

    expect(await notifyInchargeOfAssignment(admin, input)).toBe(true);
    expect(await notifyInchargeOfAssignment(admin, input)).toBe(false);
    expect(db.notifications).toHaveLength(1);
    expect(db.notifications[0]).toMatchObject({ recipient_id: "incharge-1", type: "report_assigned", channel: "in_app" });
  });
});
