import { describe, it, expect, afterEach } from "vitest";
import { processDueReminders, deliverReminderNow, REMINDER_MAX_ATTEMPTS } from "@/lib/reminders";
import { makeFakeClient, forceNextError, clearForcedErrors, type FakeDb } from "../../test/fake-supabase";

const HOUR = 60 * 60 * 1000;
const NRT_LOC = { state: "Andhra Pradesh", district: "Palnadu", constituency: "Narasaraopet", area: "Narasaraopet Municipality" };

function makeDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    reminders: [],
    profiles: [{ id: "recipient-1", full_name: "Incharge One", role: "department_incharge", department_id: "dept-1" }],
    reports: [{ id: "report-1", title: "Pothole on Main Road" }],
    notifications: [],
    // G5 — the recipient must still be the report's EFFECTIVE in-charge
    // (G4 rule) at send time.
    report_assignments: [{ report_id: "report-1", department_id: "dept-1", incharge_id: "recipient-1" }],
    report_locations: [{ report_id: "report-1", ...NRT_LOC }],
    department_incharges: [
      {
        profile_id: "recipient-1",
        department_id: "dept-1",
        is_active: true,
        gov_state: NRT_LOC.state,
        gov_district: NRT_LOC.district,
        gov_constituency: NRT_LOC.constituency,
        gov_area: NRT_LOC.area,
      },
    ],
    ...overrides,
  };
}

function dueReminder(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "reminder-1",
    report_id: "report-1",
    created_by: "gov-1",
    department_id: "dept-1",
    recipient_id: "recipient-1",
    title: "Confirm site visit",
    message: "Call the department",
    scheduled_at: new Date(Date.now() - HOUR).toISOString(),
    status: "scheduled",
    notification_id: null,
    attempt_count: 0,
    processed_at: null,
    sent_at: null,
    failure_reason: null,
    ...overrides,
  };
}

afterEach(() => clearForcedErrors());

describe("processDueReminders — due follow-up detection", () => {
  it("claims and sends a reminder whose scheduled_at is in the past", async () => {
    const db = makeDb({ reminders: [dueReminder()] });
    const summary = await processDueReminders(makeFakeClient(db) as never);

    expect(summary).toEqual({ claimed: 1, sent: 1, failedPermanently: 0, retried: 0 });
    expect(db.reminders[0].status).toBe("sent");
    expect(db.reminders[0].notification_id).toBeTruthy();
    expect(db.notifications).toHaveLength(1);
    expect(db.notifications[0].recipient_id).toBe("recipient-1");
    expect(db.notifications[0].type).toBe("reminder_due");
  });

  it("does not touch a reminder that is not yet due", async () => {
    const notYetDue = dueReminder({ id: "reminder-2", scheduled_at: new Date(Date.now() + HOUR).toISOString() });
    const db = makeDb({ reminders: [notYetDue] });
    const summary = await processDueReminders(makeFakeClient(db) as never);

    expect(summary.claimed).toBe(0);
    expect(db.reminders[0].status).toBe("scheduled");
    expect(db.notifications).toHaveLength(0);
  });
});

describe("processDueReminders — duplicate notification prevention", () => {
  it("never reclaims a reminder that is already processing/sent/failed/cancelled", async () => {
    const already = [
      dueReminder({ id: "r-processing", status: "processing" }),
      dueReminder({ id: "r-sent", status: "sent" }),
      dueReminder({ id: "r-failed", status: "failed" }),
      dueReminder({ id: "r-cancelled", status: "cancelled" }),
    ];
    const db = makeDb({ reminders: already });
    const summary = await processDueReminders(makeFakeClient(db) as never);

    expect(summary.claimed).toBe(0);
    expect(db.notifications).toHaveLength(0);
    // Statuses are exactly as before — the claim query's `status = 'scheduled'`
    // filter is what makes a second/concurrent run a no-op for these rows.
    expect(db.reminders.map((r) => r.status)).toEqual(["processing", "sent", "failed", "cancelled"]);
  });

  it("running processDueReminders twice in a row only ever sends one notification per reminder", async () => {
    const db = makeDb({ reminders: [dueReminder()] });
    const first = await processDueReminders(makeFakeClient(db) as never);
    const second = await processDueReminders(makeFakeClient(db) as never);

    expect(first.sent).toBe(1);
    expect(second.claimed).toBe(0);
    expect(second.sent).toBe(0);
    expect(db.notifications).toHaveLength(1);
  });
});

