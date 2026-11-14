import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeClient, type FakeDb } from "../../test/fake-supabase";
import { fakeAiWorkerExtras } from "../../test/fake-ai-worker-db";

// No real Gemini anywhere: both real entry points throw if ever reached.
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
const routeReportSpy = vi.fn();
vi.mock("@/lib/actions/routing", () => ({
  routeReport: routeReportSpy,
  resolveAssignment: routeReportSpy,
  loadConfiguredDepartments: routeReportSpy,
  departmentIdForCategory: vi.fn(async () => "dept-roads"),
}));

const { runAiWorker, recoverMissingAiJobs, AI_WORKER_POLICY, WORKER_JOB_LEASE_MATCHES_POLICIES } = await import("./ai-worker");
const { AI_JOB_POLICY } = await import("./ai-jobs");
const { INCIDENT_JOB_POLICY } = await import("./incident-jobs");
const { analyzeReport } = await import("@/lib/ai");
const { confirmSameIncident } = await import("@/lib/incident-ai-confirm");

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
  makeFakeClient(db, { ai_analysis_jobs: ["report_id"], ai_analyses: ["report_id"], incident_confirmation_jobs: ["report_id"], incident_reports: ["incident_id", "report_id"] }, extras) as never;

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

function addReport(id: string, opts: { createdAt?: number; reporter?: string; area?: string; status?: string } = {}) {
  db.reports.push({
    id,
    reporter_id: opts.reporter ?? REAL,
    title: `Report ${id}`,
    description: "Large pothole near the bus stand.",
    category: "road",
    status: opts.status ?? "routed",
    severity: null,
    priority: null,
    created_at: iso(opts.createdAt ?? NOW - HOUR),
  });
  db.report_locations.push({
    report_id: id,
    display_name: "Bus Stand",
    state: "Andhra Pradesh",
    district: "Palnadu",
    constituency: "Narasaraopet",
    area: opts.area ?? "Narasaraopet Municipality",
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
    ...overrides,
  });
}

const aiError = (status: number) => Object.assign(new Error(`HTTP ${status} secret-ish provider text`), { status, transient: status === 429 || status >= 500 });
const job = (id: string) => db.ai_analysis_jobs.find((j) => j.report_id === id)!;
const run = (o: Partial<Parameters<typeof runAiWorker>[0]> = {}) =>
  runAiWorker({
    admin: admin(),
    deadline: clock + AI_WORKER_POLICY.runBudgetMs,
    recoverySince: iso(NOW - 24 * HOUR),
    ...o,
    // monotonicNow defaults to the same fake clock as `now`, so tests that
    // advance `clock` to simulate elapsed time (e.g. inside an `analyze`
    // mock) also advance the run's monotonic duration measurement.
    deps: { now, monotonicNow: now, random: () => 0.5, ...o.deps },
  });
const snapshot = () =>
  JSON.stringify({
    reports: db.reports.map((r) => ({ id: r.id, status: r.status, reporter_id: r.reporter_id })),
    assignments: db.report_assignments,
    history: db.status_history,
  });

beforeEach(() => {
  clock = NOW;
  routeReportSpy.mockReset();
  vi.mocked(analyzeReport).mockClear();
  vi.mocked(confirmSameIncident).mockClear();
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
    report_assignments: [{ report_id: "assigned-elsewhere", department_id: "dept-roads", incharge_id: "incharge-1" }],
    status_history: [{ report_id: "assigned-elsewhere", old_status: "reported", new_status: "routed" }],
    ai_analyses: [],
    ai_analysis_jobs: [],
    incident_confirmation_jobs: [],
    incident_reports: [],
    civic_incidents: [],
    notifications: [],
    ai_worker_lease: [],
  };
  extras = fakeAiWorkerExtras(db, { now, emails: { [REAL]: "person@example.org", [TESTACC]: "e2e-bot@test.civicfix.local" } });
});

