import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeClient, forceNextError, clearForcedErrors, type FakeDb } from "../../test/fake-supabase";
import { fakeAiWorkerExtras } from "../../test/fake-ai-worker-db";

/**
 * AI-2 CP2.1 — focused tests for the review's Medium findings:
 *   M1 notification insert failure, M2 lease renewal + Gemini bound,
 *   M3 recovery starvation / temporary auth errors, M4 final-attempt
 *   notification recovery. Gemini is never reachable.
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

const { runAiWorker, recoverMissingAiJobs, AI_WORKER_POLICY } = await import("./ai-worker");
const { runClaimedAiJob, clampGeminiTimeoutMs, MIN_GEMINI_ATTEMPT_MS, NOTIFY_RETRY_MS, AI_JOB_POLICY } = await import("./ai-jobs");
const { ensureAiAnalysisNotifications, NotificationDeliveryError } = await import("./ai-analysis-persistence");
const { analyzeReport } = await import("@/lib/ai");

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (t: number) => new Date(t).toISOString();
const REAL = "citizen-real";
const TESTACC = "citizen-test";

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
const reporterNotes = (id: string) => db.notifications.filter((n) => n.type === "ai_analysis_completed" && n.related_report_id === id);
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
  vi.mocked(analyzeReport).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db = {
    profiles: [
      { id: REAL, role: "citizen", notification_preferences: null },
      { id: "gov-1", role: "government", notification_preferences: null },
    ],
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
  extras = fakeAiWorkerExtras(db, { now, emails: { [REAL]: "person@example.org", [TESTACC]: "e2e-bot@test.civicfix.local" } });
});

// ---------------------------------------------------------------- M1
describe("M1 — notification insert failure is never treated as delivered", () => {
  it("ensureAiAnalysisNotifications throws when the insert fails (nothing counted as sent)", async () => {
    addReport("r1");
    db.ai_analyses.push({ report_id: "r1", priority: "high", problem_summary: "x" });
    forceNextError("notifications", "insert failed");
    await expect(ensureAiAnalysisNotifications(admin(), "r1")).rejects.toBeInstanceOf(NotificationDeliveryError);
    expect(db.notifications).toHaveLength(0);
  });

  it("an opted-out recipient is handled (not a failure) and nothing is written for them", async () => {
    addReport("r1");
    db.profiles[0].notification_preferences = { report_updates: false };
    db.ai_analyses.push({ report_id: "r1", priority: "high", problem_summary: "x" });
    await expect(ensureAiAnalysisNotifications(admin(), "r1")).resolves.toEqual({ sent: 0, alreadyPresent: 0, optedOut: 1 });
    expect(db.notifications).toHaveLength(0);
  });

  it("a failed insert leaves notified_at NULL and recovery pending; the later retry delivers WITHOUT calling Gemini", async () => {
    addReport("r1");
    addJob("r1");
    const analyze = vi.fn(async () => aiResult);
    forceNextError("notifications", "insert failed");

    const first = await run({ deps: { ai: { analyze } } });
    expect(analyze).toHaveBeenCalledTimes(1); // analysis saved
    expect(db.ai_analyses).toHaveLength(1);
    expect(first.aiJobs.retryScheduled).toBe(1);
    expect(job("r1")).toMatchObject({ status: "pending", notified_at: null, last_error_kind: "notify_failed" });
    expect(reporterNotes("r1")).toHaveLength(0);

    clearForcedErrors();
    clock += 2 * MIN; // past the 1-minute backoff
    const second = await run({ deps: { ai: { analyze } } });
    expect(second.aiJobs.completed).toBe(1);
    expect(analyze).toHaveBeenCalledTimes(1); // no second Gemini call
    expect(job("r1")).toMatchObject({ status: "completed", notified_at: iso(clock) });
    expect(reporterNotes("r1")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- M2
describe("M2 — lease renewal and lease-bounded Gemini requests", () => {
  it("clampGeminiTimeoutMs caps an explicit budget at the policy cap; undefined means no bound", () => {
    expect(clampGeminiTimeoutMs(undefined, 90_000)).toBe(90_000);
    expect(clampGeminiTimeoutMs(200_000, 90_000)).toBe(90_000);
    expect(clampGeminiTimeoutMs(40_000, 90_000)).toBe(40_000);
    expect(clampGeminiTimeoutMs(-5_000, 90_000)).toBe(0);
  });

  it("renews the lease before each claim (the lease row is extended to now + 270s)", async () => {
    addReport("r1");
    addJob("r1");
    await run({
      deps: {
        holder: "w1",
        ai: {
          analyze: async () => {
            // During the job the lease row belongs to w1 and was renewed at claim time.
            expect(db.ai_worker_lease[0]).toMatchObject({ holder: "w1", locked_until: iso(NOW + AI_WORKER_POLICY.workerLeaseSeconds * 1000) });
            return aiResult;
          },
        },
      },
    });
  });

  it("stops claiming new jobs when lease renewal fails (another worker took over)", async () => {
    for (const id of ["r1", "r2", "r3"]) {
      addReport(id);
      addJob(id);
    }
    const analyze = vi.fn(async () => {
      // Simulate: our lease expired mid-job and another run took it over.
      db.ai_worker_lease[0].holder = "other-worker";
      return aiResult;
    });
    const summary = await run({ deps: { ai: { analyze } } });
    expect(summary.stoppedReason).toBe("lease_lost");
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(db.ai_analysis_jobs.filter((j) => j.status === "pending")).toHaveLength(2);
    expect(db.ai_worker_lease[0]).toMatchObject({ holder: "other-worker" }); // never released by the old holder
  });

  it("the Gemini request is bounded by the DB-returned remaining lease minus the 30s margin", async () => {
    addReport("r1");
    addJob("r1");
    // Simulate a lease that, per the (fake) database clock, has only 70s left.
    extras.rpc!.renew_ai_worker_lease = () => ({ data: 70_000, error: null });
    const seen: number[] = [];
    await run({ deps: { ai: { analyze: async (_input, { timeoutMs }) => (seen.push(timeoutMs), aiResult) } } });
    // 70s remaining - 30s margin = 40s.
    expect(seen).toEqual([40_000]);
  });

  it("no Gemini request is started with less than 15s of lease budget (job rescheduled)", async () => {
    addReport("r1");
    addJob("r1");
    // Only 40s left on the lease -> 40s - 30s margin = 10s, below MIN_GEMINI_ATTEMPT_MS.
    extras.rpc!.renew_ai_worker_lease = () => ({ data: 40_000, error: null });
    const analyze = vi.fn(async () => aiResult);
    await run({ deps: { ai: { analyze } } });
    expect(analyze).not.toHaveBeenCalled();
    expect(job("r1")).toMatchObject({ status: "pending", last_error_kind: "lease_budget" });
    expect(MIN_GEMINI_ATTEMPT_MS).toBe(15_000);
  });

  it("without a deadline the full 90s policy timeout is used (and passed through to the request)", async () => {
    addReport("r1");
    addJob("r1", { status: "processing", attempts: 1, locked_until: iso(NOW + 3 * MIN) });
    const seen: number[] = [];
    await runClaimedAiJob(admin(), job("r1") as never, {
      now,
      analyze: async (_i, { timeoutMs }) => (seen.push(timeoutMs), aiResult as never),
    });
    expect(seen).toEqual([AI_JOB_POLICY.attemptTimeoutMs]);
  });

  it("the worker's missing-job recovery is time-bounded", async () => {
    for (let i = 0; i < 10; i++) addReport(`slow-${i}`, { createdAt: NOW - HOUR + i * 1000, reporter: `user-${i}` });
    extras = fakeAiWorkerExtras(db, {
      now,
      emails: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`user-${i}`, `u${i}@example.org`])),
      onUserLookup: () => {
        clock += 6_000; // each auth lookup takes 6s
      },
    });
    const result = await recoverMissingAiJobs(admin(), { now: NOW, clock: now, recoverySince: iso(NOW - 24 * HOUR) });
    expect(result).toMatchObject({ status: "ran", stoppedBy: "budget" });
    expect(extras.calls.getUserById).toBeLessThanOrEqual(Math.ceil(AI_WORKER_POLICY.recoveryBudgetMs / 6_000));
  });
});

// ---------------------------------------------------------------- M3
describe("M3 — recovery cannot be starved by excluded or unverifiable reports", () => {
  it("60 older test-account reports do not block a newer real report; exclusions are recorded once", async () => {
    for (let i = 0; i < 60; i++) addReport(`t-${i}`, { createdAt: NOW - 2 * HOUR + i * 1000, reporter: TESTACC });
    addReport("real", { createdAt: NOW - HOUR });

    const first = await recoverMissingAiJobs(admin(), { now: NOW, clock: now, recoverySince: iso(NOW - 24 * HOUR) });
    expect(first).toMatchObject({ status: "ran", enqueued: 1, excludedTestAccounts: 60 });
    expect(job("real")).toMatchObject({ status: "pending" });
    expect(extras.calls.getUserById).toBe(2); // verdicts cached per reporter within a run

    const lookupsBefore = extras.calls.getUserById;
    const second = await recoverMissingAiJobs(admin(), { now: NOW, clock: now, recoverySince: iso(NOW - 24 * HOUR) });
    expect(second).toMatchObject({ status: "ran", scanned: 0, enqueued: 0 });
    expect(extras.calls.getUserById).toBe(lookupsBefore); // excluded reports are not re-scanned
  });

  it("temporary auth errors are NOT treated as deleted users: skipped now, enqueued once the lookup works", async () => {
    addReport("flaky-report", { reporter: "flaky-user" });
    extras = fakeAiWorkerExtras(db, { now, emails: { "flaky-user": "__TEMP__" } });
    const first = await recoverMissingAiJobs(admin(), { now: NOW, clock: now, recoverySince: iso(NOW - 24 * HOUR) });
    expect(first).toMatchObject({ temporaryErrors: 1, reporterMissing: 0, enqueued: 0 });
    expect(db.ai_analysis_jobs).toHaveLength(0); // no tombstone for a temporary failure

    extras = fakeAiWorkerExtras(db, { now, emails: { "flaky-user": "flaky@example.org" } });
    const second = await recoverMissingAiJobs(admin(), { now: NOW, clock: now, recoverySince: iso(NOW - 24 * HOUR) });
    expect(second).toMatchObject({ enqueued: 1 });
    expect(job("flaky-report")).toMatchObject({ status: "pending" });
  });

  it("many temporarily-unverifiable reports still let a later real report through (pagination)", async () => {
    for (let i = 0; i < 55; i++) addReport(`f-${i}`, { createdAt: NOW - 2 * HOUR + i * 1000, reporter: "flaky-user" });
    addReport("real", { createdAt: NOW - HOUR });
    extras = fakeAiWorkerExtras(db, { now, emails: { "flaky-user": "__TEMP__", [REAL]: "person@example.org" } });
    const result = await recoverMissingAiJobs(admin(), { now: NOW, clock: now, recoverySince: iso(NOW - 24 * HOUR) });
    expect(result).toMatchObject({ enqueued: 1, temporaryErrors: 55 });
    expect(result.status === "ran" && result.pages).toBeGreaterThanOrEqual(2);
    expect(job("real")).toMatchObject({ status: "pending" });
  });

  it("a confirmed missing reporter (404) is excluded permanently, fail-closed", async () => {
    addReport("orphan", { reporter: "deleted-user" });
    const result = await recoverMissingAiJobs(admin(), { now: NOW, clock: now, recoverySince: iso(NOW - 24 * HOUR) });
    expect(result).toMatchObject({ reporterMissing: 1, enqueued: 0 });
    expect(job("orphan")).toMatchObject({ status: "failed", attempts: 0, last_error_kind: "reporter_missing" });
  });

  it("keeps the 48h ceiling and E2E exclusion while paginating", async () => {
    addReport("old", { createdAt: NOW - 72 * HOUR });
    addReport("e2e");
    db.report_locations.find((l) => l.report_id === "e2e")!.area = "E2E-fixture";
    addReport("ok");
    const result = await recoverMissingAiJobs(admin(), { now: NOW, clock: now, recoverySince: iso(NOW - 30 * 24 * HOUR) });
    expect(result).toMatchObject({ scanned: 1, enqueued: 1 });
    expect(db.ai_analysis_jobs.map((j) => j.report_id)).toEqual(["ok"]);
  });
});

// ---------------------------------------------------------------- M4
describe("M4 — final-attempt notification recovery", () => {
  it("a crashed final attempt WITH a saved analysis is completed after delivering notifications (no Gemini)", async () => {
    addReport("r1");
    db.ai_analyses.push({ report_id: "r1", priority: "high", problem_summary: "x" });
    addJob("r1", { status: "processing", attempts: 6, locked_until: iso(NOW - 1000) });
    const analyze = vi.fn();
    const summary = await run({ deps: { ai: { analyze } } });
    expect(summary.exhaustedSettled).toBe(1);
    expect(analyze).not.toHaveBeenCalled();
    expect(job("r1")).toMatchObject({ status: "completed", notified_at: iso(NOW), last_error_kind: null });
    expect(reporterNotes("r1")).toHaveLength(1);
  });

  it("a crashed final attempt WITHOUT an analysis becomes failed / lease_expired", async () => {
    addReport("r1");
    addJob("r1", { status: "processing", attempts: 6, locked_until: iso(NOW - 1000) });
    await run();
    expect(job("r1")).toMatchObject({ status: "failed", last_error_kind: "lease_expired" });
    expect(db.notifications).toHaveLength(0);
  });

  it("a final-attempt notification failure parks the job (not failed), and a later sweep completes it", async () => {
    addReport("r1");
    db.ai_analyses.push({ report_id: "r1", priority: "high", problem_summary: "x" });
    addJob("r1", { status: "processing", attempts: 6, locked_until: iso(NOW - 1000) });
    forceNextError("notifications", "insert failed");
    await run();
    expect(job("r1")).toMatchObject({ status: "processing", attempts: 6, last_error_kind: "notify_failed", locked_until: iso(NOW + NOTIFY_RETRY_MS) });

    clearForcedErrors();
    clock += NOTIFY_RETRY_MS + 1000;
    await run();
    expect(job("r1")).toMatchObject({ status: "completed", notified_at: iso(clock) });
    expect(reporterNotes("r1")).toHaveLength(1);
  });

  it("notification retry exhaustion on the last claimed attempt parks instead of failing", async () => {
    addReport("r1");
    db.ai_analyses.push({ report_id: "r1", priority: "high", problem_summary: "x" });
    addJob("r1", { attempts: 5 }); // the next claim is the final attempt
    forceNextError("notifications", "insert failed");
    const analyze = vi.fn();
    const summary = await run({ deps: { ai: { analyze } } });
    expect(summary.aiJobs.notifyPending).toBe(1);
    expect(analyze).not.toHaveBeenCalled();
    expect(job("r1")).toMatchObject({ status: "processing", attempts: 6, last_error_kind: "notify_failed" });
  });

  it("an already-notified exhausted job is completed without re-sending", async () => {
    addReport("r1");
    db.ai_analyses.push({ report_id: "r1", priority: "high", problem_summary: "x" });
    addJob("r1", { status: "processing", attempts: 6, locked_until: iso(NOW - 1000), notified_at: iso(NOW - HOUR) });
    await run();
    expect(job("r1")).toMatchObject({ status: "completed", notified_at: iso(NOW - HOUR) });
    expect(db.notifications).toHaveLength(0);
  });
});
