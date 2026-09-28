import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeClient, forceNextError, clearForcedErrors, type FakeDb } from "../../../test/fake-supabase";

/**
 * G7 — citizen verification of a resolution (verify / reject). Exercises the
 * action layer's authorization, decision rules, atomic claim, reopen,
 * history and notification recipients against an in-memory table set. The
 * real RLS boundary is covered live by scripts/verify-g7-resolution-live.mjs
 * and e2e/g7-resolution-verification.spec.ts.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  retryAfterMessage: () => "Too many attempts.",
}));

const idempotencyStore = new Map<string, unknown>();
vi.mock("@/lib/idempotency", () => ({
  beginIdempotentAction: vi.fn(async (_admin: unknown, userId: string, action: string, key: string | null) => {
    const id = `${userId}:${action}:${key}`;
    if (key && idempotencyStore.has(id)) return { kind: "replay", result: idempotencyStore.get(id) };
    return {
      kind: "run",
      commit: async (result: unknown) => {
        if (key) idempotencyStore.set(id, result);
      },
      release: async () => {},
    };
  }),
}));

let currentUserId: string | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: currentUserId ? { id: currentUserId } : null } }) },
  })),
}));

let db: FakeDb;
const client = () => makeFakeClient(db, { resolution_feedback: ["report_id"] });
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => client() }));

const { submitResolutionFeedback, performSubmitFeedback } = await import("./resolution-feedback");

const REPORT = "report-1";
const OTHER_REPORT = "report-2";
const RESOLVED_AT = "2026-09-20T10:00:00.000Z";
const REASON = "The pothole is only half filled and water still collects.";
const NARASARAOPET = {
  gov_state: "Andhra Pradesh",
  gov_district: "Palnadu",
  gov_constituency: "Narasaraopet",
  gov_area: "Narasaraopet Municipality",
};
const LOCATION = {
  state: "Andhra Pradesh",
  district: "Palnadu",
  constituency: "Narasaraopet",
  area: "Narasaraopet Municipality",
};

function seed(status = "resolved") {
  db = {
    profiles: [
      { id: "citizen-1", role: "citizen", department_id: null },
      { id: "citizen-2", role: "citizen", department_id: null },
      { id: "incharge-a", role: "department_incharge", department_id: "dept-roads" },
      { id: "incharge-water", role: "department_incharge", department_id: "dept-water" },
      { id: "gov-1", role: "government", department_id: null, ...NARASARAOPET },
      { id: "gov-tenali", role: "government", department_id: null, gov_state: "Andhra Pradesh", gov_district: "Guntur", gov_constituency: "Tenali", gov_area: null },
      { id: "gov-unscoped", role: "government", department_id: null, gov_state: null, gov_district: null, gov_constituency: null, gov_area: null },
      { id: "admin-1", role: "admin", department_id: null },
      { id: "gov-reporter", role: "government", department_id: null, gov_state: null, gov_district: null, gov_constituency: null, gov_area: null },
    ],
    department_incharges: [
      { profile_id: "incharge-a", department_id: "dept-roads", is_active: true, ...NARASARAOPET },
      { profile_id: "incharge-water", department_id: "dept-water", is_active: true, ...NARASARAOPET },
    ],
    reports: [
      { id: REPORT, status, reporter_id: "citizen-1", title: "Pothole near RTC Bus Stand" },
      { id: OTHER_REPORT, status: "resolved", reporter_id: "citizen-2", title: "Other citizen's report" },
    ],
    report_locations: [
      { report_id: REPORT, ...LOCATION },
      { report_id: OTHER_REPORT, ...LOCATION },
    ],
    report_assignments: [
      { report_id: REPORT, department_id: "dept-roads", incharge_id: "incharge-a" },
      { report_id: OTHER_REPORT, department_id: "dept-roads", incharge_id: "incharge-a" },
    ],
    resolution_evidence: [
      { id: "ev-1", report_id: REPORT, resolution_notes: "Filled.", resolved_by: "incharge-a", resolved_at: RESOLVED_AT },
      { id: "ev-2", report_id: OTHER_REPORT, resolution_notes: "Fixed.", resolved_by: "incharge-a", resolved_at: "2026-09-25T00:00:00.000Z" },
    ],
    resolution_feedback: [],
    status_history: [],
    notifications: [],
  };
}

function form(decision: "yes" | "no", opts: { comment?: string; key?: string; resolvedAt?: string | null } = {}) {
  const fd = new FormData();
  fd.set("confirmed", decision);
  if (opts.comment !== undefined) fd.set("comment", opts.comment);
  fd.set("idempotencyKey", opts.key ?? crypto.randomUUID());
  fd.set("resolvedAt", opts.resolvedAt === undefined ? RESOLVED_AT : opts.resolvedAt ?? "");
  return fd;
}

const as = (id: string | null) => {
  currentUserId = id;
};
const report = () => db.reports.find((r) => r.id === REPORT)!;
const feedbackRows = () => db.resolution_feedback.filter((f) => f.report_id === REPORT);
const history = () => db.status_history.filter((h) => h.report_id === REPORT);
const notified = () => db.notifications.map((n) => `${n.recipient_id}:${n.type}`).sort();
const reportInput = () => ({ title: report().title as string, reporter_id: "citizen-1", status: report().status as string });

function expectNothingWritten() {
  expect(feedbackRows()).toHaveLength(0);
  expect(history()).toHaveLength(0);
  expect(db.notifications).toHaveLength(0);
  expect(report().status).toBe("resolved");
}

beforeEach(() => {
  seed();
  as("citizen-1");
  idempotencyStore.clear();
  clearForcedErrors();
});

describe("1–5. authorization — only the reporting citizen", () => {
  it("the reporting citizen can verify", async () => {
    expect(await submitResolutionFeedback(REPORT, {}, form("yes"))).toEqual({ success: true, reopened: false });
  });

  const denied: Array<[string, string | null, RegExp]> = [
    ["2. another citizen", "citizen-2", /Only the citizen who reported/],
    ["3. a jurisdiction government user", "gov-1", /Only the citizen who reported/],
    ["4. the assigned department in-charge", "incharge-a", /Only the citizen who reported/],
    ["an admin", "admin-1", /Only the citizen who reported/],
    ["5. signed out", null, /signed in/],
  ];
  for (const [name, user, message] of denied) {
    it(`${name} cannot verify or reject`, async () => {
      as(user);
      expect((await submitResolutionFeedback(REPORT, {}, form("yes"))).error).toMatch(message);
      expect((await submitResolutionFeedback(REPORT, {}, form("no", { comment: REASON }))).error).toMatch(message);
      expectNothingWritten();
    });
  }

  it("a non-citizen who filed the report cannot verify it", async () => {
    report().reporter_id = "gov-reporter";
    as("gov-reporter");
    expect((await submitResolutionFeedback(REPORT, {}, form("yes"))).error).toMatch(/Only the citizen who reported/);
    expect(feedbackRows()).toHaveLength(0);
  });

  it("ignores client-supplied citizen/reporter/status fields", async () => {
    as("citizen-2");
    const fd = form("no", { comment: REASON });
    fd.set("citizenId", "citizen-1");
    fd.set("reporterId", "citizen-2");
    fd.set("status", "reopened");
    expect((await submitResolutionFeedback(REPORT, {}, fd)).error).toMatch(/Only the citizen who reported/);
    expectNothingWritten();
  });

  it("returns not-found for an unknown report", async () => {
    expect(await submitResolutionFeedback("nope", {}, form("yes"))).toEqual({ error: "Report not found." });
  });
});

describe("10–11. verify", () => {
  it("records the verification, keeps the report resolved and the evidence intact", async () => {
    expect(await submitResolutionFeedback(REPORT, {}, form("yes"))).toEqual({ success: true, reopened: false });
    expect(feedbackRows()).toHaveLength(1);
    expect(feedbackRows()[0]).toMatchObject({ citizen_id: "citizen-1", confirmed: true });
    expect(report().status).toBe("resolved");
    expect(history()).toEqual([
      expect.objectContaining({ old_status: "resolved", new_status: "resolved", changed_by: "citizen-1" }),
    ]);
    expect(history()[0].notes).toMatch(/Resolution verified by citizen/);
    expect(db.resolution_evidence.find((e) => e.report_id === REPORT)).toMatchObject({ resolution_notes: "Filled." });
  });

  it("16. notifies the effective in-charge and jurisdiction government users only", async () => {
    await submitResolutionFeedback(REPORT, {}, form("yes"));
    expect(notified()).toEqual(["gov-1:resolution_feedback_recorded", "incharge-a:resolution_feedback_recorded"]);
  });

  it("11. a double click (same key) replays with no second side effect", async () => {
    const key = crypto.randomUUID();
    await submitResolutionFeedback(REPORT, {}, form("yes", { key }));
    expect(await submitResolutionFeedback(REPORT, {}, form("yes", { key }))).toEqual({ success: true, reopened: false });
    expect(feedbackRows()).toHaveLength(1);
    expect(history()).toHaveLength(1);
    expect(db.notifications).toHaveLength(2);
  });

  it("11. a second tab (fresh key) is idempotent too", async () => {
    await submitResolutionFeedback(REPORT, {}, form("yes"));
    expect(await submitResolutionFeedback(REPORT, {}, form("yes"))).toEqual({ success: true, reopened: false });
    expect(feedbackRows()).toHaveLength(1);
    expect(history()).toHaveLength(1);
    expect(db.notifications).toHaveLength(2);
  });
});

describe("12–13. reject", () => {
  it("requires a meaningful reason and writes nothing without one", async () => {
    expect((await submitResolutionFeedback(REPORT, {}, form("no"))).error).toMatch(/at least 10 characters/);
    expect((await submitResolutionFeedback(REPORT, {}, form("no", { comment: "bad" }))).error).toMatch(/at least 10/);
    expectNothingWritten();
  });

  it("reopens the report with the reason in feedback and history", async () => {
    expect(await submitResolutionFeedback(REPORT, {}, form("no", { comment: REASON }))).toEqual({
      success: true,
      reopened: true,
    });
    expect(report().status).toBe("reopened");
    expect(report().reopened_at).toBeTruthy();
    expect(feedbackRows()[0]).toMatchObject({ confirmed: false, comment: REASON });
    expect(history()).toEqual([
      expect.objectContaining({ old_status: "resolved", new_status: "reopened", changed_by: "citizen-1" }),
    ]);
    expect(history()[0].notes).toContain(REASON);
    // Evidence of the rejected resolution is preserved.
    expect(db.resolution_evidence.find((e) => e.report_id === REPORT)).toBeTruthy();
  });

  it("16. notifies the effective in-charge and jurisdiction government users", async () => {
    await submitResolutionFeedback(REPORT, {}, form("no", { comment: REASON }));
    expect(notified()).toEqual(["gov-1:issue_reopened", "incharge-a:issue_reopened"]);
  });

  it("13. a second rejection (fresh key, stale tab) is idempotent", async () => {
    await submitResolutionFeedback(REPORT, {}, form("no", { comment: REASON }));
    const reopenedAt = report().reopened_at;
    expect(await submitResolutionFeedback(REPORT, {}, form("no", { comment: REASON }))).toEqual({
      success: true,
      reopened: true,
    });
    expect(feedbackRows()).toHaveLength(1);
    expect(history()).toHaveLength(1);
    expect(db.notifications).toHaveLength(2);
    expect(report().reopened_at).toBe(reopenedAt);
  });
});

describe("14. invalid transitions and stale pages", () => {
  it("cannot verify or reject a report that isn't resolved", async () => {
    for (const status of ["routed", "acknowledged", "in_progress"]) {
      seed(status);
      as("citizen-1");
      expect((await submitResolutionFeedback(REPORT, {}, form("yes"))).error).toMatch(/only be verified while/);
      expect((await submitResolutionFeedback(REPORT, {}, form("no", { comment: REASON }))).error).toMatch(
        /only be verified while/
      );
      expect(feedbackRows()).toHaveLength(0);
      expect(report().status).toBe(status);
    }
  });

  it("an old page cannot reject after the citizen verified", async () => {
    await submitResolutionFeedback(REPORT, {}, form("yes"));
    expect((await submitResolutionFeedback(REPORT, {}, form("no", { comment: REASON }))).error).toMatch(
      /already verified/
    );
    expect(report().status).toBe("resolved");
    expect(feedbackRows()[0].confirmed).toBe(true);
    expect(history()).toHaveLength(1);
  });

  it("an old page cannot verify after the citizen rejected", async () => {
    await submitResolutionFeedback(REPORT, {}, form("no", { comment: REASON }));
    expect((await submitResolutionFeedback(REPORT, {}, form("yes"))).error).toMatch(/already rejected/);
    expect(report().status).toBe("reopened");
    expect(feedbackRows()[0].confirmed).toBe(false);
  });

  it("a page showing an older resolution cannot decide on a newer one", async () => {
    // Earlier cycle: rejected, then the department re-resolved.
    db.resolution_feedback.push({
      id: "fb-old",
      report_id: REPORT,
      citizen_id: "citizen-1",
      confirmed: false,
      comment: "old",
      updated_at: "2026-09-15T00:00:00.000Z",
    });
    const res = await submitResolutionFeedback(REPORT, {}, form("yes", { resolvedAt: "2026-09-10T00:00:00.000Z" }));
    expect(res.error).toMatch(/changed since you opened the page/);
    expect(feedbackRows()[0]).toMatchObject({ id: "fb-old", confirmed: false, comment: "old" });
    expect(history()).toHaveLength(0);
  });

  it("a fresh decision on a re-resolved report updates the earlier-cycle row in place", async () => {
    db.resolution_feedback.push({
      id: "fb-old",
      report_id: REPORT,
      citizen_id: "citizen-1",
      confirmed: false,
      comment: "old",
      updated_at: "2026-09-15T00:00:00.000Z",
    });
    expect(await submitResolutionFeedback(REPORT, {}, form("yes"))).toEqual({ success: true, reopened: false });
    expect(feedbackRows()).toHaveLength(1);
    expect(feedbackRows()[0]).toMatchObject({ id: "fb-old", confirmed: true, comment: null });
  });
});

describe("15. evidence ownership", () => {
  it("another report's resolution cannot stand in for this report's", async () => {
    const other = db.resolution_evidence.find((e) => e.report_id === OTHER_REPORT)!.resolved_at as string;
    const res = await submitResolutionFeedback(REPORT, {}, form("yes", { resolvedAt: other }));
    expect(res.error).toMatch(/changed since you opened the page/);
    expect(db.resolution_feedback).toHaveLength(0);
  });

  it("a decision on one report never touches another report's feedback or status", async () => {
    await submitResolutionFeedback(REPORT, {}, form("no", { comment: REASON }));
    expect(db.reports.find((r) => r.id === OTHER_REPORT)!.status).toBe("resolved");
    expect(db.resolution_feedback.filter((f) => f.report_id === OTHER_REPORT)).toHaveLength(0);
  });
});

describe("16. notification recipients", () => {
  it("skips a deactivated in-charge but still notifies government", async () => {
    db.department_incharges[0].is_active = false;
    await submitResolutionFeedback(REPORT, {}, form("no", { comment: REASON }));
    expect(notified()).toEqual(["gov-1:issue_reopened"]);
  });

  it("skips an in-charge moved to another department", async () => {
    db.profiles.find((p) => p.id === "incharge-a")!.department_id = "dept-water";
    await submitResolutionFeedback(REPORT, {}, form("yes"));
    expect(notified()).toEqual(["gov-1:resolution_feedback_recorded"]);
  });

  it("skips an in-charge re-scoped out of the report's jurisdiction", async () => {
    Object.assign(db.department_incharges[0], { gov_district: "Guntur", gov_constituency: "Tenali", gov_area: null });
    await submitResolutionFeedback(REPORT, {}, form("yes"));
    expect(notified()).toEqual(["gov-1:resolution_feedback_recorded"]);
  });

  it("never notifies out-of-jurisdiction or unscoped government, other departments, or other citizens", async () => {
    await submitResolutionFeedback(REPORT, {}, form("no", { comment: REASON }));
    const recipients = db.notifications.map((n) => n.recipient_id);
    for (const id of ["gov-tenali", "gov-unscoped", "incharge-water", "citizen-1", "citizen-2", "admin-1"]) {
      expect(recipients).not.toContain(id);
    }
  });

  it("ignores client-supplied recipient ids", async () => {
    const fd = form("yes");
    fd.set("recipientId", "citizen-2");
    fd.set("inchargeId", "incharge-water");
    await submitResolutionFeedback(REPORT, {}, fd);
    expect(notified()).toEqual(["gov-1:resolution_feedback_recorded", "incharge-a:resolution_feedback_recorded"]);
  });
});

describe("17. concurrency — exactly one decision wins", () => {
  const run = (confirmed: boolean) =>
    performSubmitFeedback(client() as never, REPORT, reportInput(), "citizen-1", {
      confirmed,
      comment: confirmed ? null : REASON,
      submittedResolvedAt: RESOLVED_AT,
    });

  it("two concurrent verifies: one row, one history entry, one set of notifications", async () => {
    const results = await Promise.all([run(true), run(true)]);
    expect(results).toEqual([
      { success: true, reopened: false },
      { success: true, reopened: false },
    ]);
    expect(feedbackRows()).toHaveLength(1);
    expect(history()).toHaveLength(1);
    expect(db.notifications).toHaveLength(2);
  });

  it("two concurrent rejects: one reopen, one history entry, one set of notifications", async () => {
    const results = await Promise.all([run(false), run(false)]);
    expect(results).toEqual([
      { success: true, reopened: true },
      { success: true, reopened: true },
    ]);
    expect(report().status).toBe("reopened");
    expect(feedbackRows()).toHaveLength(1);
    expect(history()).toHaveLength(1);
    expect(db.notifications).toHaveLength(2);
  });

  it("verify racing reject: exactly one wins and the final state is consistent", async () => {
    const [verify, reject] = await Promise.all([run(true), run(false)]);
    expect([verify.success, reject.success].filter(Boolean)).toHaveLength(1);
    expect(feedbackRows()).toHaveLength(1);
    expect(history()).toHaveLength(1);
    const fb = feedbackRows()[0];
    expect(report().status).toBe(fb.confirmed ? "resolved" : "reopened");
  });

  it("racing on an earlier-cycle row: the conditional update lets only one through", async () => {
    db.resolution_feedback.push({
      id: "fb-old",
      report_id: REPORT,
      citizen_id: "citizen-1",
      confirmed: false,
      comment: "old",
      updated_at: "2026-09-15T00:00:00.000Z",
    });
    const [verify, reject] = await Promise.all([run(true), run(false)]);
    expect([verify.success, reject.success].filter(Boolean)).toHaveLength(1);
    expect(feedbackRows()).toHaveLength(1);
    expect(history()).toHaveLength(1);
    expect(report().status).toBe(feedbackRows()[0].confirmed ? "resolved" : "reopened");
  });
});

describe("failure handling", () => {
  it("returns an error and writes nothing when the feedback write fails", async () => {
    forceNextError("resolution_feedback", "simulated failure");
    expect((await submitResolutionFeedback(REPORT, {}, form("yes"))).error).toMatch(/Unable to save/);
    clearForcedErrors();
    expectNothingWritten();
  });

  it("a failed reopen releases the claim so the citizen can retry", async () => {
    forceNextError("reports", "simulated failure");
    expect((await submitResolutionFeedback(REPORT, {}, form("no", { comment: REASON }))).error).toMatch(
      /Unable to save/
    );
    clearForcedErrors();
    expectNothingWritten();
    expect(await submitResolutionFeedback(REPORT, {}, form("no", { comment: REASON }))).toEqual({
      success: true,
      reopened: true,
    });
  });
});
