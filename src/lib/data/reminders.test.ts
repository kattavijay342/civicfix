import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeClient, type FakeDb } from "../../../test/fake-supabase";

/**
 * G6 loaders. `readClient` stands in for the caller's RLS session; the
 * live reminders_select boundary itself is proven by
 * scripts/verify-g6-follow-up-live.mjs.
 */

let sessionDb: FakeDb;
let adminDb: FakeDb;
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => makeFakeClient(sessionDb)) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeFakeClient(adminDb) }));

const { loadDepartmentFollowUps, getReportReminders } = await import("./reminders");

function reminder(id: string, extra: Record<string, unknown>) {
  return {
    id,
    report_id: "report-1",
    created_by: "gov-1",
    recipient_id: "incharge-a",
    title: `Title ${id}`,
    message: `Message ${id}`,
    status: "sent",
    scheduled_at: "2026-09-25T04:30:00.000Z",
    sent_at: "2026-09-25T04:30:05.000Z",
    notification_id: null,
    failure_reason: null,
    created_at: "2026-09-25T04:30:00.000Z",
    ...extra,
  };
}

beforeEach(() => {
  sessionDb = {
    reminders: [
      reminder("mine", {}),
      reminder("mine-scheduled", { status: "scheduled", sent_at: null }),
      reminder("other-dept", { recipient_id: "incharge-water", report_id: "report-water" }),
      reminder("stale-assignment", { report_id: "report-old" }),
    ],
    reports: [
      { id: "report-1", title: "Pothole", status: "routed" },
      { id: "report-old", title: "Old report", status: "routed" },
      { id: "report-water", title: "Leak", status: "routed" },
    ],
  };
  adminDb = { profiles: [{ id: "gov-1", full_name: "Gov One" }, { id: "incharge-a", full_name: "Roads In-charge" }, { id: "incharge-old", full_name: "Former Person" }], notifications: [] };
});

describe("G6 loadDepartmentFollowUps — L/M department visibility", () => {
  it("L. returns delivered follow-ups addressed to me on my effective assignments only", async () => {
    const items = await loadDepartmentFollowUps(makeFakeClient(sessionDb) as never, makeFakeClient(adminDb) as never, "incharge-a", ["report-1"]);
    expect(items.map((i) => i.id)).toEqual(["mine"]);
    expect(items[0]).toMatchObject({ reportTitle: "Pothole", reportStatus: "routed", senderName: "Gov One", message: "Message mine" });
  });

  it("M. never returns another department's / in-charge's follow-ups, even for a report id passed in", async () => {
    const items = await loadDepartmentFollowUps(makeFakeClient(sessionDb) as never, makeFakeClient(adminDb) as never, "incharge-a", ["report-1", "report-water"]);
    expect(items.map((i) => i.id)).toEqual(["mine"]);
  });

  it("stale assignment (report no longer effective): its follow-ups are not even fetched", async () => {
    const items = await loadDepartmentFollowUps(makeFakeClient(sessionDb) as never, makeFakeClient(adminDb) as never, "incharge-a", ["report-1"]);
    expect(items.find((i) => i.id === "stale-assignment")).toBeUndefined();
  });

  it("deactivated / moved in-charge (no effective assignments) gets nothing and runs no query", async () => {
    const refuse = { from: () => { throw new Error("must not query"); } };
    expect(await loadDepartmentFollowUps(refuse as never, refuse as never, "incharge-a", [])).toEqual([]);
  });
});

describe("G6 getReportReminders — follow-up history privacy", () => {
  it("names the recipient only while they are the effective in-charge", async () => {
    sessionDb.reminders = [
      reminder("current", {}),
      reminder("former", { recipient_id: "incharge-old", status: "failed", failure_reason: "Recipient is no longer the report's active department in-charge." }),
    ];
    const rows = await getReportReminders("report-1", "gov-1", "incharge-a");
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("current")).toMatchObject({ recipientName: "Roads In-charge", recipientIsFormer: false, createdByName: "Gov One", isOwnCreation: true });
    expect(byId.get("former")).toMatchObject({ recipientName: null, recipientIsFormer: true });
  });

  it("no effective in-charge: nobody is named as the current recipient", async () => {
    const rows = await getReportReminders("report-1", "gov-1", null);
    expect(rows.every((r) => r.recipientName === null && r.recipientIsFormer)).toBe(true);
  });

  it("reports 'seen' only from the delivered notification's real read_at", async () => {
    sessionDb.reminders = [reminder("seen", { notification_id: "n1" }), reminder("unseen", { notification_id: "n2" })];
    adminDb.notifications = [
      { id: "n1", read_at: "2026-09-25T05:00:00.000Z" },
      { id: "n2", read_at: null },
    ];
    const rows = await getReportReminders("report-1", "gov-1", "incharge-a");
    expect(rows.find((r) => r.id === "seen")!.seenAt).toBe("2026-09-25T05:00:00.000Z");
    expect(rows.find((r) => r.id === "unseen")!.seenAt).toBeNull();
  });
});
