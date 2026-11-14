import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeClient, forceNextError, clearForcedErrors, type FakeDb } from "../../test/fake-supabase";

// Gemini is never reachable from these tests: every analysis goes through
// the injected `analyze` dep, and the real analyzeReport throws if touched.
vi.mock("@/lib/ai", () => ({
  analyzeReport: vi.fn(async () => {
    throw new Error("real Gemini must never be called in unit tests");
  }),
  resolveGeminiModel: () => "gemini-test-model",
}));
vi.mock("@/lib/notifications/targeting", () => ({ findGovernmentUsersForJurisdiction: vi.fn(async () => ["gov-1"]) }));
// The worker must never route; if anything reached the routing module it
// would hit these spies.
const routeReportSpy = vi.fn();
vi.mock("@/lib/actions/routing", () => ({
  routeReport: routeReportSpy,
  resolveAssignment: routeReportSpy,
  loadConfiguredDepartments: routeReportSpy,
}));

const { enqueueAiJob, processAiJob, aiJobRetryDelayMs, classifyAiJobError, AI_JOB_POLICY, MIN_GEMINI_ATTEMPT_MS } = await import("./ai-jobs");
const { MAX_LEASE_BUDGET_DEFERRALS, LEASE_BUDGET_DEFER_MS } = await import("./job-queue");
const { analyzeReport } = await import("@/lib/ai");

const REPORT_ID = "report-1";
const REPORTER_ID = "citizen-1";
const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

let db: FakeDb;
const admin = () =>
  makeFakeClient(db, { ai_analysis_jobs: ["report_id"], ai_analyses: ["report_id"] }) as unknown as Parameters<typeof processAiJob>[0];

const aiResult = {
  problem_summary: "Streetlight not working",
  category: "streetlight",
  subcategory: "streetlight_out",
  severity: "medium",
  priority: "high",
  reasoning: "Dark junction",
  severity_reasoning: "Partial",
  priority_reasoning: "Busy junction",
  recommended_department: "Electrical",
  recommended_action: "Replace lamp",
  action_steps: ["Inspect", "Replace"],
  confidence: 0.8,
  affected_infrastructure: null,
  urgency_factors: null,
  safety_risk: null,
  affected_population: null,
  time_context: null,
  location_context: null,
  evidence: null,
  complaint_subject: "Streetlight",
  complaint_impact: "Unsafe",
  complaint_action: "Fix",
  model: "gemini-test-model",
} as never;

/** Errors shaped like src/lib/ai.ts AIUnavailableError. */
function aiError(message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { name: "AIUnavailableError", transient: true, networkLevel: false, timedOut: false, ...extra });
}

function seedJob(overrides: Record<string, unknown> = {}) {
  db.ai_analysis_jobs.push({
    report_id: REPORT_ID,
    status: "pending",
    attempts: 0,
    max_attempts: 6,
    next_attempt_at: iso(NOW - 1000),
    locked_until: null,
    last_error_kind: null,
    last_error_status: null,
    last_model: null,
    ...overrides,
  });
}

const job = () => db.ai_analysis_jobs.find((j) => j.report_id === REPORT_ID)!;
const aiDone = () => db.notifications.filter((n) => n.type === "ai_analysis_completed");
const deps = (analyze: (input: unknown) => Promise<unknown>, extra: Record<string, unknown> = {}) =>
  ({ now: () => NOW, random: () => 0.5, analyze, ...extra }) as Parameters<typeof processAiJob>[2];
const snapshot = (rows: unknown) => JSON.parse(JSON.stringify(rows));

