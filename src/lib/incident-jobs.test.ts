import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeClient, forceNextError, clearForcedErrors, type FakeDb } from "../../test/fake-supabase";

// Real Gemini is unreachable: the real confirmSameIncident throws if touched.
vi.mock("@/lib/incident-ai-confirm", async () => {
  const actual = await vi.importActual<typeof import("./incident-ai-confirm")>("./incident-ai-confirm");
  return {
    ...actual,
    confirmSameIncident: vi.fn(async () => {
      throw new Error("real Gemini must never be called in unit tests");
    }),
  };
});
vi.mock("@/lib/notifications/targeting", () => ({ findGovernmentUsersForJurisdiction: vi.fn(async () => ["gov-1"]) }));
const routeReportSpy = vi.fn();
vi.mock("@/lib/actions/routing", () => ({
  routeReport: routeReportSpy,
  resolveAssignment: routeReportSpy,
  departmentIdForCategory: vi.fn(async () => "dept-roads"),
}));

const { runClaimedIncidentJob, classifyIncidentJobError, incidentJobRetryDelayMs, INCIDENT_JOB_POLICY } = await import("./incident-jobs");
const { MAX_LEASE_BUDGET_DEFERRALS, LEASE_BUDGET_DEFER_MS } = await import("./job-queue");
const { MIN_GEMINI_ATTEMPT_MS } = await import("./ai-jobs");
const { IncidentAIUnavailableError, confirmSameIncident, INCIDENT_CONFIRM_MODEL } = await import("./incident-ai-confirm");
const { evaluateIncidentForReport } = await import("./incident-linking");

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (t: number) => new Date(t).toISOString();

let db: FakeDb;
const admin = () => makeFakeClient(db, { incident_reports: ["incident_id", "report_id"], incident_confirmation_jobs: ["report_id"] }) as never;

function addReport(id: string, overrides: Record<string, unknown> = {}) {
  db.reports.push({
    id,
    reporter_id: "citizen-1",
    category: "road",
    status: "routed",
    severity: "medium",
    description: "Big pothole at the bus stand junction.",
    created_at: iso(NOW - DAY),
    ...overrides,
  });
  db.report_locations.push({
    report_id: id,
    display_name: "Bus Stand",
    state: "Andhra Pradesh",
    district: "Palnadu",
    constituency: "Narasaraopet",
    area: "Ward 12",
    landmark: null,
    latitude: 16.2333,
    longitude: 80.0499,
    location_source: "manual",
  });
}

/** A job as claim_due_incident_jobs returns it (attempts already +1). */
function claimedJob(overrides: Record<string, unknown> = {}) {
  const row = {
    report_id: "new",
    candidate_report_id: "cand",
    match_score: 0.6,
    status: "processing" as const,
    attempts: 1,
    max_attempts: 3,
    next_attempt_at: iso(NOW - MIN),
    locked_until: iso(NOW + 3 * MIN),
    last_error_kind: null,
    last_error_status: null,
    last_model: INCIDENT_CONFIRM_MODEL,
    ...overrides,
  };
  db.incident_confirmation_jobs.push({ ...row });
  return row;
}

const jobRow = () => db.incident_confirmation_jobs[0];
const yes = { same_incident: true, confidence: 0.9, reasoning: "Same pothole." };
const deps = (confirm: (...a: unknown[]) => Promise<unknown>) => ({ now: () => NOW, random: () => 0.5, confirm: confirm as never });
const notifications = (type: string) => db.notifications.filter((n) => n.type === type);
const snapshot = () =>
  JSON.stringify({ reports: db.reports.map((r) => [r.id, r.status, r.reporter_id]), assignments: db.report_assignments, history: db.status_history });

beforeEach(() => {
  clearForcedErrors();
  routeReportSpy.mockReset();
  vi.mocked(confirmSameIncident).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db = {
    profiles: [{ id: "gov-1", role: "government", notification_preferences: null }],
    reports: [],
    report_locations: [],
    report_assignments: [{ report_id: "new", department_id: "dept-roads", incharge_id: "incharge-1" }],
    status_history: [{ report_id: "new", old_status: "reported", new_status: "routed" }],
    ai_analyses: [],
    incident_confirmation_jobs: [],
    incident_reports: [],
    civic_incidents: [],
    department_incharges: [],
    notifications: [],
  };
  addReport("new", { created_at: iso(NOW - 60 * MIN) });
  addReport("cand");
});

