import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeClient, forceNextError, clearForcedErrors, type FakeDb } from "../../test/fake-supabase";
import { fakeAiWorkerExtras } from "../../test/fake-ai-worker-db";

/**
 * AI-2 CP2.2 — focused tests for the database-clock lease hardening:
 *   M2-A database-clock renewal (success / wrong holder / expired lease /
 *   renewal-failure-stops-claims), monotonic run-duration measurement,
 *   same-timestamp recovery pagination, the 7-day notification-retry
 *   abandonment limit, and queue-health classification. Gemini is never
 *   reachable.
 */
vi.mock("@/lib/ai", () => ({
  analyzeReport: vi.fn(async () => {
    throw new Error("real Gemini must never be called in unit tests");
  }),
  resolveGeminiModel: () => "gemini-test-model",
}));
vi.mock("@/lib/incident-ai-confirm", () => ({
  INCIDENT_CONFIRM_MODEL: "gemini-3.6-flash",
  confirmSameIncident: vi.fn(async () => {
    throw new Error("real Gemini must never be called in unit tests");
  }),
}));
vi.mock("@/lib/notifications/targeting", () => ({ findGovernmentUsersForJurisdiction: vi.fn(async () => ["gov-1"]) }));
vi.mock("@/lib/actions/routing", () => ({ departmentIdForCategory: vi.fn(async () => "dept-roads") }));

const { runAiWorker, recoverMissingAiJobs, AI_WORKER_POLICY, aiJobHealthCategory } = await import("./ai-worker");
const { NOTIFY_RETRY_MS, NOTIFY_MAX_AGE_MS } = await import("./ai-jobs");

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const iso = (t: number) => new Date(t).toISOString();
const REAL = "citizen-real";

let db: FakeDb;
let clock: number;
let extras: ReturnType<typeof fakeAiWorkerExtras>;
const now = () => clock;
const admin = () =>
  makeFakeClient(db, { ai_analysis_jobs: ["report_id"], ai_analyses: ["report_id"], incident_confirmation_jobs: ["report_id"] }, extras) as never;

const aiResult = {
  problem_summary: "Pothole",
  category: "road",
  subcategory: "pothole",
  severity: "high",
  priority: "high",
  reasoning: "r",
  severity_reasoning: "r",
  priority_reasoning: "r",
  recommended_department: "Roads & Infrastructure",
  recommended_action: "Repair",
  action_steps: ["Repair"],
  confidence: 0.8,
  affected_infrastructure: null,
  urgency_factors: null,
  safety_risk: null,
  affected_population: null,
  time_context: null,
  location_context: null,
  evidence: null,
  complaint_subject: "s",
  complaint_impact: "i",
  complaint_action: "a",
  model: "gemini-test-model",
};

function addReport(id: string, opts: { createdAt?: number; reporter?: string } = {}) {
  db.reports.push({
    id,
    reporter_id: opts.reporter ?? REAL,
    title: `Report ${id}`,
    description: "Large pothole near the bus stand.",
    category: "road",
    status: "routed",
    created_at: iso(opts.createdAt ?? NOW - HOUR),
  });
  db.report_locations.push({
    report_id: id,
    display_name: "Bus Stand",
    state: "Andhra Pradesh",
    district: "Palnadu",
    constituency: "Narasaraopet",
    area: "Ward 12",
    landmark: null,
    latitude: null,
    longitude: null,
    location_source: "manual",
  });
}

function addJob(reportId: string, overrides: Record<string, unknown> = {}) {
  db.ai_analysis_jobs.push({
    report_id: reportId,
    status: "pending",
    attempts: 0,
    max_attempts: 6,
    next_attempt_at: iso(NOW - 1000),
    locked_until: null,
    last_error_kind: null,
    last_error_status: null,
    last_model: null,
    notified_at: null,
    created_at: iso(NOW - HOUR),
    ...overrides,
  });
}

const job = (id: string) => db.ai_analysis_jobs.find((j) => j.report_id === id)!;
const run = (o: Partial<Parameters<typeof runAiWorker>[0]> = {}) =>
  runAiWorker({
    admin: admin(),
    deadline: clock + AI_WORKER_POLICY.runBudgetMs,
    recoverySince: iso(NOW - 24 * HOUR),
    ...o,
    deps: { now, monotonicNow: now, random: () => 0.5, ...o.deps },
  });