beforeEach(() => {
  clearForcedErrors();
  routeReportSpy.mockReset();
  vi.mocked(analyzeReport).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db = {
    profiles: [{ id: REPORTER_ID, role: "citizen", notification_preferences: null }, { id: "gov-1", role: "government", notification_preferences: null }],
    departments: [{ id: "dept-elec", name: "Electrical" }, { id: "dept-roads", name: "Roads & Infrastructure" }],
    reports: [
      {
        id: REPORT_ID,
        reporter_id: REPORTER_ID,
        title: "Streetlight out near bus stand",
        description: "The streetlight near the bus stand has not worked for a week.",
        category: "streetlight",
        status: "routed",
        severity: null,
        priority: null,
      },
    ],
    report_locations: [
      {
        report_id: REPORT_ID,
        display_name: "Bus Stand, Narasaraopet",
        state: "Andhra Pradesh",
        district: "Palnadu",
        constituency: "Narasaraopet",
        area: "Narasaraopet Municipality",
        landmark: null,
        latitude: null,
        longitude: null,
        location_source: "manual",
      },
    ],
    report_assignments: [{ report_id: REPORT_ID, department_id: "dept-elec", incharge_id: "incharge-1", assignment_method: "auto" }],
    status_history: [{ report_id: REPORT_ID, old_status: "reported", new_status: "routed" }],
    report_media: [],
    ai_analyses: [],
    ai_analysis_jobs: [],
    notifications: [],
  };
});

describe("aiJobRetryDelayMs — centralized backoff", () => {
  it("follows 1 / 5 / 15 / 60 / 180 minutes (no jitter at random = 0.5)", () => {
    expect([1, 2, 3, 4, 5].map((n) => aiJobRetryDelayMs(n, () => 0.5))).toEqual([1 * MIN, 5 * MIN, 15 * MIN, 60 * MIN, 180 * MIN]);
  });
  it("jitter stays within ±20% and the schedule is capped at its last step", () => {
    expect(aiJobRetryDelayMs(1, () => 0)).toBe(0.8 * MIN);
    expect(aiJobRetryDelayMs(1, () => 0.999999)).toBeLessThanOrEqual(1.2 * MIN);
    expect(aiJobRetryDelayMs(99, () => 0.5)).toBe(180 * MIN);
    expect(aiJobRetryDelayMs(0, () => 0.5)).toBe(1 * MIN);
  });
  it("the lease outlives one Gemini attempt", () => {
    expect(AI_JOB_POLICY.leaseMs).toBeGreaterThan(AI_JOB_POLICY.attemptTimeoutMs);
  });
});

describe("classifyAiJobError", () => {
  it.each([
    [{ status: 503 }, { kind: "http_503", status: 503, retryable: true }],
    [{ status: 429 }, { kind: "http_429", status: 429, retryable: true }],
    [{ status: 500 }, { kind: "http_500", status: 500, retryable: true }],
    [{ status: 400, transient: false }, { kind: "http_400", status: 400, retryable: false }],
    [{ status: 401, transient: false }, { kind: "http_401", status: 401, retryable: false }],
    [{ status: 403, transient: false }, { kind: "http_403", status: 403, retryable: false }],
    [{ status: 404, transient: false }, { kind: "http_404", status: 404, retryable: false }],
    [{ timedOut: true }, { kind: "timeout", status: null, retryable: true }],
    [{ networkLevel: true }, { kind: "network", status: null, retryable: true }],
    [{ transient: false, message: "GEMINI_API_KEY is not configured." }, { kind: "not_configured", status: null, retryable: false }],
    [{ transient: false, message: "AI returned a non-JSON response." }, { kind: "invalid_output", status: null, retryable: true }],
    [{ message: "boom" }, { kind: "unknown", status: null, retryable: true }],
  ])("%o -> %o", (shape, expected) => {
    expect(classifyAiJobError(Object.assign(new Error(String((shape as { message?: string }).message ?? "x")), shape))).toEqual(expected);
  });
});