describe("policy and classification", () => {
  it("backs off 1 / 5 / 15 minutes with at most 3 attempts and a 90s worker timeout", () => {
    expect([1, 2, 3].map((n) => incidentJobRetryDelayMs(n, () => 0.5))).toEqual([1 * MIN, 5 * MIN, 15 * MIN]);
    expect(INCIDENT_JOB_POLICY).toMatchObject({ maxAttempts: 3, attemptTimeoutMs: 90_000 });
    expect(INCIDENT_CONFIRM_MODEL).toBe("gemini-3.6-flash"); // unchanged model
  });

  it.each([
    [{ kind: "http", status: 503 }, { kind: "http_503", retryable: true }],
    [{ kind: "http", status: 429 }, { kind: "http_429", retryable: true }],
    [{ kind: "http", status: 500 }, { kind: "http_500", retryable: true }],
    [{ kind: "http", status: 400 }, { kind: "http_400", retryable: false }],
    [{ kind: "http", status: 401 }, { kind: "http_401", retryable: false }],
    [{ kind: "http", status: 403 }, { kind: "http_403", retryable: false }],
    [{ kind: "http", status: 404 }, { kind: "http_404", retryable: false }],
    [{ kind: "timeout" }, { kind: "timeout", retryable: true }],
    [{ kind: "network" }, { kind: "network", retryable: true }],
    [{ kind: "invalid_output" }, { kind: "invalid_output", retryable: false }],
    [{ kind: "not_configured" }, { kind: "not_configured", retryable: false }],
  ])("%o -> %o", (details, expected) => {
    expect(classifyIncidentJobError(new IncidentAIUnavailableError("x", details as never))).toMatchObject(expected);
  });
});

describe("confirmed match", () => {
  it("upgrades an existing candidate link to supporting (guarded), recomputes and notifies once", async () => {
    db.civic_incidents.push({ id: "inc-1", incident_code: "INC-1", title: "Pothole — Ward 12", department_id: "dept-roads", severity: "low", priority: "low", confidence: 0.5 });
    db.incident_reports.push(
      { incident_id: "inc-1", report_id: "cand", relationship_type: "primary", confidence: 0.8 },
      { incident_id: "inc-1", report_id: "new", relationship_type: "candidate", confidence: 0.6 }
    );
    const result = await runClaimedIncidentJob(admin(), claimedJob(), deps(async () => yes));

    expect(result).toEqual({ outcome: "confirmed", applied: "upgraded" });
    expect(db.incident_reports.find((l) => l.report_id === "new")).toMatchObject({ relationship_type: "supporting" });
    expect(db.incident_reports).toHaveLength(2);
    expect(notifications("incident_updated")).toHaveLength(1);
    expect(jobRow()).toMatchObject({ status: "completed", locked_until: null });
  });

  it("joins the candidate's incident when this report has no link yet", async () => {
    db.civic_incidents.push({ id: "inc-1", incident_code: "INC-1", title: "t", department_id: "dept-roads" });
    db.incident_reports.push({ incident_id: "inc-1", report_id: "cand", relationship_type: "primary", confidence: 0.8 });
    const result = await runClaimedIncidentJob(admin(), claimedJob(), deps(async () => yes));
    expect(result).toEqual({ outcome: "confirmed", applied: "linked" });
    expect(db.incident_reports.find((l) => l.report_id === "new")).toMatchObject({ relationship_type: "supporting", incident_id: "inc-1" });
    expect(notifications("incident_updated")).toHaveLength(1);
  });

  it("founds a new ai_confirmed incident when neither report belongs to one", async () => {
    const result = await runClaimedIncidentJob(admin(), claimedJob(), deps(async () => yes));
    expect(result).toEqual({ outcome: "confirmed", applied: "created" });
    expect(db.civic_incidents).toEqual([expect.objectContaining({ detection_method: "ai_confirmed", department_id: "dept-roads" })]);
    expect(db.incident_reports.map((l) => [l.report_id, l.relationship_type])).toEqual([
      ["cand", "primary"],
      ["new", "supporting"],
    ]);
    expect(notifications("incident_created")).toHaveLength(1);
  });

  it("a re-run after a crash (already supporting) is a no-op: no Gemini call, no second notification", async () => {
    db.civic_incidents.push({ id: "inc-1", incident_code: "INC-1", title: "t", department_id: "dept-roads" });
    db.incident_reports.push(
      { incident_id: "inc-1", report_id: "cand", relationship_type: "primary", confidence: 0.8 },
      { incident_id: "inc-1", report_id: "new", relationship_type: "supporting", confidence: 0.6 }
    );
    const confirm = vi.fn(async () => yes);
    const result = await runClaimedIncidentJob(admin(), claimedJob(), deps(confirm));
    expect(result).toEqual({ outcome: "already_linked" });
    expect(confirm).not.toHaveBeenCalled();
    expect(db.notifications).toHaveLength(0);
  });

  it("a concurrent upgrade (guarded update matches nothing) never double-notifies", async () => {
    db.civic_incidents.push({ id: "inc-1", incident_code: "INC-1", title: "t", department_id: "dept-roads" });
    db.incident_reports.push(
      { incident_id: "inc-1", report_id: "cand", relationship_type: "primary", confidence: 0.8 },
      { incident_id: "inc-1", report_id: "new", relationship_type: "candidate", confidence: 0.6 }
    );
    const result = await runClaimedIncidentJob(
      admin(),
      claimedJob(),
      deps(async () => {
        // Someone else upgraded the link while Gemini was answering.
        db.incident_reports[1].relationship_type = "supporting";
        return yes;
      })
    );
    expect(result).toEqual({ outcome: "confirmed", applied: "already_linked" });
    expect(db.notifications).toHaveLength(0);
  });

  it("a duplicate link insert (UNIQUE(incident_id, report_id)) is already_linked, not an error", async () => {
    db.civic_incidents.push({ id: "inc-1", incident_code: "INC-1", title: "t", department_id: "dept-roads" });
    db.incident_reports.push({ incident_id: "inc-1", report_id: "cand", relationship_type: "primary", confidence: 0.8 });
    const result = await runClaimedIncidentJob(
      admin(),
      claimedJob(),
      deps(async () => {
        // A concurrent writer inserted this report's link between the check and the insert.
        db.incident_reports.push({ incident_id: "inc-1", report_id: "new", relationship_type: "related", confidence: 0.7 });
        return yes;
      })
    );
    expect(result.outcome === "confirmed" && result.applied).toBe("already_linked");
    expect(db.incident_reports.filter((l) => l.report_id === "new")).toHaveLength(1);
    expect(db.notifications).toHaveLength(0);
  });
});