beforeEach(() => {
  clock = NOW;
  clearForcedErrors();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db = {
    profiles: [{ id: REAL, role: "citizen", notification_preferences: null }],
    departments: [{ id: "dept-roads", name: "Roads & Infrastructure" }],
    reports: [],
    report_locations: [],
    report_media: [],
    report_assignments: [],
    ai_analyses: [],
    ai_analysis_jobs: [],
    incident_confirmation_jobs: [],
    notifications: [],
    ai_worker_lease: [],
  };
  extras = fakeAiWorkerExtras(db, { now, emails: { [REAL]: "person@example.org" } });
});

// ------------------------------------------------- M2-A: database-clock renewal
describe("M2-A — renew_ai_worker_lease (database-clock renewal)", () => {
  it("success: renewing the current holder's lease extends locked_until and returns a positive duration", () => {
    db.ai_worker_lease.push({ name: "ai", holder: "w1", locked_until: iso(NOW + MIN) });
    const result = extras.rpc!.renew_ai_worker_lease({ p_name: "ai", p_holder: "w1", p_seconds: 270 });
    expect(result.error).toBeNull();
    expect(result.data).toBe(270 * SEC);
    expect(db.ai_worker_lease[0].locked_until).toBe(iso(NOW + 270 * SEC));
  });

  it("wrong-holder renewal is rejected: returns null, the row is untouched", () => {
    db.ai_worker_lease.push({ name: "ai", holder: "w1", locked_until: iso(NOW + MIN) });
    const before = { ...db.ai_worker_lease[0] };
    const result = extras.rpc!.renew_ai_worker_lease({ p_name: "ai", p_holder: "someone-else", p_seconds: 270 });
    expect(result).toEqual({ data: null, error: null });
    expect(db.ai_worker_lease[0]).toEqual(before);
  });

  it("expired-lease renewal is rejected when there is no row for that holder (e.g. after a takeover cleared it)", () => {
    // No lease row at all for this name/holder combination.
    const result = extras.rpc!.renew_ai_worker_lease({ p_name: "ai", p_holder: "w1", p_seconds: 270 });
    expect(result).toEqual({ data: null, error: null });
  });

  it("the worker treats a null renewal as lease loss and stops claiming immediately — no further RPCs, no Gemini call", async () => {
    for (const id of ["r1", "r2"]) {
      addReport(id);
      addJob(id);
    }
    extras.rpc!.renew_ai_worker_lease = () => ({ data: null, error: null });
    const analyze = vi.fn(async () => aiResult);
    const summary = await run({ deps: { ai: { analyze } } });
    expect(summary.stoppedReason).toBe("lease_lost");
    expect(analyze).not.toHaveBeenCalled();
    expect(extras.calls.claim_due_ai_jobs).toBeUndefined();
    expect(db.ai_analysis_jobs.every((j) => j.status === "pending")).toBe(true);
  });

  it("a renewal RPC error (not just a false/null result) also stops the run without claiming", async () => {
    addReport("r1");
    addJob("r1");
    extras.rpc!.renew_ai_worker_lease = () => ({ data: null, error: { message: "connection reset", code: "08006" } });
    const analyze = vi.fn(async () => aiResult);
    const summary = await run({ deps: { ai: { analyze } } });
    expect(summary.stoppedReason).toBe("lease_lost");
    expect(analyze).not.toHaveBeenCalled();
  });

  it("the Gemini timeout is derived directly from the RPC's returned duration, never from re-measuring wall-clock elapsed time", async () => {
    addReport("r1");
    addJob("r1");
    // A slow claim round-trip AFTER renewal must NOT shrink the already-
    // computed budget, because the budget is a fixed duration handed down
    // by the worker, not re-derived from (deadline - now()) downstream.
    const originalClaim = extras.rpc!.claim_due_ai_jobs;
    extras.rpc!.claim_due_ai_jobs = (a) => {
      clock += 200_000;
      return originalClaim(a);
    };
    extras.rpc!.renew_ai_worker_lease = () => ({ data: 70_000, error: null });
    const seen: number[] = [];
    await run({ deps: { ai: { analyze: async (_i, { timeoutMs }) => (seen.push(timeoutMs), aiResult) } } });
    expect(seen).toEqual([40_000]); // 70s - 30s margin, unaffected by the later clock jump
  });
});