describe("enqueueAiJob — one job per report", () => {
  it("creates exactly one pending job", async () => {
    expect(await enqueueAiJob(admin(), REPORT_ID)).toBe("queued");
    expect(db.ai_analysis_jobs).toEqual([expect.objectContaining({ report_id: REPORT_ID, status: "pending" })]);
  });

  it("a duplicate enqueue does not create a second job (ON CONFLICT DO NOTHING)", async () => {
    await enqueueAiJob(admin(), REPORT_ID);
    expect(await enqueueAiJob(admin(), REPORT_ID)).toBe("already_queued");
    expect(db.ai_analysis_jobs).toHaveLength(1);
  });

  it("a duplicate enqueue never resets an existing job's progress", async () => {
    seedJob({ status: "failed", attempts: 6 });
    expect(await enqueueAiJob(admin(), REPORT_ID)).toBe("already_queued");
    expect(job()).toMatchObject({ status: "failed", attempts: 6 });
  });

  it("a DB failure is reported as failed — never as queued", async () => {
    forceNextError("ai_analysis_jobs", "connection reset");
    expect(await enqueueAiJob(admin(), REPORT_ID)).toBe("failed");
    expect(db.ai_analysis_jobs).toHaveLength(0);
  });
});

describe("processAiJob — claim and lifecycle", () => {
  it("not_found when no job exists (nothing written, no Gemini call)", async () => {
    const analyze = vi.fn();
    expect(await processAiJob(admin(), REPORT_ID, deps(analyze))).toEqual({ outcome: "not_found" });
    expect(analyze).not.toHaveBeenCalled();
  });

  it("pending -> processing: increments attempts and takes a time-limited lease before calling Gemini", async () => {
    seedJob();
    let duringCall: Record<string, unknown> | null = null;
    await processAiJob(
      admin(),
      REPORT_ID,
      deps(async () => {
        duringCall = { ...job() };
        return aiResult;
      })
    );
    expect(duringCall).toMatchObject({
      status: "processing",
      attempts: 1,
      locked_until: iso(NOW + AI_JOB_POLICY.leaseMs),
      last_model: "gemini-test-model",
    });
  });

  it("success -> completed: analysis saved, severity/priority copied, reporter notified once", async () => {
    seedJob();
    const result = await processAiJob(admin(), REPORT_ID, deps(async () => aiResult));

    expect(result).toEqual({ outcome: "completed", via: "analysis" });
    expect(job()).toMatchObject({ status: "completed", attempts: 1, locked_until: null, last_error_kind: null });
    expect(db.ai_analyses).toEqual([expect.objectContaining({ report_id: REPORT_ID, recommended_department: "Electrical" })]);
    expect(db.reports[0]).toMatchObject({ severity: "medium", priority: "high" });
    expect(aiDone()).toEqual([expect.objectContaining({ recipient_id: REPORTER_ID, related_report_id: REPORT_ID })]);
  });

  it("passes the report's own inputs (text, category, location, configured departments) to the single analysis", async () => {
    seedJob();
    const analyze = vi.fn<(input: unknown) => Promise<unknown>>(async () => aiResult);
    await processAiJob(admin(), REPORT_ID, deps(analyze));

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0][0]).toMatchObject({
      category: "STREETLIGHT",
      description: expect.stringContaining("streetlight"),
      location: expect.objectContaining({ displayName: "Bus Stand, Narasaraopet", constituency: "Narasaraopet" }),
      departmentNames: ["Electrical", "Roads & Infrastructure"],
    });
  });

  it("only one of two concurrent workers claims the job; Gemini is called once", async () => {
    seedJob();
    const analyze = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return aiResult;
    });
    const results = await Promise.all([processAiJob(admin(), REPORT_ID, deps(analyze)), processAiJob(admin(), REPORT_ID, deps(analyze))]);

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(results).toContainEqual({ outcome: "completed", via: "analysis" });
    // The loser either lost the compare-and-set (saw "pending") or read the
    // row after the winner's claim (saw "processing") — never both claim.
    expect(results.filter((r) => r.outcome === "not_claimable")).toHaveLength(1);
    expect(db.ai_analyses).toHaveLength(1);
    expect(aiDone()).toHaveLength(1);
    expect(job()).toMatchObject({ status: "completed", attempts: 1 });
  });

  it("a pending job that is not yet due is left alone", async () => {
    seedJob({ next_attempt_at: iso(NOW + 5 * MIN), attempts: 1 });
    const analyze = vi.fn();
    expect(await processAiJob(admin(), REPORT_ID, deps(analyze))).toEqual({ outcome: "not_claimable", status: "pending" });
    expect(analyze).not.toHaveBeenCalled();
    expect(job()).toMatchObject({ status: "pending", attempts: 1 });
  });

  it.each(["completed", "failed"])("a %s job is never re-processed", async (status) => {
    seedJob({ status, attempts: 2 });
    const analyze = vi.fn();
    expect(await processAiJob(admin(), REPORT_ID, deps(analyze))).toEqual({ outcome: "not_claimable", status });
    expect(analyze).not.toHaveBeenCalled();
  });

  it("a processing job with a live lease is not stolen", async () => {
    seedJob({ status: "processing", attempts: 1, locked_until: iso(NOW + MIN) });
    const analyze = vi.fn();
    expect(await processAiJob(admin(), REPORT_ID, deps(analyze))).toEqual({ outcome: "not_claimable", status: "processing" });
    expect(analyze).not.toHaveBeenCalled();
  });

  it("an expired processing lease (crashed worker) is recovered by a new claim", async () => {
    seedJob({ status: "processing", attempts: 1, locked_until: iso(NOW - 1000) });
    const result = await processAiJob(admin(), REPORT_ID, deps(async () => aiResult));

    expect(result).toEqual({ outcome: "completed", via: "analysis" });
    expect(job()).toMatchObject({ status: "completed", attempts: 2 });
    expect(db.ai_analyses).toHaveLength(1);
  });

  it("an expired lease with no attempts left is settled as failed (never stuck, no Gemini call)", async () => {
    seedJob({ status: "processing", attempts: 6, locked_until: iso(NOW - 1000) });
    const analyze = vi.fn();
    expect(await processAiJob(admin(), REPORT_ID, deps(analyze))).toEqual({ outcome: "failed", attempts: 6, kind: "lease_expired" });
    expect(analyze).not.toHaveBeenCalled();
    expect(job()).toMatchObject({ status: "failed", locked_until: null });
  });

  it("a worker whose lease was re-claimed mid-call cannot overwrite the newer claim", async () => {
    seedJob();
    const result = await processAiJob(
      admin(),
      REPORT_ID,
      deps(async () => {
        // Simulate: lease expired, another worker re-claimed (attempt 2).
        Object.assign(job(), { attempts: 2, locked_until: iso(NOW + 10 * MIN) });
        throw aiError("503 high demand", { status: 503 });
      })
    );
    expect(result).toEqual({ outcome: "lost_lease" });
    expect(job()).toMatchObject({ status: "processing", attempts: 2, last_error_kind: null });
  });
});