describe("not confirmed / not eligible", () => {
  it.each([
    [{ same_incident: false, confidence: 0.9, reasoning: "different" }],
    [{ same_incident: true, confidence: 0.4, reasoning: "unsure" }],
  ])("completes without inventing an incident (%o)", async (answer) => {
    db.civic_incidents.push({ id: "inc-1", incident_code: "INC-1", title: "t", department_id: "dept-roads" });
    db.incident_reports.push(
      { incident_id: "inc-1", report_id: "cand", relationship_type: "primary", confidence: 0.8 },
      { incident_id: "inc-1", report_id: "new", relationship_type: "candidate", confidence: 0.6 }
    );
    const result = await runClaimedIncidentJob(admin(), claimedJob(), deps(async () => answer));
    expect(result).toEqual({ outcome: "not_confirmed" });
    expect(db.incident_reports[1]).toMatchObject({ relationship_type: "candidate" });
    expect(db.civic_incidents).toHaveLength(1);
    expect(db.notifications).toHaveLength(0);
    expect(jobRow()).toMatchObject({ status: "completed" });
  });

  it.each([
    ["candidate_resolved", () => (db.reports[1].status = "resolved")],
    ["candidate_outside_window", () => (db.reports[1].created_at = iso(NOW - 31 * DAY))],
    ["category_mismatch", () => (db.reports[1].category = "garbage")],
  ])("re-checks eligibility before calling Gemini (%s)", async (reason, mutate) => {
    mutate();
    const confirm = vi.fn(async () => yes);
    const result = await runClaimedIncidentJob(admin(), claimedJob(), deps(confirm));
    expect(result).toEqual({ outcome: "not_eligible", reason });
    expect(confirm).not.toHaveBeenCalled();
    expect(jobRow()).toMatchObject({ status: "completed", last_error_kind: "not_eligible" });
  });

  it("a deleted report fails the job permanently without calling Gemini", async () => {
    db.reports = db.reports.filter((r) => r.id !== "cand");
    const confirm = vi.fn(async () => yes);
    const result = await runClaimedIncidentJob(admin(), claimedJob(), deps(confirm));
    expect(result).toEqual({ outcome: "failed", attempts: 1, kind: "report_missing" });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("failures and retries", () => {
  it.each([
    ["503", { kind: "http", status: 503 }, "http_503"],
    ["429", { kind: "http", status: 429 }, "http_429"],
    ["timeout", { kind: "timeout" }, "timeout"],
    ["network", { kind: "network" }, "network"],
  ])("transient %s schedules a retry in 1 minute", async (_label, details, kind) => {
    const result = await runClaimedIncidentJob(
      admin(),
      claimedJob(),
      deps(async () => Promise.reject(new IncidentAIUnavailableError("provider text", details as never)))
    );
    expect(result).toEqual({ outcome: "retry_scheduled", attempts: 1, nextAttemptAt: iso(NOW + MIN), kind });
    expect(jobRow()).toMatchObject({ status: "pending", locked_until: null, next_attempt_at: iso(NOW + MIN), last_error_kind: kind });
    expect(JSON.stringify(jobRow())).not.toContain("provider text");
  });

  it("the second failed attempt backs off 5 minutes", async () => {
    const result = await runClaimedIncidentJob(
      admin(),
      claimedJob({ attempts: 2 }),
      deps(async () => Promise.reject(new IncidentAIUnavailableError("x", { kind: "http", status: 503 })))
    );
    expect(result).toMatchObject({ outcome: "retry_scheduled", nextAttemptAt: iso(NOW + 5 * MIN) });
  });

  it.each([
    ["400", { kind: "http", status: 400 }, "http_400"],
    ["401", { kind: "http", status: 401 }, "http_401"],
    ["403", { kind: "http", status: 403 }, "http_403"],
    ["404 (model not found)", { kind: "http", status: 404 }, "http_404"],
    ["invalid output", { kind: "invalid_output" }, "invalid_output"],
  ])("permanent %s fails immediately; the candidate link stays as it was", async (_label, details, kind) => {
    const result = await runClaimedIncidentJob(
      admin(),
      claimedJob(),
      deps(async () => Promise.reject(new IncidentAIUnavailableError("x", details as never)))
    );
    expect(result).toEqual({ outcome: "failed", attempts: 1, kind });
    expect(jobRow()).toMatchObject({ status: "failed", last_error_kind: kind });
    expect(db.civic_incidents).toHaveLength(0);
  });

  it("the 3rd transient failure fails the job (retry limit)", async () => {
    const result = await runClaimedIncidentJob(
      admin(),
      claimedJob({ attempts: 3 }),
      deps(async () => Promise.reject(new IncidentAIUnavailableError("x", { kind: "http", status: 503 })))
    );
    expect(result).toEqual({ outcome: "failed", attempts: 3, kind: "http_503" });
  });

  it("a superseded claim (lease taken over) cannot overwrite the newer state", async () => {
    const job = claimedJob();
    const result = await runClaimedIncidentJob(
      admin(),
      job,
      deps(async () => {
        jobRow().attempts = 2; // re-claimed by another worker
        throw new IncidentAIUnavailableError("x", { kind: "http", status: 503 });
      })
    );
    expect(result).toEqual({ outcome: "lost_lease" });
    expect(jobRow()).toMatchObject({ status: "processing", attempts: 2 });
  });
});

describe("invariants", () => {
  it("never routes and never changes report status, ownership, assignments or history", async () => {
    const before = snapshot();
    await runClaimedIncidentJob(admin(), claimedJob(), deps(async () => yes));
    expect(snapshot()).toBe(before);
    expect(routeReportSpy).not.toHaveBeenCalled();
    expect(vi.mocked(confirmSameIncident)).not.toHaveBeenCalled();
  });
});

describe("submission path: defer mode (evaluateIncidentForReport)", () => {
  /** A candidate in the ambiguous band: same area, unrelated wording, 1 day apart. */
  function ambiguousInput() {
    return {
      reportId: "new",
      category: "ROAD" as const,
      description: "Streetside drain cover broken near the temple entrance.",
      location: {
        displayName: "Bus Stand",
        district: "Palnadu",
        constituency: "Narasaraopet",
        area: "Ward 12",
        latitude: null,
        longitude: null,
        source: "manual" as const,
      },
      createdAt: iso(Date.now()),
      severity: null,
      departmentId: "dept-roads",
    };
  }

  beforeEach(() => {
    db.reports[1].created_at = iso(Date.now() - DAY);
  });

  it("makes ZERO Gemini calls and queues one confirmation job", async () => {
    await evaluateIncidentForReport(admin(), ambiguousInput());
    expect(vi.mocked(confirmSameIncident)).not.toHaveBeenCalled();
    expect(db.incident_confirmation_jobs).toEqual([
      expect.objectContaining({ report_id: "new", candidate_report_id: "cand", status: "pending" }),
    ]);
  });

  it("keeps the existing candidate-link behaviour when the candidate already has an incident", async () => {
    db.civic_incidents.push({ id: "inc-1", incident_code: "INC-1", title: "t", department_id: "dept-roads" });
    db.incident_reports.push({ incident_id: "inc-1", report_id: "cand", relationship_type: "primary", confidence: 0.8 });
    await evaluateIncidentForReport(admin(), ambiguousInput());
    expect(db.incident_reports.find((l) => l.report_id === "new")).toMatchObject({ relationship_type: "candidate" });
    expect(db.notifications).toHaveLength(0); // candidates never notify
  });

  it("re-evaluating the same report does not queue a second job", async () => {
    await evaluateIncidentForReport(admin(), ambiguousInput());
    await evaluateIncidentForReport(admin(), ambiguousInput());
    expect(db.incident_confirmation_jobs).toHaveLength(1);
  });

  it("an enqueue failure never breaks linking", async () => {
    forceNextError("incident_confirmation_jobs", "insert failed");
    await expect(evaluateIncidentForReport(admin(), ambiguousInput())).resolves.toBeUndefined();
    expect(db.incident_confirmation_jobs).toHaveLength(0);
  });
});

// CP2.3 (M-1): identical semantics to the AI job queue — a lease-budget
// shortfall must never consume a genuine Gemini attempt, must stay
// bounded, and must not interfere with genuine failures' own exhaustion.
describe("runClaimedIncidentJob — lease-budget shortfall (CP2.3 M-1)", () => {
  it("gives the claimed attempt back and reschedules — no Gemini call, attempts unchanged, one deferral recorded", async () => {
    const claimed = claimedJob({ attempts: 2, max_attempts: 3 });
    const confirm = vi.fn();
    const result = await runClaimedIncidentJob(admin(), claimed, { ...deps(confirm), geminiTimeoutMs: MIN_GEMINI_ATTEMPT_MS - 1 });

    expect(confirm).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "retry_scheduled", attempts: 1, nextAttemptAt: iso(NOW + LEASE_BUDGET_DEFER_MS), kind: "lease_budget" });
    expect(jobRow()).toMatchObject({
      status: "pending",
      attempts: 1, // given back — NOT consumed (claimedJob's attempts:2 is post-claim)
      max_attempts: 3,
      last_error_kind: "lease_budget",
      lease_budget_deferrals: 1,
    });
  });

  it("stays retryable even on what would have been the FINAL attempt", async () => {
    const claimed = claimedJob({ attempts: 3, max_attempts: 3 }); // claim brought attempts to max
    const confirm = vi.fn();
    const result = await runClaimedIncidentJob(admin(), claimed, { ...deps(confirm), geminiTimeoutMs: 1000 });

    expect(confirm).not.toHaveBeenCalled();
    expect(result.outcome).toBe("retry_scheduled"); // NOT "failed"
    expect(jobRow()).toMatchObject({ status: "pending", attempts: 2 });
  });

  it("repeated shortfalls are bounded: past MAX_LEASE_BUDGET_DEFERRALS the job fails as lease_budget_exhausted WITHOUT touching max_attempts", async () => {
    const claimed = claimedJob({ attempts: 1, max_attempts: 3, lease_budget_deferrals: MAX_LEASE_BUDGET_DEFERRALS });
    const confirm = vi.fn();
    const result = await runClaimedIncidentJob(admin(), claimed, { ...deps(confirm), geminiTimeoutMs: 1000 });

    expect(confirm).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "failed", attempts: 0, kind: "lease_budget_exhausted" });
    expect(jobRow()).toMatchObject({ status: "failed", attempts: 0, max_attempts: 3, lease_budget_deferrals: MAX_LEASE_BUDGET_DEFERRALS + 1 });
  });

  it("a genuine confirmation (any outcome) resets the deferral counter", async () => {
    const claimed = claimedJob({ attempts: 1, lease_budget_deferrals: 5 });
    await runClaimedIncidentJob(admin(), claimed, deps(async () => ({ same_incident: false, confidence: 0.2, reasoning: "different" })));
    expect(jobRow()).toMatchObject({ status: "completed", lease_budget_deferrals: 0 });
  });

  it("a genuine Gemini FAILURE also resets the deferral counter and still exhausts normally at max_attempts", async () => {
    const claimed = claimedJob({ attempts: 3, max_attempts: 3, lease_budget_deferrals: 2 });
    const result = await runClaimedIncidentJob(
      admin(),
      claimed,
      deps(async () => Promise.reject(new IncidentAIUnavailableError("x", { kind: "http", status: 503 } as never)))
    );
    expect(result).toEqual({ outcome: "failed", attempts: 3, kind: "http_503" });
    expect(jobRow()).toMatchObject({ status: "failed", attempts: 3, lease_budget_deferrals: 0 });
  });
});
