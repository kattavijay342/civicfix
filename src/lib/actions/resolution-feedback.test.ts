import { describe, it, expect } from "vitest";
import { performSubmitFeedback } from "./resolution-feedback";
import { makeFakeClient, forceNextError, clearForcedErrors, type FakeDb } from "../../../test/fake-supabase";

function baseDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    profiles: [{ id: "incharge-1", notification_preferences: null }],
    resolution_feedback: [],
    report_assignments: [{ id: "a1", report_id: "report-1", incharge_id: "incharge-1" }],
    report_locations: [],
    reports: [{ id: "report-1", status: "resolved" }],
    status_history: [],
    notifications: [],
    ...overrides,
  };
}

const report = { title: "Pothole near bus stand", reporter_id: "citizen-1" };

describe("performSubmitFeedback", () => {
  it("records a confirmed=true feedback without changing report status", async () => {
    const db = baseDb();
    const client = makeFakeClient(db);

    const result = await performSubmitFeedback(client as never, "report-1", report, "citizen-1", true, null);

    expect(result).toEqual({ success: true, reopened: false });
    expect(db.resolution_feedback).toHaveLength(1);
    expect(db.resolution_feedback[0]).toMatchObject({ report_id: "report-1", citizen_id: "citizen-1", confirmed: true });
    expect(db.reports[0].status).toBe("resolved");
    expect(db.status_history).toHaveLength(1);
    expect(db.status_history[0]).toMatchObject({ new_status: "resolved", changed_by: "citizen-1" });
  });

  it("notifies the assigned in-charge when feedback confirms resolution", async () => {
    const db = baseDb();
    const client = makeFakeClient(db);

    await performSubmitFeedback(client as never, "report-1", report, "citizen-1", true, null);

    expect(db.notifications).toHaveLength(1);
    expect(db.notifications[0]).toMatchObject({ recipient_id: "incharge-1", type: "resolution_feedback_recorded" });
  });

  it("reopens the report and sets reopened_at when confirmed=false", async () => {
    const db = baseDb();
    const client = makeFakeClient(db);

    const result = await performSubmitFeedback(
      client as never,
      "report-1",
      report,
      "citizen-1",
      false,
      "Still broken"
    );

    expect(result).toEqual({ success: true, reopened: true });
    expect(db.reports[0].status).toBe("reopened");
    expect(db.reports[0].reopened_at).toBeTruthy();
    expect(db.status_history[0].new_status).toBe("reopened");
  });

  it("notifies the in-charge AND jurisdiction government users on reopen", async () => {
    const db = baseDb({
      profiles: [
        { id: "incharge-1", notification_preferences: null },
        { id: "gov-1", role: "government", gov_state: "Andhra Pradesh", gov_district: null, gov_constituency: null, gov_area: null, notification_preferences: null },
      ],
      report_locations: [{ report_id: "report-1", state: "Andhra Pradesh", district: "Palnadu", constituency: "Narasaraopet", area: "Narasaraopet Municipality" }],
    });
    const client = makeFakeClient(db);

    await performSubmitFeedback(client as never, "report-1", report, "citizen-1", false, null);

    const types = db.notifications.map((n) => n.type);
    const recipients = db.notifications.map((n) => n.recipient_id);
    expect(types).toEqual(["issue_reopened", "issue_reopened"]);
    expect(recipients.sort()).toEqual(["gov-1", "incharge-1"]);
  });

  it("edits existing feedback in place instead of creating a duplicate row", async () => {
    const db = baseDb({
      resolution_feedback: [{ id: "fb-1", report_id: "report-1", citizen_id: "citizen-1", confirmed: true, comment: null }],
    });
    const client = makeFakeClient(db);

    await performSubmitFeedback(client as never, "report-1", report, "citizen-1", false, "Actually not fixed");

    expect(db.resolution_feedback).toHaveLength(1);
    expect(db.resolution_feedback[0]).toMatchObject({ id: "fb-1", confirmed: false, comment: "Actually not fixed" });
  });

  it("never throws and returns an error when the feedback write fails", async () => {
    const db = baseDb();
    const client = makeFakeClient(db);
    forceNextError("resolution_feedback", "simulated failure");

    const result = await performSubmitFeedback(client as never, "report-1", report, "citizen-1", true, null);

    expect(result).toEqual({ error: "Unable to save your feedback. Please try again." });
    clearForcedErrors();
  });
});
