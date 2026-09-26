import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeClient, type FakeDb } from "../../../test/fake-supabase";

/**
 * G5 — Government follow-up reminders (reusing the Phase 4 reminder system).
 * The session client below stands in for RLS: it only exposes the caller's
 * own profile and the reports their jurisdiction covers (exactly what
 * reports_select / profiles_select return live — proven separately by
 * scripts/verify-g5-action-required-live.mjs). Everything else the action
 * reads comes from the service-role fake, as in production.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  retryAfterMessage: () => "Too many attempts.",
}));
vi.mock("@/lib/idempotency", () => ({
  beginIdempotentAction: vi.fn(async () => ({ kind: "run", commit: async () => {}, release: async () => {} })),
}));

let db: FakeDb;
let currentUserId: string | null = null;
/** reports each user's jurisdiction RLS would return */
const VISIBLE: Record<string, string[]> = {
  "gov-nrt": ["report-1", "report-stale", "report-noincharge", "report-moved", "report-rescoped"],
  "gov-tenali": [],
  "citizen-1": ["report-1"],
  "incharge-a": ["report-1"],
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    const visible = new Set(currentUserId ? VISIBLE[currentUserId] ?? [] : []);
    const view: FakeDb = {
      profiles: db.profiles.filter((p) => p.id === currentUserId),
      reports: db.reports.filter((r) => visible.has(r.id as string)),
    };
    return {
      auth: { getUser: async () => ({ data: { user: currentUserId ? { id: currentUserId } : null } }) },
      ...makeFakeClient(view),
    };
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  // Mirrors the reminders table's column defaults (status, attempt_count,
  // created_at) — the fake doesn't model DEFAULTs itself.
  createAdminClient: () => {
    const client = makeFakeClient(db, { reminders: ["report_id", "recipient_id", "scheduled_at"] });
    return {
      from(table: string) {
        const q = client.from(table);
        if (table === "reminders") {
          const insert = q.insert.bind(q);
          q.insert = (row: Record<string, unknown>) =>
            insert({ status: "scheduled", attempt_count: 0, created_at: new Date().toISOString(), ...row });
        }
        return q;
      },
    };
  },
}));

const { createReminder, cancelReminder } = await import("./reminders");

const NRT = { gov_state: "Andhra Pradesh", gov_district: "Palnadu", gov_constituency: "Narasaraopet", gov_area: "Narasaraopet Municipality" };
const NRT_LOC = { state: "Andhra Pradesh", district: "Palnadu", constituency: "Narasaraopet", area: "Narasaraopet Municipality" };

function seed() {
  db = {
    profiles: [
      { id: "gov-nrt", role: "government", department_id: null, ...NRT },
      { id: "gov-tenali", role: "government", department_id: null },
      { id: "citizen-1", role: "citizen", department_id: null },
      { id: "incharge-a", role: "department_incharge", department_id: "dept-roads" },
      { id: "incharge-stale", role: "department_incharge", department_id: "dept-roads" },
      { id: "attacker-target", role: "department_incharge", department_id: "dept-water" },
      // moved to another department after being assigned a roads report
      { id: "incharge-moved", role: "department_incharge", department_id: "dept-water" },
      // still roads + active, but re-scoped to another district
      { id: "incharge-rescoped", role: "department_incharge", department_id: "dept-roads" },
    ],
    department_incharges: [
      { profile_id: "incharge-a", department_id: "dept-roads", is_active: true, ...NRT },
      { profile_id: "incharge-stale", department_id: "dept-roads", is_active: false, ...NRT },
      { profile_id: "attacker-target", department_id: "dept-water", is_active: true, ...NRT },
      { profile_id: "incharge-moved", department_id: "dept-roads", is_active: true, ...NRT },
      { profile_id: "incharge-rescoped", department_id: "dept-roads", is_active: true, gov_state: "Andhra Pradesh", gov_district: "Guntur" },
    ],
    reports: [
      { id: "report-1", title: "Pothole" },
      { id: "report-stale", title: "Broken light" },
      { id: "report-noincharge", title: "Drain" },
      { id: "report-moved", title: "Signal" },
      { id: "report-rescoped", title: "Footpath" },
    ],
    report_locations: [
      { report_id: "report-1", ...NRT_LOC },
      { report_id: "report-stale", ...NRT_LOC },
      { report_id: "report-noincharge", ...NRT_LOC },
      { report_id: "report-moved", ...NRT_LOC },
      { report_id: "report-rescoped", ...NRT_LOC },
    ],
    report_assignments: [
      { report_id: "report-1", department_id: "dept-roads", incharge_id: "incharge-a" },
      { report_id: "report-stale", department_id: "dept-roads", incharge_id: "incharge-stale" },
      { report_id: "report-noincharge", department_id: "dept-roads", incharge_id: null },
      { report_id: "report-moved", department_id: "dept-roads", incharge_id: "incharge-moved" },
      { report_id: "report-rescoped", department_id: "dept-roads", incharge_id: "incharge-rescoped" },
    ],
    reminders: [],
    notifications: [],
    status_history: [],
  };
}