describe("AI worker policy", () => {
  it("timing limits nest safely: attempt < job lease, start guard >= attempt + margin, budget < worker lease < pg_net timeout < maxDuration", () => {
    expect(WORKER_JOB_LEASE_MATCHES_POLICIES).toBe(true);
    expect(AI_JOB_POLICY.attemptTimeoutMs).toBe(90_000);
    expect(INCIDENT_JOB_POLICY.attemptTimeoutMs).toBe(90_000);
    expect(AI_WORKER_POLICY.jobLeaseSeconds * 1000).toBeGreaterThan(AI_JOB_POLICY.attemptTimeoutMs);
    expect(AI_WORKER_POLICY.minRemainingToStartMs).toBeGreaterThanOrEqual(AI_JOB_POLICY.attemptTimeoutMs + 30_000);
    expect(AI_WORKER_POLICY.runBudgetMs).toBe(240_000);
    expect(AI_WORKER_POLICY.workerLeaseSeconds * 1000).toBeGreaterThan(AI_WORKER_POLICY.runBudgetMs);
    expect(AI_WORKER_POLICY.workerLeaseSeconds).toBeLessThan(285); // pg_net timeout (runbook)
    expect(285).toBeLessThan(300); // route maxDuration
    expect(INCIDENT_JOB_POLICY.maxAttempts).toBe(3);
  });
});