describe("processAiJob — retries and failures", () => {
  it("transient HTTP 503 schedules a retry with backoff (1 minute after attempt 1)", async () => {
    seedJob();
    const result = await processAiJob(admin(), REPORT_ID, deps(async () => Promise.reject(aiError("503 high demand", { status: 503 }))));

    expect(result).toEqual({ outcome: "retry_scheduled", attempts: 1, nextAttemptAt: iso(NOW + MIN), kind: "http_503" });
    expect(job()).toMatchObject({
      status: "pending",
      attempts: 1,
      locked_until: null,
      next_attempt_at: iso(NOW + MIN),
      last_error_kind: "http_503",
      last_error_status: 503,
    });
    expect(db.ai_analyses).toHaveLength(0);
    expect(aiDone()).toHaveLength(0);
  });

  it("a timeout schedules a retry; later attempts back off further (attempt 3 -> 15 minutes)", async () => {
    seedJob({ attempts: 2 });
    const result = await processAiJob(admin(), REPORT_ID, deps(async () => Promise.reject(aiError("Gemini request timed out.", { timedOut: true }))));

    expect(result).toEqual({ outcome: "retry_scheduled", attempts: 3, nextAttemptAt: iso(NOW + 15 * MIN), kind: "timeout" });
    expect(job()).toMatchObject({ status: "pending", last_error_kind: "timeout", last_error_status: null });
  });

  it("a retried job succeeds on a later run", async () => {
    seedJob();
    await processAiJob(admin(), REPORT_ID, deps(async () => Promise.reject(aiError("503", { status: 503 }))));
    const later = await processAiJob(admin(), REPORT_ID, { ...deps(async () => aiResult), now: () => NOW + 2 * MIN });

    expect(later).toEqual({ outcome: "completed", via: "analysis" });
    expect(job()).toMatchObject({ status: "completed", attempts: 2, last_error_kind: null, last_error_status: null });
  });

  it.each([400, 403, 404])("permanent HTTP %i marks the job failed without retrying", async (status) => {
    seedJob();
    const analyze = vi.fn(async () => Promise.reject(aiError(`${status} error`, { status, transient: false })));
    const result = await processAiJob(admin(), REPORT_ID, deps(analyze));

    expect(result).toEqual({ outcome: "failed", attempts: 1, kind: `http_${status}` });
    expect(job()).toMatchObject({ status: "failed", attempts: 1, locked_until: null, last_error_status: status });
    // Settled: a further worker run makes no new request.
    await processAiJob(admin(), REPORT_ID, { ...deps(analyze), now: () => NOW + 24 * 60 * MIN });
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("missing API key marks the job failed without retrying", async () => {
    seedJob();
    const result = await processAiJob(
      admin(),
      REPORT_ID,
      deps(async () => Promise.reject(aiError("GEMINI_API_KEY is not configured.", { transient: false })))
    );
    expect(result).toEqual({ outcome: "failed", attempts: 1, kind: "not_configured" });
  });

  it("the attempt that reaches max_attempts marks the job failed instead of rescheduling", async () => {
    seedJob({ attempts: 5 });
    const result = await processAiJob(admin(), REPORT_ID, deps(async () => Promise.reject(aiError("503", { status: 503 }))));

    expect(result).toEqual({ outcome: "failed", attempts: 6, kind: "http_503" });
    expect(job()).toMatchObject({ status: "failed", attempts: 6, locked_until: null, last_error_kind: "http_503" });
  });

  it("six consecutive transient failures make exactly six Gemini calls in total", async () => {
    seedJob();
    const analyze = vi.fn(async () => Promise.reject(aiError("503", { status: 503 })));
    let t = NOW;
    for (let run = 0; run < 10; run++) {
      t += 4 * 60 * MIN; // past every backoff step
      await processAiJob(admin(), REPORT_ID, { ...deps(analyze), now: () => t });
    }
    expect(analyze).toHaveBeenCalledTimes(6);
    expect(job()).toMatchObject({ status: "failed", attempts: 6 });
  });

  it("stores only sanitized error metadata — never the provider message", async () => {
    seedJob();
    await processAiJob(
      admin(),
      REPORT_ID,
      deps(async () => Promise.reject(aiError("503 key=AQ.secret-looking-value prompt=citizen text", { status: 503 })))
    );
    const stored = JSON.stringify(job());
    expect(stored).not.toContain("secret-looking-value");
    expect(stored).not.toContain("citizen text");
    expect(job()).toMatchObject({ last_error_kind: "http_503", last_error_status: 503 });
  });

  it("a failed analysis save is retried later (report stays without analysis)", async () => {
    seedJob();
    forceNextError("ai_analyses", "insert failed");
    const result = await processAiJob(admin(), REPORT_ID, deps(async () => aiResult));
    clearForcedErrors();

    expect(result).toMatchObject({ outcome: "retry_scheduled", kind: "persist_failed" });
    expect(db.ai_analyses).toHaveLength(0);
    expect(aiDone()).toHaveLength(0);
  });
});

describe("processAiJob — idempotent persistence", () => {
  it("an analysis that already exists (and was already notified) completes the job with NO Gemini call and NO duplicate notification", async () => {
    seedJob();
    db.ai_analyses.push({ report_id: REPORT_ID, model: "earlier", priority: "high", problem_summary: "x" });
    db.notifications.push({ recipient_id: REPORTER_ID, type: "ai_analysis_completed", related_report_id: REPORT_ID });
    const analyze = vi.fn();
    const result = await processAiJob(admin(), REPORT_ID, deps(analyze));

    expect(result).toEqual({ outcome: "completed", via: "already_present" });
    expect(analyze).not.toHaveBeenCalled();
    expect(db.ai_analyses).toHaveLength(1);
    expect(aiDone()).toHaveLength(1);
    expect(job()).toMatchObject({ status: "completed" });
  });

  it("losing the persistence race (UNIQUE(report_id)) is treated as done — no duplicate row or notification", async () => {
    seedJob();
    const result = await processAiJob(
      admin(),
      REPORT_ID,
      deps(async () => {
        // e.g. the owner's manual retry saved an analysis (and notified) meanwhile.
        db.ai_analyses.push({ report_id: REPORT_ID, model: "manual-retry", priority: "high", problem_summary: "x" });
        db.notifications.push({ recipient_id: REPORTER_ID, type: "ai_analysis_completed", related_report_id: REPORT_ID });
        return aiResult;
      })
    );

    expect(result).toEqual({ outcome: "completed", via: "already_present" });
    expect(db.ai_analyses).toEqual([expect.objectContaining({ model: "manual-retry" })]);
    expect(aiDone()).toHaveLength(1);
  });
});

describe("processAiJob — never routes, never changes lifecycle or ownership", () => {
  for (const outcome of ["success", "transient", "permanent"] as const) {
    it(`${outcome}: no routing call; reports.status, reporter_id, assignments and status history unchanged`, async () => {
      seedJob();
      const before = {
        status: db.reports[0].status,
        reporter: db.reports[0].reporter_id,
        assignments: snapshot(db.report_assignments),
        history: snapshot(db.status_history),
      };
      const analyze =
        outcome === "success"
          ? async () => aiResult
          : outcome === "transient"
            ? async () => Promise.reject(aiError("503", { status: 503 }))
            : async () => Promise.reject(aiError("404", { status: 404, transient: false }));
      await processAiJob(admin(), REPORT_ID, deps(analyze));

      expect(routeReportSpy).not.toHaveBeenCalled();
      expect(vi.mocked(analyzeReport)).not.toHaveBeenCalled();
      expect(db.reports[0].status).toBe(before.status);
      expect(db.reports[0].reporter_id).toBe(before.reporter);
      expect(db.report_assignments).toEqual(before.assignments);
      expect(db.status_history).toEqual(before.history);
      expect(db.notifications.some((n) => n.type === "report_assigned")).toBe(false);
    });
  }

  it("an acknowledged report keeps its status when AI completes later", async () => {
    db.reports[0].status = "acknowledged";
    seedJob();
    await processAiJob(admin(), REPORT_ID, deps(async () => aiResult));
    expect(db.reports[0].status).toBe("acknowledged");
    expect(job()).toMatchObject({ status: "completed" });
  });

  it("a critical result also alerts jurisdiction government users (same as the inline path did)", async () => {
    seedJob();
    await processAiJob(admin(), REPORT_ID, deps(async () => ({ ...(aiResult as object), priority: "critical" })));
    expect(db.notifications.filter((n) => n.type === "critical_issue").map((n) => n.recipient_id)).toEqual(["gov-1"]);
  });
});

// CP2.3 (M-1): a lease-budget shortfall must never consume a genuine
// Gemini attempt, must stay bounded, and must never interfere with a
// genuine failure's own exhaustion at max_attempts.
describe("processAiJob — lease-budget shortfall (CP2.3 M-1)", () => {
  it("gives the claimed attempt back and reschedules — no Gemini call, attempts unchanged, one deferral recorded", async () => {
    seedJob({ attempts: 5, max_attempts: 6 });
    const analyze = vi.fn();
    const result = await processAiJob(admin(), REPORT_ID, deps(analyze, { geminiTimeoutMs: MIN_GEMINI_ATTEMPT_MS - 1 }));

    expect(analyze).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "retry_scheduled", attempts: 5, nextAttemptAt: iso(NOW + LEASE_BUDGET_DEFER_MS), kind: "lease_budget" });
    expect(job()).toMatchObject({
      status: "pending",
      attempts: 5, // the claim's +1 was given back — NOT consumed
      max_attempts: 6,
      next_attempt_at: iso(NOW + LEASE_BUDGET_DEFER_MS),
      last_error_kind: "lease_budget",
      lease_budget_deferrals: 1,
    });
  });

  it("this is true even on what would have been the job's FINAL attempt — it stays retryable, not failed", async () => {
    seedJob({ attempts: 5, max_attempts: 6 }); // claim brings attempts to 6 = max_attempts
    const analyze = vi.fn();
    const result = await processAiJob(admin(), REPORT_ID, deps(analyze, { geminiTimeoutMs: 1000 }));

    expect(analyze).not.toHaveBeenCalled();
    expect(result.outcome).toBe("retry_scheduled"); // NOT "failed"
    expect(job()).toMatchObject({ status: "pending", attempts: 5 }); // still has a genuine attempt left
  });

  it("a deferred job is not immediately re-claimable — bounded, no hot loop within one run", async () => {
    seedJob({ attempts: 0 });
    await processAiJob(admin(), REPORT_ID, deps(vi.fn(), { geminiTimeoutMs: 1000 }));
    const immediateRetry = await processAiJob(admin(), REPORT_ID, deps(vi.fn()));
    expect(immediateRetry).toEqual({ outcome: "not_claimable", status: "pending" });
  });

  it("repeated shortfalls are bounded: past MAX_LEASE_BUDGET_DEFERRALS the job fails as lease_budget_exhausted WITHOUT touching max_attempts", async () => {
    seedJob({ attempts: 3, max_attempts: 6, lease_budget_deferrals: MAX_LEASE_BUDGET_DEFERRALS });
    const analyze = vi.fn();
    const result = await processAiJob(admin(), REPORT_ID, deps(analyze, { geminiTimeoutMs: 1000 }));

    expect(analyze).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "failed", attempts: 3, kind: "lease_budget_exhausted" });
    // attempts is unchanged from before this claim (3) — the job's genuine
    // Gemini-attempt allowance (max_attempts=6) was never touched.
    expect(job()).toMatchObject({ status: "failed", attempts: 3, max_attempts: 6, lease_budget_deferrals: MAX_LEASE_BUDGET_DEFERRALS + 1 });
  });

  it("a genuine Gemini attempt resets the deferral counter", async () => {
    seedJob({ attempts: 0, lease_budget_deferrals: 5 });
    await processAiJob(admin(), REPORT_ID, deps(async () => aiResult));
    expect(job()).toMatchObject({ status: "completed", lease_budget_deferrals: 0 });
  });

  it("a genuine Gemini FAILURE also resets the deferral counter and still exhausts normally at max_attempts", async () => {
    seedJob({ attempts: 5, max_attempts: 6, lease_budget_deferrals: 3 });
    const result = await processAiJob(admin(), REPORT_ID, deps(async () => Promise.reject(aiError("503", { status: 503 }))));
    expect(result).toEqual({ outcome: "failed", attempts: 6, kind: "http_503" });
    expect(job()).toMatchObject({ status: "failed", attempts: 6, lease_budget_deferrals: 0 });
  });
});