/** Tomorrow 10:00 IST as a datetime-local value. */
function tomorrowLocal() {
  const d = new Date(Date.now() + 5.5 * 3600_000 + 24 * 3600_000);
  return `${d.toISOString().slice(0, 10)}T10:00`;
}

function form(extra: Record<string, string> = {}) {
  const f = new FormData();
  f.set("title", "Site visit");
  f.set("message", "Please confirm the site visit status.");
  f.set("scheduledAt", tomorrowLocal());
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
}

beforeEach(() => {
  seed();
  currentUserId = null;
});

describe("G5 createReminder — authorization", () => {
  it("signed-out caller is denied", async () => {
    expect(await createReminder("report-1", {}, form())).toEqual({ error: "You must be signed in." });
    expect(db.reminders).toHaveLength(0);
  });

  it.each([
    ["citizen", "citizen-1"],
    ["department in-charge", "incharge-a"],
  ])("%s cannot create a government reminder", async (_label, userId) => {
    currentUserId = userId;
    expect((await createReminder("report-1", {}, form())).error).toMatch(/Only government users/);
    expect(db.reminders).toHaveLength(0);
  });

  it("government user outside the report's jurisdiction is denied as 'not found'", async () => {
    currentUserId = "gov-tenali";
    expect(await createReminder("report-1", {}, form())).toEqual({ error: "Report not found." });
    expect(db.reminders).toHaveLength(0);
  });

  it("government user in the jurisdiction schedules a reminder to the assigned effective in-charge", async () => {
    currentUserId = "gov-nrt";
    expect(await createReminder("report-1", {}, form())).toEqual({ success: true, outcome: "scheduled" });
    expect(db.reminders).toHaveLength(1);
    expect(db.reminders[0]).toMatchObject({
      report_id: "report-1",
      created_by: "gov-nrt",
      recipient_id: "incharge-a",
      department_id: "dept-roads",
    });
  });
});

describe("G5 createReminder — server-derived recipient", () => {
  it("ignores any client-supplied recipient/department/creator fields", async () => {
    currentUserId = "gov-nrt";
    const forged = form({
      recipientId: "attacker-target",
      recipient_id: "attacker-target",
      departmentId: "dept-water",
      department_id: "dept-water",
      createdBy: "gov-tenali",
      created_by: "gov-tenali",
    });
    expect(await createReminder("report-1", {}, forged)).toEqual({ success: true, outcome: "scheduled" });
    expect(db.reminders[0]).toMatchObject({ recipient_id: "incharge-a", department_id: "dept-roads", created_by: "gov-nrt" });
  });

  it("refuses when the assigned in-charge is no longer effective (deactivated) — nothing is sent to them", async () => {
    currentUserId = "gov-nrt";
    expect((await createReminder("report-stale", {}, form())).error).toMatch(/Department in-charge unavailable/);
    expect(db.reminders).toHaveLength(0);
  });

  it("refuses when no in-charge is assigned", async () => {
    currentUserId = "gov-nrt";
    expect((await createReminder("report-noincharge", {}, form())).error).toMatch(/no department in-charge assigned/);
    expect(db.reminders).toHaveLength(0);
  });

  it("prevents a duplicate reminder for the same report, recipient and time", async () => {
    currentUserId = "gov-nrt";
    const at = tomorrowLocal();
    expect(await createReminder("report-1", {}, form({ scheduledAt: at }))).toEqual({ success: true, outcome: "scheduled" });
    // Mirrors reminders_dedupe_idx (report_id, recipient_id, scheduled_at).
    expect((await createReminder("report-1", {}, form({ scheduledAt: at }))).error).toMatch(/already scheduled/);
    expect(db.reminders).toHaveLength(1);
  });
});