describe("global worker lease", () => {
  it("a second worker while the lease is held exits immediately: no claims, no Gemini", async () => {
    db.ai_worker_lease.push({ name: "ai", holder: "other-worker", locked_until: iso(NOW + 100_000) });
    addReport("r1");
    addJob("r1");
    const analyze = vi.fn(async () => aiResult);
    const summary = await run({ deps: { ai: { analyze } } });

    expect(summary.status).toBe("lease_held");
    expect(analyze).not.toHaveBeenCalled();
    expect(extras.calls.claim_due_ai_jobs).toBeUndefined();
    expect(extras.calls.find_reports_missing_ai_job).toBeUndefined();
    expect(job("r1").status).toBe("pending");
    expect(db.ai_worker_lease[0]).toMatchObject({ holder: "other-worker" }); // untouched
  });

  it("two overlapping runs: only one does work", async () => {
    addReport("r1");
    addJob("r1");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const analyze = vi.fn(async () => {
      await gate;
      return aiResult;
    });
    const first = run({ deps: { ai: { analyze }, holder: "worker-a" } });
    await new Promise((r) => setTimeout(r, 5));
    const second = await run({ deps: { ai: { analyze }, holder: "worker-b" } });
    release();
    const firstSummary = await first;

    expect(second.status).toBe("lease_held");
    expect(firstSummary.status).toBe("ran");
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("an expired lease (crashed worker) is taken over", async () => {
    db.ai_worker_lease.push({ name: "ai", holder: "crashed", locked_until: iso(NOW - 1) });
    const summary = await run();
    expect(summary.status).toBe("ran");
  });

  it("releases the lease when done — and only its own lease", async () => {
    await run({ deps: { holder: "worker-a" } });
    expect(db.ai_worker_lease[0]).toMatchObject({ name: "ai", holder: null, locked_until: null });
  });

  it("releases the lease in finally even when the run throws", async () => {
    extras.rpc!.claim_due_ai_jobs = () => {
      throw new Error("boom");
    };
    addReport("r1");
    addJob("r1");
    await expect(run({ deps: { holder: "worker-a" } })).rejects.toThrow("boom");
    expect(db.ai_worker_lease[0]).toMatchObject({ holder: null });
  });

  it("a lease RPC error is reported without doing any work", async () => {
    extras.rpc!.acquire_ai_worker_lease = () => ({ data: null, error: { message: "relation does not exist", code: "42P01" } });
    const summary = await run();
    expect(summary.status).toBe("lease_error");
    expect(JSON.stringify(summary)).not.toContain("relation");
  });
});

describe("processing loop", () => {
  it("processes jobs one at a time (max one Gemini request in flight)", async () => {
    for (const id of ["r1", "r2", "r3"]) {
      addReport(id);
      addJob(id);
    }
    let inFlight = 0;
    let maxInFlight = 0;
    const analyze = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return aiResult;
    });
    const summary = await run({ deps: { ai: { analyze } } });

    expect(maxInFlight).toBe(1);
    expect(summary.aiJobs).toMatchObject({ processed: 3, completed: 3 });
    expect(summary.stoppedReason).toBe("no_work");
    expect(extras.calls.claim_due_ai_jobs).toBeGreaterThanOrEqual(3);
  });

  it("deadline guard: never starts a job with less than 120s of the 240s budget left", async () => {
    for (const id of ["r1", "r2", "r3", "r4", "r5"]) {
      addReport(id);
      addJob(id);
    }
    const analyze = vi.fn(async () => {
      clock += 60_000; // each Gemini attempt takes 60s
      return aiResult;
    });
    const summary = await run({ deps: { ai: { analyze } } });

    // t=0 (240 left) start, t=60 (180) start, t=120 (120) start, t=180 (60) stop.
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(summary.stoppedReason).toBe("deadline");
    expect(db.ai_analysis_jobs.filter((j) => j.status === "pending")).toHaveLength(2);
  });

  it("the run budget is clamped to 240s even if the caller passes a later deadline", async () => {
    for (const id of ["r1", "r2", "r3"]) {
      addReport(id);
      addJob(id);
    }
    const analyze = vi.fn(async () => {
      clock += 100_000;
      return aiResult;
    });
    await run({ deadline: NOW + 60 * MIN, deps: { ai: { analyze } } });
    // t=0 start, t=100 (140 left) start, t=200 (40 left) stop.
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it("respects maxJobsPerRun", async () => {
    for (const id of ["r1", "r2", "r3"]) {
      addReport(id);
      addJob(id);
    }
    const summary = await run({ limits: { maxJobsPerRun: 2 }, deps: { ai: { analyze: async () => aiResult } } });
    expect(summary.aiJobs.processed).toBe(2);
    expect(summary.stoppedReason).toBe("max_jobs");
  });

  it("transient failure schedules a retry (not re-run in the same pass); permanent failure fails; max attempts fails", async () => {
    addReport("t503");
    addJob("t503");
    addReport("p404");
    addJob("p404");
    addReport("last");
    addJob("last", { attempts: 5 });
    const analyze = vi.fn(async (input: { description: string }) => {
      void input;
      const call = analyze.mock.calls.length;
      throw aiError(call === 2 ? 404 : 503);
    });
    const summary = await run({ deps: { ai: { analyze } } });

    expect(job("t503")).toMatchObject({ status: "pending", attempts: 1, next_attempt_at: iso(NOW + MIN), last_error_kind: "http_503" });
    expect(job("p404")).toMatchObject({ status: "failed", attempts: 1, last_error_kind: "http_404" });
    expect(job("last")).toMatchObject({ status: "failed", attempts: 6, last_error_kind: "http_503" });
    expect(summary.aiJobs).toMatchObject({ processed: 3, retryScheduled: 1, failed: 2 });
    expect(analyze).toHaveBeenCalledTimes(3);
  });

  it("settles crashed final attempts (expired lease, no attempts left) as failed in both queues", async () => {
    addReport("ex1");
    addJob("ex1", { status: "processing", attempts: 6, locked_until: iso(NOW - 1000) });
    addReport("inc1");
    addReport("cand1");
    db.incident_confirmation_jobs.push({
      report_id: "inc1",
      candidate_report_id: "cand1",
      match_score: 0.6,
      status: "processing",
      attempts: 3,
      max_attempts: 3,
      next_attempt_at: iso(NOW - HOUR),
      locked_until: iso(NOW - 1000),
      last_error_kind: null,
      last_error_status: null,
      last_model: "gemini-3.6-flash",
    });
    const summary = await run();
    expect(summary.exhaustedSettled).toBe(2);
    expect(job("ex1")).toMatchObject({ status: "failed", last_error_kind: "lease_expired" });
    expect(db.incident_confirmation_jobs[0]).toMatchObject({ status: "failed", last_error_kind: "lease_expired" });
  });

  it("alternates between the AI and incident queues so neither starves", async () => {
    addReport("a1");
    addJob("a1");
    addReport("i1");
    addReport("c1");
    db.incident_confirmation_jobs.push({
      report_id: "i1",
      candidate_report_id: "c1",
      match_score: 0.6,
      status: "pending",
      attempts: 0,
      max_attempts: 3,
      next_attempt_at: iso(NOW - 1),
      locked_until: null,
      last_error_kind: null,
      last_error_status: null,
      last_model: null,
    });
    const confirm = vi.fn(async () => ({ same_incident: false, confidence: 0.2, reasoning: "different" }));
    const summary = await run({ deps: { ai: { analyze: async () => aiResult }, incident: { confirm } } });
    expect(summary.aiJobs.processed).toBe(1);
    expect(summary.incidentJobs).toMatchObject({ processed: 1, notConfirmed: 1 });
    expect(vi.mocked(confirmSameIncident)).not.toHaveBeenCalled();
  });

  it("never routes and never changes report status, ownership, assignments or history", async () => {
    addReport("r1", { status: "acknowledged" });
    addJob("r1");
    addReport("r2");
    addJob("r2");
    const before = snapshot();
    await run({ deps: { ai: { analyze: vi.fn().mockResolvedValueOnce(aiResult).mockRejectedValueOnce(aiError(503)) } } });
    expect(routeReportSpy).not.toHaveBeenCalled();
    expect(vi.mocked(analyzeReport)).not.toHaveBeenCalled();
    expect(snapshot()).toBe(before);
  });

  it("returns a sanitized summary — counts and categories only, no provider messages", async () => {
    addReport("r1");
    addJob("r1");
    const summary = await run({ deps: { ai: { analyze: async () => Promise.reject(aiError(503)) } } });
    const text = JSON.stringify(summary);
    expect(text).not.toContain("secret-ish");
    expect(text).not.toContain("pothole");
    expect(text).not.toContain(REAL);
  });
});

describe("notification recovery (Option A)", () => {
  it("after a crash between saving the analysis and notifying, the next run sends the missing notifications exactly once", async () => {
    addReport("r1");
    // Crashed worker: analysis saved, job still 'processing' with an expired lease, nothing notified.
    db.ai_analyses.push({ report_id: "r1", priority: "critical", problem_summary: "Open manhole" });
    addJob("r1", { status: "processing", attempts: 1, locked_until: iso(NOW - 1000) });
    const analyze = vi.fn();

    const summary = await run({ deps: { ai: { analyze } } });
    expect(analyze).not.toHaveBeenCalled();
    expect(summary.aiJobs.completed).toBe(1);
    expect(job("r1")).toMatchObject({ status: "completed", notified_at: iso(NOW) });
    expect(db.notifications.filter((n) => n.type === "ai_analysis_completed" && n.recipient_id === REAL)).toHaveLength(1);
    expect(db.notifications.filter((n) => n.type === "critical_issue" && n.recipient_id === "gov-1")).toHaveLength(1);

    clock += 10 * MIN;
    await run({ deps: { ai: { analyze } } });
    expect(db.notifications).toHaveLength(2);
  });

  it("only the missing notification is sent when some already exist", async () => {
    addReport("r1");
    db.ai_analyses.push({ report_id: "r1", priority: "critical", problem_summary: "Open manhole" });
    db.notifications.push({ recipient_id: REAL, type: "ai_analysis_completed", related_report_id: "r1" });
    addJob("r1", { status: "processing", attempts: 1, locked_until: iso(NOW - 1000) });
    await run();
    expect(db.notifications.filter((n) => n.type === "ai_analysis_completed")).toHaveLength(1);
    expect(db.notifications.filter((n) => n.type === "critical_issue")).toHaveLength(1);
  });

  it("a normal successful analysis notifies once and records notified_at", async () => {
    addReport("r1");
    addJob("r1");
    await run({ deps: { ai: { analyze: async () => aiResult } } });
    expect(job("r1")).toMatchObject({ status: "completed", notified_at: iso(NOW) });
    expect(db.notifications.filter((n) => n.type === "ai_analysis_completed")).toHaveLength(1);
  });

  it("a job already marked notified is completed without re-checking or re-sending", async () => {
    addReport("r1");
    db.ai_analyses.push({ report_id: "r1", priority: "high", problem_summary: "x" });
    addJob("r1", { status: "processing", attempts: 1, locked_until: iso(NOW - 1000), notified_at: iso(NOW - HOUR) });
    await run();
    expect(db.notifications).toHaveLength(0);
    expect(job("r1")).toMatchObject({ status: "completed", notified_at: iso(NOW - HOUR) });
  });
});

describe("missing-job recovery", () => {
  const recover = (since: string | undefined) => recoverMissingAiJobs(admin(), { now: NOW, recoverySince: since });

  it.each([undefined, "", "   "])("does not run without AI_JOB_RECOVERY_SINCE (%o)", async (since) => {
    addReport("r1");
    expect(await recover(since)).toEqual({ status: "skipped", reason: "cutoff_missing" });
    expect(db.ai_analysis_jobs).toHaveLength(0);
    expect(extras.calls.find_reports_missing_ai_job).toBeUndefined();
  });

  it.each(["yesterday", "2026-13-45", "1700000000000", iso(NOW + HOUR)])("does not run with an invalid or future cutoff (%s)", async (since) => {
    addReport("r1");
    expect(await recover(since)).toEqual({ status: "skipped", reason: "cutoff_invalid" });
    expect(db.ai_analysis_jobs).toHaveLength(0);
  });

  it("enqueues recent real reports that have neither an analysis nor a job — idempotently", async () => {
    addReport("fresh");
    const first = await recover(iso(NOW - 24 * HOUR));
    expect(first).toMatchObject({ status: "ran", scanned: 1, enqueued: 1 });
    expect(db.ai_analysis_jobs).toEqual([expect.objectContaining({ report_id: "fresh", status: "pending" })]);
    const second = await recover(iso(NOW - 24 * HOUR));
    expect(second).toMatchObject({ scanned: 0, enqueued: 0 });
    expect(db.ai_analysis_jobs).toHaveLength(1);
  });

  it("never reaches back more than 48 hours, even with an older cutoff", async () => {
    addReport("old", { createdAt: NOW - 72 * HOUR });
    addReport("recent", { createdAt: NOW - 47 * HOUR });
    const result = await recover(iso(NOW - 30 * 24 * HOUR));
    expect(result).toMatchObject({ status: "ran", since: iso(NOW - 48 * HOUR), enqueued: 1 });
    expect(db.ai_analysis_jobs.map((j) => j.report_id)).toEqual(["recent"]);
  });

  it("honours a cutoff later than 48 hours ago (deploy time)", async () => {
    addReport("before-deploy", { createdAt: NOW - 5 * HOUR });
    addReport("after-deploy", { createdAt: NOW - 1 * HOUR });
    await recover(iso(NOW - 2 * HOUR));
    expect(db.ai_analysis_jobs.map((j) => j.report_id)).toEqual(["after-deploy"]);
  });

  it("never enqueues test accounts, confirmed-missing reporters, E2E locations or already-analyzed reports", async () => {
    addReport("test-account", { reporter: TESTACC });
    addReport("unknown-user", { reporter: "ghost" });
    addReport("e2e", { area: "E2E-fixture" });
    addReport("analyzed");
    db.ai_analyses.push({ report_id: "analyzed" });
    addReport("ok");
    const result = await recover(iso(NOW - 24 * HOUR));
    expect(result).toMatchObject({ status: "ran", enqueued: 1, excludedTestAccounts: 1, reporterMissing: 1, temporaryErrors: 0 });
    // Only "ok" is a runnable job; the two exclusions are terminal rows (M3).
    expect(db.ai_analysis_jobs.filter((j) => j.status === "pending").map((j) => j.report_id)).toEqual(["ok"]);
    expect(db.ai_analysis_jobs.filter((j) => j.status === "failed").map((j) => [j.report_id, j.last_error_kind, j.attempts])).toEqual([
      ["test-account", "excluded_test_account", 0],
      ["unknown-user", "reporter_missing", 0],
    ]);
    expect(db.ai_analysis_jobs.some((j) => j.report_id === "e2e" || j.report_id === "analyzed")).toBe(false);
  });

  it("does not change report status, ownership or assignments", async () => {
    addReport("fresh");
    const before = snapshot();
    await recover(iso(NOW - 24 * HOUR));
    expect(snapshot()).toBe(before);
    expect(routeReportSpy).not.toHaveBeenCalled();
  });

  it("is part of each worker run and reports its outcome", async () => {
    addReport("fresh");
    const summary = await run({ recoverySince: undefined, deps: { ai: { analyze: async () => aiResult } } });
    // recoverySince falls back to process.env.AI_JOB_RECOVERY_SINCE, unset in tests -> skipped.
    expect(summary.recovery).toEqual({ status: "skipped", reason: "cutoff_missing" });
    expect(db.ai_analysis_jobs).toHaveLength(0);
  });
});