// ------------------------------------------------- Monotonic deadline calculations
describe("M2 — monotonic run-duration measurement", () => {
  it("the run's own stop decision follows the MONOTONIC clock even when wall-clock elapsed time barely moves", async () => {
    for (const id of ["r1", "r2", "r3"]) {
      addReport(id);
      addJob(id);
    }
    let mono = 0;
    const monotonicNow = () => mono;
    const analyze = vi.fn(async () => {
      mono += 60_000; // 60s of REAL elapsed time per job, per the monotonic clock
      clock += 1; // the wall clock (used only for DB timestamps) barely advances — e.g. a stalled NTP sync
      return aiResult;
    });
    const summary = await run({ deps: { ai: { analyze }, monotonicNow } });
    // A wall-clock-elapsed check (`deadline - now()`) would see almost no
    // time pass and keep going far past the real 240s budget. The
    // monotonic elapsed time (180s after 3 jobs) correctly stops the run
    // once less than 120s of budget remains.
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(summary.stoppedReason).toBe("deadline");
  });

  it("a wall-clock jump FORWARD mid-run does not cause premature stopping either", async () => {
    for (const id of ["r1", "r2", "r3"]) {
      addReport(id);
      addJob(id);
    }
    let mono = 0;
    const monotonicNow = () => mono;
    const analyze = vi.fn(async () => {
      mono += 10_000; // only 10s of real elapsed time per job
      clock += 10 * 24 * HOUR; // wall clock jumps forward 10 days
      return aiResult;
    });
    const summary = await run({ deps: { ai: { analyze }, monotonicNow } });
    expect(analyze).toHaveBeenCalledTimes(3); // all three still run — monotonic budget barely used
    expect(summary.stoppedReason).toBe("no_work");
  });
});

// ------------------------------------------------- Same-timestamp pagination
describe("M3 — stable (created_at, id) keyset pagination survives tied timestamps", () => {
  it("120 reports sharing one exact timestamp are all reachable (recoveryPageSize=50 < 120)", async () => {
    const tiedAt = NOW - HOUR;
    for (let i = 0; i < 120; i++) addReport(`tie-${String(i).padStart(3, "0")}`, { createdAt: tiedAt });
    const result = await recoverMissingAiJobs(admin(), { now: NOW, clock: now, recoverySince: iso(NOW - 24 * HOUR), limit: 200 });
    expect(result).toMatchObject({ status: "ran", scanned: 120, enqueued: 120 });
    expect(db.ai_analysis_jobs).toHaveLength(120);
  });

  it("a tied block larger than recoveryMaxPageLimit stops cleanly instead of looping forever", async () => {
    const tiedAt = NOW - HOUR;
    for (let i = 0; i < AI_WORKER_POLICY.recoveryMaxPageLimit + 20; i++) {
      addReport(`huge-${String(i).padStart(4, "0")}`, { createdAt: tiedAt });
    }
    const result = await recoverMissingAiJobs(admin(), {
      now: NOW,
      clock: now,
      recoverySince: iso(NOW - 24 * HOUR),
      limit: AI_WORKER_POLICY.recoveryMaxPageLimit + 20,
    });
    // However the dataset happens to interact with page-limit growth, the
    // run must stop cleanly for ONE of these two documented reasons — never
    // loop forever, and never make one RPC call per row (420+ rows here).
    expect(result.status).toBe("ran");
    if (result.status === "ran") {
      expect(["tie_block_exceeded", "max_pages"]).toContain(result.stoppedBy);
      expect(result.pages).toBeLessThan(10);
    }
  });

  it("a tie exactly at the page boundary, followed by distinct later rows, still reaches the later rows", async () => {
    const tiedAt = NOW - 2 * HOUR;
    for (let i = 0; i < 50; i++) addReport(`tie-${String(i).padStart(3, "0")}`, { createdAt: tiedAt });
    addReport("later-1", { createdAt: NOW - HOUR });
    addReport("later-2", { createdAt: NOW - 30 * MIN });
    const result = await recoverMissingAiJobs(admin(), { now: NOW, clock: now, recoverySince: iso(NOW - 24 * HOUR), limit: 60 });
    expect(result).toMatchObject({ status: "ran", scanned: 52, enqueued: 52 });
    expect(job("later-1")).toMatchObject({ status: "pending" });
    expect(job("later-2")).toMatchObject({ status: "pending" });
  });

  it("the recoveryLimit still stops a run partway through a very large page", async () => {
    const tiedAt = NOW - HOUR;
    for (let i = 0; i < 100; i++) addReport(`tie-${String(i).padStart(3, "0")}`, { createdAt: tiedAt });
    const result = await recoverMissingAiJobs(admin(), { now: NOW, clock: now, recoverySince: iso(NOW - 24 * HOUR), limit: 10 });
    expect(result).toMatchObject({ status: "ran", enqueued: 10, stoppedBy: "limit" });
  });
});