describe("G5 cancelReminder — no impersonation", () => {
  it("a government user cannot cancel another government user's reminder", async () => {
    db.reminders.push({ id: "rem-1", report_id: "report-1", created_by: "gov-nrt", status: "scheduled" });
    currentUserId = "gov-tenali";
    expect(await cancelReminder("rem-1", "report-1")).toEqual({ error: "Only the reminder's creator can cancel it." });
    expect(db.reminders[0].status).toBe("scheduled");
  });
});

// ============================================================
// G6 — Government → Department follow-up ("Send now" + scheduled)
// ============================================================

function sendNow(extra: Record<string, string> = {}) {
  const f = new FormData();
  f.set("timing", "now");
  f.set("message", "Please provide an update on this issue.");
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
}

describe("G6 immediate follow-up — authorization (A, B, N, O)", () => {
  it("N. signed-out caller is denied, nothing created or notified", async () => {
    expect(await createReminder("report-1", {}, sendNow())).toEqual({ error: "You must be signed in." });
    expect(db.reminders).toHaveLength(0);
    expect(db.notifications).toHaveLength(0);
  });

  it.each([
    ["O. citizen", "citizen-1"],
    ["department in-charge acting as government", "incharge-a"],
  ])("%s cannot send a follow-up", async (_label, userId) => {
    currentUserId = userId;
    expect((await createReminder("report-1", {}, sendNow())).error).toMatch(/Only government users/);
    expect(db.reminders).toHaveLength(0);
    expect(db.notifications).toHaveLength(0);
  });

  it("B. unrelated government user (other jurisdiction) gets 'not found'", async () => {
    currentUserId = "gov-tenali";
    expect(await createReminder("report-1", {}, sendNow())).toEqual({ error: "Report not found." });
    expect(db.notifications).toHaveLength(0);
  });
});

describe("G6 immediate follow-up — delivery (H, K)", () => {
  it("H/K. delivers at once to the effective in-charge only, through the reminder pipeline", async () => {
    currentUserId = "gov-nrt";
    expect(await createReminder("report-1", {}, sendNow())).toEqual({ success: true, outcome: "sent" });

    expect(db.reminders).toHaveLength(1);
    expect(db.reminders[0]).toMatchObject({
      report_id: "report-1",
      created_by: "gov-nrt",
      recipient_id: "incharge-a",
      department_id: "dept-roads",
      title: "Government follow-up",
      message: "Please provide an update on this issue.",
      status: "sent",
      attempt_count: 1,
    });
    expect(db.notifications).toHaveLength(1);
    expect(db.notifications[0]).toMatchObject({
      recipient_id: "incharge-a",
      type: "reminder_due",
      related_report_id: "report-1",
    });
    expect(db.reminders[0].notification_id).toBe(db.notifications[0].id);
  });

  it("uses a government-supplied subject when given", async () => {
    currentUserId = "gov-nrt";
    await createReminder("report-1", {}, sendNow({ title: "Status needed" }));
    expect(db.reminders[0].title).toBe("Status needed");
  });

  it("G. forged recipient/in-charge/department/jurisdiction fields are ignored", async () => {
    currentUserId = "gov-nrt";
    const forged = sendNow({
      recipient_id: "attacker-target",
      incharge_id: "attacker-target",
      department_id: "dept-water",
      created_by: "gov-tenali",
      gov_district: "Guntur",
    });
    expect(await createReminder("report-1", {}, forged)).toMatchObject({ success: true });
    expect(db.reminders[0]).toMatchObject({ recipient_id: "incharge-a", department_id: "dept-roads", created_by: "gov-nrt" });
    expect(db.notifications.map((n) => n.recipient_id)).toEqual(["incharge-a"]);
  });

  it.each([
    ["too short", "hey"],
    ["too long", "x".repeat(1001)],
  ])("rejects a message that is %s", async (_label, message) => {
    currentUserId = "gov-nrt";
    expect((await createReminder("report-1", {}, sendNow({ message }))).error).toMatch(/between 5 and 1000/);
    expect(db.reminders).toHaveLength(0);
  });
});

