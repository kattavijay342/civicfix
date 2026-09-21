import { describe, it, expect } from "vitest";
import { createNotification } from "./create";
import { makeFakeClient, type FakeDb } from "../../../test/fake-supabase";

function baseDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    profiles: [{ id: "user-1", notification_preferences: null }],
    notifications: [],
    ...overrides,
  };
}

describe("createNotification", () => {
  it("inserts a real row with the correct default priority/channel for the type", async () => {
    const db = baseDb();
    const client = makeFakeClient(db);

    const result = await createNotification(client as never, {
      recipientId: "user-1",
      type: "report_created",
      title: "Report submitted",
      relatedReportId: "report-1",
    });

    expect(result).not.toBeNull();
    expect(db.notifications).toHaveLength(1);
    expect(db.notifications[0]).toMatchObject({
      recipient_id: "user-1",
      type: "report_created",
      priority: "normal",
      channel: "in_app",
      related_report_id: "report-1",
    });
  });

  it("defaults critical_issue to critical priority", async () => {
    const db = baseDb();
    const client = makeFakeClient(db);

    await createNotification(client as never, {
      recipientId: "user-1",
      type: "critical_issue",
      title: "Critical issue reported",
    });

    expect(db.notifications[0].priority).toBe("critical");
  });

  it("respects an explicit priority override", async () => {
    const db = baseDb();
    const client = makeFakeClient(db);

    await createNotification(client as never, {
      recipientId: "user-1",
      type: "status_changed",
      title: "Status changed",
      priority: "high",
    });

    expect(db.notifications[0].priority).toBe("high");
  });

  it("skips insertion when the recipient has disabled the type's category", async () => {
    const db = baseDb({
      profiles: [{ id: "user-1", notification_preferences: { critical_issues: false } }],
    });
    const client = makeFakeClient(db);

    const result = await createNotification(client as never, {
      recipientId: "user-1",
      type: "critical_issue",
      title: "Critical issue reported",
    });

    expect(result).toBeNull();
    expect(db.notifications).toHaveLength(0);
  });

  it("still creates the notification for a DIFFERENT category the recipient hasn't disabled", async () => {
    const db = baseDb({
      profiles: [{ id: "user-1", notification_preferences: { critical_issues: false } }],
    });
    const client = makeFakeClient(db);

    const result = await createNotification(client as never, {
      recipientId: "user-1",
      type: "report_created",
      title: "Report submitted",
    });

    expect(result).not.toBeNull();
    expect(db.notifications).toHaveLength(1);
  });

  it("treats a null/absent preferences value as everything enabled (opt-out, not opt-in)", async () => {
    const db = baseDb({ profiles: [{ id: "user-1", notification_preferences: null }] });
    const client = makeFakeClient(db);

    const result = await createNotification(client as never, {
      recipientId: "user-1",
      type: "critical_issue",
      title: "Critical issue reported",
    });

    expect(result).not.toBeNull();
  });

  it("bypassPreferences ignores a disabled category — used only for reminder_due", async () => {
    const db = baseDb({
      profiles: [{ id: "user-1", notification_preferences: { follow_ups: false } }],
    });
    const client = makeFakeClient(db);

    const result = await createNotification(client as never, {
      recipientId: "user-1",
      type: "reminder_due",
      title: "Reminder",
      bypassPreferences: true,
    });

    expect(result).not.toBeNull();
    expect(db.notifications).toHaveLength(1);
  });

  it("still returns the created notification even when the enrichment update fails (e.g. migration 0011 not yet applied)", async () => {
    // A minimal inline mock (not the shared fake-supabase helper) because
    // this specific scenario needs the notifications table's INSERT to
    // succeed but its UPDATE to fail — the shared fake's forced-error
    // mechanism can't isolate insert vs. update for the same table.
    const insertedRow = { id: "notif-1" };
    const profilesQuery = {
      select: () => profilesQuery,
      eq: () => profilesQuery,
      maybeSingle: async () => ({ data: null, error: null }),
    };
    const notificationsInsertQuery = {
      insert: () => notificationsInsertQuery,
      select: () => notificationsInsertQuery,
      single: async () => ({ data: insertedRow, error: null }),
    };
    const notificationsUpdateQuery = {
      update: () => notificationsUpdateQuery,
      eq: async () => ({ data: null, error: { message: "column notifications.priority does not exist" } }),
    };
    let notificationsCallCount = 0;
    const client = {
      from: (table: string) => {
        if (table === "profiles") return profilesQuery;
        notificationsCallCount += 1;
        return notificationsCallCount === 1 ? notificationsInsertQuery : notificationsUpdateQuery;
      },
    };

    const result = await createNotification(client as never, {
      recipientId: "user-1",
      type: "report_created",
      title: "Report submitted",
    });

    expect(result).toEqual({ id: "notif-1" });
  });

  it("never throws and returns null when the insert itself fails", async () => {
    const db = baseDb();
    const client = makeFakeClient(db);
    // Simulate a DB failure by pointing at a table whose insert will error —
    // reuse the fake client's forced-error mechanism indirectly by removing
    // the profiles row so recipient lookup returns nothing (still valid:
    // absent prefs == enabled) and forcing the notifications insert itself.
    const { forceNextError, clearForcedErrors } = await import("../../../test/fake-supabase");
    forceNextError("notifications", "simulated failure");

    const result = await createNotification(client as never, {
      recipientId: "user-1",
      type: "report_created",
      title: "Report submitted",
    });

    expect(result).toBeNull();
    clearForcedErrors();
  });
});
