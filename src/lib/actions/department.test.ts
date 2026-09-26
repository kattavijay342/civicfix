import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeClient, forceNextError, clearForcedErrors, type FakeDb } from "../../../test/fake-supabase";

/**
 * G4 — department in-charge workflow server actions against an in-memory
 * table set. Exercises the action layer's own authorization, transition,
 * concurrency and side-effect logic; the real RLS boundary is covered live
 * by scripts/verify-g4-workflow-live.mjs and e2e/g4-department-workflow.spec.ts.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const rateLimitHook = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => {
    rateLimitHook();
    return { allowed: true, retryAfterSeconds: 0 };
  }),
  retryAfterMessage: () => "Too many attempts.",
}));

// Minimal stand-in for src/lib/idempotency.ts: same key after a commit
// replays the stored result without re-running anything.
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
const storageRemove = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    ...makeFakeClient(db, { resolution_evidence: ["report_id"] }),
    storage: {
      from: () => ({ upload: async () => ({ error: null }), remove: storageRemove }),
    },
  }),
}));

const { updateReportStatus, submitResolution } = await import("./department");

const REPORT = "report-1";
const NARASARAOPET = {
  gov_state: "Andhra Pradesh",
  gov_district: "Palnadu",
  gov_constituency: "Narasaraopet",
  gov_area: "Narasaraopet Municipality",
};
const TENALI = { gov_state: "Andhra Pradesh", gov_district: "Guntur", gov_constituency: "Tenali", gov_area: "Tenali Municipality" };

// 1x1 white JPEG — genuine bytes so validateImageBuffer's magic-byte sniff passes.
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
  "base64"
);

function seed(status = "routed") {
  db = {
    profiles: [
      { id: "incharge-a", role: "department_incharge", department_id: "dept-roads" },
      { id: "incharge-b", role: "department_incharge", department_id: "dept-roads" },
      { id: "incharge-water", role: "department_incharge", department_id: "dept-water" },
      { id: "incharge-tenali", role: "department_incharge", department_id: "dept-roads" },
      { id: "citizen-1", role: "citizen", department_id: null },
      { id: "gov-1", role: "government", department_id: null },
      { id: "admin-1", role: "admin", department_id: null },
    ],
    department_incharges: [
      { profile_id: "incharge-a", department_id: "dept-roads", is_active: true, ...NARASARAOPET },
      { profile_id: "incharge-b", department_id: "dept-roads", is_active: true, ...NARASARAOPET },
      { profile_id: "incharge-water", department_id: "dept-water", is_active: true, ...NARASARAOPET },
      { profile_id: "incharge-tenali", department_id: "dept-roads", is_active: true, ...TENALI },
    ],
    reports: [{ id: REPORT, status, reporter_id: "citizen-1", title: "Pothole near RTC Bus Stand" }],
    report_locations: [
      {
        report_id: REPORT,
        state: "Andhra Pradesh",
        district: "Palnadu",
        constituency: "Narasaraopet",
        area: "Narasaraopet Municipality",
      },
    ],
    report_assignments: [{ report_id: REPORT, department_id: "dept-roads", incharge_id: "incharge-a" }],
    report_media: [{ id: "media-before", report_id: REPORT, kind: "evidence", created_at: "2026-09-01T00:00:00Z" }],
    status_history: [],
    resolution_evidence: [],
    notifications: [],
  };
}

function statusForm(status: string, key: string = crypto.randomUUID(), notes = "") {
  const fd = new FormData();
  fd.set("status", status);
  fd.set("idempotencyKey", key);
  if (notes) fd.set("notes", notes);
  return fd;
}

function resolveForm(key: string = crypto.randomUUID(), notes = "Pothole filled and compacted.") {
  const fd = new FormData();
  fd.set("notes", notes);
  fd.set("idempotencyKey", key);
  fd.set("afterPhoto", new File([TINY_JPEG], "after.jpg", { type: "image/jpeg" }));
  return fd;
}

const as = (userId: string | null) => {
  currentUserId = userId;
};
const reportStatus = () => db.reports[0].status;
const afterMedia = () => db.report_media.filter((m) => m.kind === "after");

beforeEach(() => {
  seed();
  as("incharge-a");
  idempotencyStore.clear();
  clearForcedErrors();
  rateLimitHook.mockReset();
  storageRemove.mockClear();
});

describe("A. happy path — Acknowledge -> Start work -> Resolve", () => {
  it("walks the full lifecycle with history, evidence and one citizen notification per step", async () => {
    expect(await updateReportStatus(REPORT, {}, statusForm("ACKNOWLEDGED", undefined, "Inspection tomorrow"))).toEqual({
      success: true,
    });
    expect(reportStatus()).toBe("acknowledged");

    expect(await updateReportStatus(REPORT, {}, statusForm("IN_PROGRESS"))).toEqual({ success: true });
    expect(reportStatus()).toBe("in_progress");

    expect(await submitResolution(REPORT, {}, resolveForm())).toEqual({ success: true });
    expect(reportStatus()).toBe("resolved");

    expect(db.status_history.map((h) => [h.old_status, h.new_status, h.changed_by])).toEqual([
      ["routed", "acknowledged", "incharge-a"],
      ["acknowledged", "in_progress", "incharge-a"],
      ["in_progress", "resolved", "incharge-a"],
    ]);
    expect(db.status_history[0].notes).toBe("Inspection tomorrow");

    expect(db.resolution_evidence).toHaveLength(1);
    expect(db.resolution_evidence[0]).toMatchObject({
      report_id: REPORT,
      resolved_by: "incharge-a",
      before_media_id: "media-before",
      resolution_notes: "Pothole filled and compacted.",
    });
    expect(afterMedia()).toHaveLength(1);

    expect(db.notifications.map((n) => [n.recipient_id, n.type])).toEqual([
      ["citizen-1", "status_changed"],
      ["citizen-1", "status_changed"],
      ["citizen-1", "report_resolved"],
    ]);
  });
});

describe("B–D, F–G. authorization — nothing is written for a denied caller", () => {
  const cases: Array<[string, string | null, RegExp]> = [
    ["B. different in-charge, same department", "incharge-b", /isn't assigned to you/],
    ["C. in-charge of a different department", "incharge-water", /isn't assigned to you|no longer assigned/],
    ["D. same department, different jurisdiction", "incharge-tenali", /isn't assigned to you/],
    ["F. the reporting citizen", "citizen-1", /Only the assigned department in-charge/],
    ["G. a government user", "gov-1", /Only the assigned department in-charge/],
    ["unauthenticated", null, /signed in/],
  ];

  for (const [name, user, message] of cases) {
    it(`${name} cannot acknowledge or resolve`, async () => {
      as(user);
      const update = await updateReportStatus(REPORT, {}, statusForm("ACKNOWLEDGED"));
      expect(update.error).toMatch(message);

      db.reports[0].status = "in_progress";
      const resolve = await submitResolution(REPORT, {}, resolveForm());
      expect(resolve.error).toMatch(message);

      expect(reportStatus()).toBe("in_progress");
      expect(db.status_history).toHaveLength(0);
      expect(db.notifications).toHaveLength(0);
      expect(db.resolution_evidence).toHaveLength(0);
      expect(afterMedia()).toHaveLength(0);
    });
  }

  it("ignores any client-supplied incharge/department/role fields", async () => {
    as("incharge-b");
    const fd = statusForm("ACKNOWLEDGED");
    fd.set("inchargeId", "incharge-a");
    fd.set("departmentId", "dept-roads");
    fd.set("role", "admin");
    expect((await updateReportStatus(REPORT, {}, fd)).error).toMatch(/isn't assigned to you/);
    expect(reportStatus()).toBe("routed");
  });

  it("returns a friendly not-found for an unknown report id", async () => {
    expect(await updateReportStatus("nope", {}, statusForm("ACKNOWLEDGED"))).toEqual({ error: "Report not found." });
  });

  it("admin keeps the existing override", async () => {
    as("admin-1");
    expect(await updateReportStatus(REPORT, {}, statusForm("ACKNOWLEDGED"))).toEqual({ success: true });
  });
});

describe("E. invalid transitions cannot skip, repeat or reverse the lifecycle", () => {
  it("rejects Routed -> In Progress (skipping acknowledgement)", async () => {
    const r = await updateReportStatus(REPORT, {}, statusForm("IN_PROGRESS"));
    expect(r.error).toContain('"Acknowledge"');
    expect(reportStatus()).toBe("routed");
  });

  it("rejects resolving a routed or merely acknowledged report", async () => {
    expect((await submitResolution(REPORT, {}, resolveForm())).error).toBeTruthy();
    db.reports[0].status = "acknowledged";
    expect((await submitResolution(REPORT, {}, resolveForm())).error).toContain('"Start work"');
    expect(db.resolution_evidence).toHaveLength(0);
    expect(afterMedia()).toHaveLength(0);
  });

  it("rejects In Progress -> Acknowledged (backwards)", async () => {
    db.reports[0].status = "in_progress";
    expect((await updateReportStatus(REPORT, {}, statusForm("ACKNOWLEDGED"))).error).toBeTruthy();
    expect(reportStatus()).toBe("in_progress");
  });

  it("rejects arbitrary status values from the client, including resolved/reported", async () => {
    for (const s of ["RESOLVED", "REPORTED", "REOPENED", "resolved", "garbage"]) {
      expect(await updateReportStatus(REPORT, {}, statusForm(s))).toEqual({ error: "Invalid status." });
    }
    expect(reportStatus()).toBe("routed");
  });

  it("rejects any action on a report that hasn't been routed yet", async () => {
    db.reports[0].status = "reported";
    expect((await updateReportStatus(REPORT, {}, statusForm("ACKNOWLEDGED"))).error).toContain("hasn't been routed");
  });

  it("rejects resolving an already-resolved report", async () => {
    db.reports[0].status = "resolved";
    expect(await submitResolution(REPORT, {}, resolveForm())).toEqual({ error: "This report has already been resolved." });
  });
});

describe("I. duplicate actions and races", () => {
  it("a repeated click with the SAME key replays the result with no second side effect", async () => {
    const key = crypto.randomUUID();
    expect(await updateReportStatus(REPORT, {}, statusForm("ACKNOWLEDGED", key))).toEqual({ success: true });
    expect(await updateReportStatus(REPORT, {}, statusForm("ACKNOWLEDGED", key))).toEqual({ success: true });
    expect(db.status_history).toHaveLength(1);
    expect(db.notifications).toHaveLength(1);
  });

  it("a repeated click with a FRESH key is rejected as already acknowledged", async () => {
    await updateReportStatus(REPORT, {}, statusForm("ACKNOWLEDGED"));
    expect(await updateReportStatus(REPORT, {}, statusForm("ACKNOWLEDGED"))).toEqual({
      error: "This report is already acknowledged.",
    });
    expect(db.status_history).toHaveLength(1);
    expect(db.notifications).toHaveLength(1);
  });

  it("resolving twice creates exactly one evidence row, one history row, one notification", async () => {
    db.reports[0].status = "in_progress";
    const key = crypto.randomUUID();
    expect(await submitResolution(REPORT, {}, resolveForm(key))).toEqual({ success: true });
    expect(await submitResolution(REPORT, {}, resolveForm(key))).toEqual({ success: true }); // replay
    expect((await submitResolution(REPORT, {}, resolveForm())).error).toBe("This report has already been resolved.");
    expect(db.resolution_evidence).toHaveLength(1);
    expect(db.status_history).toHaveLength(1);
    expect(db.notifications.filter((n) => n.type === "report_resolved")).toHaveLength(1);
    expect(afterMedia()).toHaveLength(1);
  });

  it("a status write racing another update (compare-and-set miss) writes nothing", async () => {
    // Another request moves the report after this one validated it.
    // Replaced (not mutated) so the action's own earlier read keeps the
    // stale status, exactly like a real PostgREST response copy.
    rateLimitHook.mockImplementationOnce(() => {
      db.reports[0] = { ...db.reports[0], status: "acknowledged" };
    });
    const r = await updateReportStatus(REPORT, {}, statusForm("ACKNOWLEDGED"));
    expect(r.error).toMatch(/just updated by someone else/);
    expect(db.status_history).toHaveLength(0);
    expect(db.notifications).toHaveLength(0);
  });

  it("a resolution racing another resolution discards its uploaded evidence", async () => {
    db.reports[0].status = "in_progress";
    rateLimitHook.mockImplementationOnce(() => {
      db.reports[0] = { ...db.reports[0], status: "resolved" };
    });
    const r = await submitResolution(REPORT, {}, resolveForm());
    expect(r.error).toMatch(/just updated by someone else/);
    expect(db.resolution_evidence).toHaveLength(0);
    expect(afterMedia()).toHaveLength(0);
    expect(storageRemove).toHaveBeenCalledTimes(1);
    expect(db.status_history).toHaveLength(0);
  });

  it("an evidence write failure rolls the status back and removes the upload", async () => {
    db.reports[0].status = "in_progress";
    forceNextError("resolution_evidence", "db down");
    const r = await submitResolution(REPORT, {}, resolveForm());
    expect(r).toEqual({ error: "Unable to save the resolution. Please try again." });
    expect(reportStatus()).toBe("in_progress");
    expect(afterMedia()).toHaveLength(0);
    expect(db.notifications).toHaveLength(0);
  });
});

describe("J. stale assignment — the assignment row alone grants nothing", () => {
  it("a deactivated in-charge can no longer act on their old assignment", async () => {
    db.department_incharges[0].is_active = false;
    expect((await updateReportStatus(REPORT, {}, statusForm("ACKNOWLEDGED"))).error).toMatch(/inactive/);
    expect(reportStatus()).toBe("routed");
  });

  it("an in-charge moved to another department can no longer act", async () => {
    db.profiles[0].department_id = "dept-water";
    expect((await updateReportStatus(REPORT, {}, statusForm("ACKNOWLEDGED"))).error).toMatch(/no longer assigned/);
  });

  it("an in-charge re-scoped to another jurisdiction can no longer act", async () => {
    Object.assign(db.department_incharges[0], TENALI);
    expect((await updateReportStatus(REPORT, {}, statusForm("ACKNOWLEDGED"))).error).toMatch(/outside your current jurisdiction/);
  });

  it("an in-charge demoted to citizen can no longer act", async () => {
    db.profiles[0].role = "citizen";
    expect((await updateReportStatus(REPORT, {}, statusForm("ACKNOWLEDGED"))).error).toMatch(
      /Only the assigned department in-charge/
    );
  });
});

describe("reopened reports — re-acknowledge, restart, re-resolve", () => {
  it("resolves a second time by updating the one evidence row (unique report_id)", async () => {
    seed("reopened");
    db.resolution_evidence.push({
      id: "ev-1",
      report_id: REPORT,
      after_media_id: "media-old-after",
      resolution_notes: "First fix",
      resolved_by: "incharge-a",
      resolved_at: "2026-09-01T00:00:00Z",
    });

    expect((await submitResolution(REPORT, {}, resolveForm())).error).toContain('"Acknowledge"');
    expect(await updateReportStatus(REPORT, {}, statusForm("ACKNOWLEDGED"))).toEqual({ success: true });
    expect(await updateReportStatus(REPORT, {}, statusForm("IN_PROGRESS"))).toEqual({ success: true });
    expect(await submitResolution(REPORT, {}, resolveForm(undefined, "Relaid the whole patch"))).toEqual({
      success: true,
    });

    expect(reportStatus()).toBe("resolved");
    expect(db.resolution_evidence).toHaveLength(1);
    expect(db.resolution_evidence[0].resolution_notes).toBe("Relaid the whole patch");
    expect(db.resolution_evidence[0].after_media_id).not.toBe("media-old-after");
    expect(db.resolution_evidence[0].resolved_at).not.toBe("2026-09-01T00:00:00Z");
    expect(db.status_history[0]).toMatchObject({ old_status: "reopened", new_status: "acknowledged" });
  });
});

describe("input validation", () => {
  it("requires resolution notes and a real image", async () => {
    db.reports[0].status = "in_progress";
    expect((await submitResolution(REPORT, {}, resolveForm(undefined, "ok"))).error).toMatch(/resolution notes/);
    const fd = resolveForm();
    fd.delete("afterPhoto");
    expect((await submitResolution(REPORT, {}, fd)).error).toMatch(/Upload a photo/);
    expect(reportStatus()).toBe("in_progress");
  });

  it("caps action notes at 1000 characters", async () => {
    expect((await updateReportStatus(REPORT, {}, statusForm("ACKNOWLEDGED", undefined, "x".repeat(1001)))).error).toMatch(
      /too long/
    );
  });
});