describe("G6 effective in-charge (C, D, E, F)", () => {
  it.each([
    ["E. deactivated", "report-stale"],
    ["F. moved to another department", "report-moved"],
    ["D. re-scoped out of the report jurisdiction (stale)", "report-rescoped"],
  ])("%s in-charge: nothing is created or notified", async (_label, reportId) => {
    currentUserId = "gov-nrt";
    expect((await createReminder(reportId, {}, sendNow())).error).toMatch(/Department in-charge unavailable/);
    expect((await createReminder(reportId, {}, form())).error).toMatch(/Department in-charge unavailable/);
    expect(db.reminders).toHaveLength(0);
    expect(db.notifications).toHaveLength(0);
  });

  it("C. an in-charge who goes stale between creation and delivery is not notified", async () => {
    currentUserId = "gov-nrt";
    // Deactivate incharge-a the moment the reminder row is written.
    const original = db.reminders.push.bind(db.reminders);
    db.reminders.push = (...rows) => {
      db.department_incharges.find((r) => r.profile_id === "incharge-a")!.is_active = false;
      return original(...rows);
    };
    expect(await createReminder("report-1", {}, sendNow())).toEqual({ error: "Department in-charge is currently unavailable." });
    expect(db.reminders[0].status).toBe("failed");
    expect(db.notifications).toHaveLength(0);
  });
});

describe("G6 scheduled follow-up + duplicate prevention (I, J)", () => {
  it("I. a scheduled follow-up is queued, not delivered early", async () => {
    currentUserId = "gov-nrt";
    expect(await createReminder("report-1", {}, form({ timing: "scheduled" }))).toEqual({ success: true, outcome: "scheduled" });
    expect(db.reminders[0].status).toBe("scheduled");
    expect(db.notifications).toHaveLength(0);
  });

  it("I. scheduling still requires a valid future time", async () => {
    currentUserId = "gov-nrt";
    expect((await createReminder("report-1", {}, form({ scheduledAt: "" }))).error).toMatch(/valid date and time/);
    expect((await createReminder("report-1", {}, form({ scheduledAt: "2020-01-01T10:00" }))).error).toMatch(/future/);
  });

  it("J. the same immediate follow-up to the same in-charge/report is not re-sent", async () => {
    currentUserId = "gov-nrt";
    expect(await createReminder("report-1", {}, sendNow())).toMatchObject({ success: true });
    expect((await createReminder("report-1", {}, sendNow())).error).toMatch(/already sent/);
    expect(db.reminders).toHaveLength(1);
    expect(db.notifications).toHaveLength(1);
  });

  it("J. a different message is a genuinely new follow-up", async () => {
    currentUserId = "gov-nrt";
    await createReminder("report-1", {}, sendNow());
    // The fake's unique constraint isn't partial (the real index only
    // covers status = 'scheduled'), so keep the two sends' timestamps apart.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    try {
      expect(await createReminder("report-1", {}, sendNow({ message: "Any progress on the site visit?" }))).toMatchObject({ success: true });
    } finally {
      vi.useRealTimers();
    }
    expect(db.notifications).toHaveLength(2);
  });

  it("J. duplicate scheduled follow-up (same report, recipient, time) is rejected", async () => {
    currentUserId = "gov-nrt";
    const at = tomorrowLocal();
    await createReminder("report-1", {}, form({ timing: "scheduled", scheduledAt: at }));
    expect((await createReminder("report-1", {}, form({ timing: "scheduled", scheduledAt: at }))).error).toMatch(/already scheduled/);
    expect(db.reminders).toHaveLength(1);
  });
});

describe("G6 — P. no G4 workflow side effects", () => {
  it("a follow-up never changes the report, its assignment or status history", async () => {
    currentUserId = "gov-nrt";
    const before = JSON.stringify({ r: db.reports, a: db.report_assignments });
    await createReminder("report-1", {}, sendNow({ status: "resolved", newStatus: "RESOLVED" }));
    expect(JSON.stringify({ r: db.reports, a: db.report_assignments })).toBe(before);
    expect(db.status_history).toHaveLength(0);
  });
});