// ------------------------------------------------- Notification retry age limit
describe("optional hardening — 7-day notification-retry abandonment", () => {
  it("a job whose notifications have failed for longer than NOTIFY_MAX_AGE_MS is abandoned (marked failed), analysis kept", async () => {
    addReport("r1");
    db.ai_analyses.push({ report_id: "r1", priority: "high", problem_summary: "x" });
    addJob("r1", {
      status: "processing",
      attempts: 6,
      locked_until: iso(NOW - 1000),
      last_error_kind: "notify_failed",
      created_at: iso(NOW - NOTIFY_MAX_AGE_MS - HOUR),
    });
    forceNextError("notifications", "insert failed");
    const summary = await run();
    expect(summary.exhaustedSettled).toBe(1);
    expect(job("r1")).toMatchObject({ status: "failed", last_error_kind: "notify_abandoned" });
    expect(db.ai_analyses).toHaveLength(1); // the analysis itself is never discarded
    expect(db.notifications).toHaveLength(0);
  });

  it("a job still within the 7-day window keeps retrying (parked), never abandoned early", async () => {
    addReport("r1");
    db.ai_analyses.push({ report_id: "r1", priority: "high", problem_summary: "x" });
    addJob("r1", {
      status: "processing",
      attempts: 6,
      locked_until: iso(NOW - 1000),
      last_error_kind: "notify_failed",
      created_at: iso(NOW - NOTIFY_MAX_AGE_MS + HOUR), // just inside the window
    });
    forceNextError("notifications", "insert failed");
    await run();
    expect(job("r1")).toMatchObject({ status: "processing", attempts: 6, last_error_kind: "notify_failed", locked_until: iso(NOW + NOTIFY_RETRY_MS) });
  });

  it("a job row with no created_at is never treated as abandoned (fails safe toward retrying)", async () => {
    addReport("r1");
    db.ai_analyses.push({ report_id: "r1", priority: "high", problem_summary: "x" });
    addJob("r1", { status: "processing", attempts: 6, locked_until: iso(NOW - 1000), last_error_kind: "notify_failed", created_at: undefined });
    forceNextError("notifications", "insert failed");
    await run();
    expect(job("r1")).toMatchObject({ status: "processing", last_error_kind: "notify_failed" });
  });
});

// ------------------------------------------------- Queue-health classification
describe("optional hardening — aiJobHealthCategory distinguishes parked/excluded rows from active work", () => {
  it.each([
    [{ status: "pending", attempts: 0, max_attempts: 6, last_error_kind: null }, "active"],
    [{ status: "processing", attempts: 1, max_attempts: 6, last_error_kind: null }, "active"],
    [{ status: "processing", attempts: 6, max_attempts: 6, last_error_kind: "notify_failed" }, "parked_notify"],
    [{ status: "failed", attempts: 0, max_attempts: 6, last_error_kind: "excluded_test_account" }, "excluded"],
    [{ status: "failed", attempts: 0, max_attempts: 6, last_error_kind: "reporter_missing" }, "excluded"],
    [{ status: "failed", attempts: 1, max_attempts: 6, last_error_kind: "reporter_missing" }, "active"], // attempts>0 -> a real attempt, not a pure exclusion
    [{ status: "failed", attempts: 6, max_attempts: 6, last_error_kind: "notify_abandoned" }, "notify_abandoned"],
    [{ status: "failed", attempts: 6, max_attempts: 6, last_error_kind: "http_404" }, "active"],
    [{ status: "completed", attempts: 1, max_attempts: 6, last_error_kind: null }, "active"],
  ] as const)("%o -> %s", (job, expected) => {
    expect(aiJobHealthCategory(job)).toBe(expected);
  });
});
