import { describe, it, expect } from "vitest";
import { notifyGovernmentOfNewReport, buildNewReportNotification, type NewReportNotificationInput } from "./new-report";
import { makeFakeClient, type FakeDb } from "../../../test/fake-supabase";

const NARASARAOPET = {
  state: "Andhra Pradesh",
  district: "Palnadu",
  constituency: "Narasaraopet",
  area: "Narasaraopet Municipality",
};

function govProfile(id: string, scope: Partial<Record<"gov_state" | "gov_district" | "gov_constituency" | "gov_area", string | null>>) {
  return {
    id,
    role: "government",
    gov_state: null,
    gov_district: null,
    gov_constituency: null,
    gov_area: null,
    notification_preferences: null,
    ...scope,
  };
}

function baseDb(): FakeDb {
  return {
    profiles: [
      govProfile("gov-narasaraopet", {
        gov_state: "Andhra Pradesh",
        gov_district: "Palnadu",
        gov_constituency: "Narasaraopet",
        gov_area: "Narasaraopet Municipality",
      }),
      govProfile("gov-palnadu", { gov_state: "Andhra Pradesh", gov_district: "Palnadu" }),
      govProfile("gov-tenali", {
        gov_state: "Andhra Pradesh",
        gov_district: "Guntur",
        gov_constituency: "Tenali",
        gov_area: "Tenali Municipality",
      }),
      govProfile("gov-unscoped", {}),
      { id: "citizen-1", role: "citizen", notification_preferences: null },
    ],
    notifications: [],
  };
}

const input: NewReportNotificationInput = {
  reportId: "report-1",
  title: "Pothole on Main Road",
  category: "road",
  categoryLabel: "Road Damage",
  jurisdiction: NARASARAOPET,
  priority: "high",
};

describe("notifyGovernmentOfNewReport", () => {
  it("notifies only government users whose jurisdiction covers the report", async () => {
    const db = baseDb();
    const sent = await notifyGovernmentOfNewReport(makeFakeClient(db) as never, input);

    expect(sent).toBe(2);
    const recipients = db.notifications.map((n) => n.recipient_id).sort();
    expect(recipients).toEqual(["gov-narasaraopet", "gov-palnadu"]);
    expect(recipients).not.toContain("gov-tenali");
    expect(recipients).not.toContain("gov-unscoped");
    expect(recipients).not.toContain("citizen-1");
  });

  it("writes a report_created notification that links to the report", async () => {
    const db = baseDb();
    await notifyGovernmentOfNewReport(makeFakeClient(db) as never, input);
    expect(db.notifications[0]).toMatchObject({
      type: "report_created",
      title: "New issue reported in your jurisdiction",
      related_report_id: "report-1",
      action_url: "/reports/report-1",
      priority: "high",
      channel: "in_app",
    });
    expect(db.notifications[0].metadata).toEqual({
      event: "REPORT_CREATED",
      report_id: "report-1",
      jurisdiction: NARASARAOPET,
      priority: "high",
      category: "road",
    });
  });

  it("does not notify anyone for a report in an unrelated jurisdiction", async () => {
    const db = baseDb();
    const sent = await notifyGovernmentOfNewReport(makeFakeClient(db) as never, {
      ...input,
      jurisdiction: { state: "Telangana", district: "Hyderabad", constituency: "Secunderabad", area: "Ward 1" },
    });
    expect(sent).toBe(0);
    expect(db.notifications).toHaveLength(0);
  });

  it("skips critical reports (they already get the critical_issue alert)", async () => {
    const db = baseDb();
    const sent = await notifyGovernmentOfNewReport(makeFakeClient(db) as never, { ...input, priority: "critical" });
    expect(sent).toBe(0);
    expect(db.notifications).toHaveLength(0);
  });

  it("respects a government user's report_updates opt-out", async () => {
    const db = baseDb();
    db.profiles[0].notification_preferences = { report_updates: false };
    await notifyGovernmentOfNewReport(makeFakeClient(db) as never, input);
    expect(db.notifications.map((n) => n.recipient_id)).toEqual(["gov-palnadu"]);
  });
});

describe("buildNewReportNotification", () => {
  it("never guesses a priority when AI analysis didn't produce one", () => {
    const msg = buildNewReportNotification({ ...input, priority: null });
    expect(msg.priority).toBe("normal");
    expect(msg.metadata.priority).toBeNull();
    expect(msg.body).not.toMatch(/priority/);
  });

  it("contains no citizen identity", () => {
    const serialized = JSON.stringify(buildNewReportNotification(input));
    expect(serialized).not.toMatch(/reporter|mobile|phone|email|full_name/i);
  });
});