describe("processDueReminders — retry / backoff / permanent failure", () => {
  it("retries with a future scheduled_at when notification creation fails, below the attempt ceiling", async () => {
    const db = makeDb({ reminders: [dueReminder({ attempt_count: 0 })] });
    forceNextError("notifications", "simulated transient failure");
    const before = Date.now();
    const summary = await processDueReminders(makeFakeClient(db) as never);

    expect(summary).toEqual({ claimed: 1, sent: 0, failedPermanently: 0, retried: 1 });
    expect(db.reminders[0].status).toBe("scheduled");
    expect(db.reminders[0].attempt_count).toBe(1);
    expect(new Date(db.reminders[0].scheduled_at as string).getTime()).toBeGreaterThan(before);
  });

  it("fails permanently once REMINDER_MAX_ATTEMPTS is reached", async () => {
    const db = makeDb({ reminders: [dueReminder({ attempt_count: REMINDER_MAX_ATTEMPTS - 1 })] });
    forceNextError("notifications", "simulated transient failure");
    const summary = await processDueReminders(makeFakeClient(db) as never);

    expect(summary).toEqual({ claimed: 1, sent: 0, failedPermanently: 1, retried: 0 });
    expect(db.reminders[0].status).toBe("failed");
    expect(db.reminders[0].attempt_count).toBe(REMINDER_MAX_ATTEMPTS);
    expect(db.reminders[0].failure_reason).toBeTruthy();
  });

  it("fails permanently (without retry) when the recipient no longer exists", async () => {
    const db = makeDb({ reminders: [dueReminder()], profiles: [] });
    const summary = await processDueReminders(makeFakeClient(db) as never);

    expect(summary).toEqual({ claimed: 1, sent: 0, failedPermanently: 1, retried: 0 });
    expect(db.reminders[0].status).toBe("failed");
    expect(db.reminders[0].failure_reason).toMatch(/no longer exists/i);
    expect(db.notifications).toHaveLength(0);
  });
});

describe("processDueReminders — G5 stale recipient", () => {
  const staleCases: Array<[string, Partial<FakeDb>]> = [
    ["deactivated", { department_incharges: [{ profile_id: "recipient-1", department_id: "dept-1", is_active: false, gov_state: NRT_LOC.state, gov_district: NRT_LOC.district, gov_constituency: NRT_LOC.constituency, gov_area: NRT_LOC.area }] }],
    ["moved to another department", { profiles: [{ id: "recipient-1", full_name: "Incharge One", role: "department_incharge", department_id: "dept-2" }] }],
    ["demoted", { profiles: [{ id: "recipient-1", full_name: "Incharge One", role: "citizen", department_id: "dept-1" }] }],
    ["no longer the assigned in-charge", { report_assignments: [{ report_id: "report-1", department_id: "dept-1", incharge_id: "someone-else" }] }],
  ];
  it.each(staleCases)("fails permanently and sends nothing when the recipient was %s", async (_label, overrides) => {
    const db = makeDb({ reminders: [dueReminder()], ...overrides });
    const summary = await processDueReminders(makeFakeClient(db) as never);

    expect(summary).toEqual({ claimed: 1, sent: 0, failedPermanently: 1, retried: 0 });
    expect(db.reminders[0].status).toBe("failed");
    expect(db.reminders[0].failure_reason).toMatch(/no longer the report's active department in-charge/);
    expect(db.notifications).toHaveLength(0);
  });
});

describe("processDueReminders — empty input", () => {
  it("returns a zeroed summary and touches nothing when there are no reminders", async () => {
    const db = makeDb();
    const summary = await processDueReminders(makeFakeClient(db) as never);
    expect(summary).toEqual({ claimed: 0, sent: 0, failedPermanently: 0, retried: 0 });
  });
});

describe("G6 deliverReminderNow — immediate follow-up via the scheduler path", () => {
  it("delivers exactly that reminder, and a concurrent cron run can't deliver it again", async () => {
    const db = makeDb({ reminders: [dueReminder({ scheduled_at: new Date().toISOString() })] });
    expect(await deliverReminderNow(makeFakeClient(db) as never, "reminder-1")).toBe("sent");
    expect(await processDueReminders(makeFakeClient(db) as never)).toMatchObject({ claimed: 0 });
    expect(await deliverReminderNow(makeFakeClient(db) as never, "reminder-1")).toBeNull();
    expect(db.notifications).toHaveLength(1);
  });

  it("is a no-op when the cron already claimed the row", async () => {
    const db = makeDb({ reminders: [dueReminder({ status: "processing" })] });
    expect(await deliverReminderNow(makeFakeClient(db) as never, "reminder-1")).toBeNull();
    expect(db.notifications).toHaveLength(0);
  });

  it("fails permanently (no notification) for a recipient who is no longer effective", async () => {
    const db = makeDb({ reminders: [dueReminder()] });
    db.department_incharges[0].is_active = false;
    expect(await deliverReminderNow(makeFakeClient(db) as never, "reminder-1")).toBe("failed");
    expect(db.notifications).toHaveLength(0);
  });
});
