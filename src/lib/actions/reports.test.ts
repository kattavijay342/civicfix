import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeClient, forceNextError, clearForcedErrors, type FakeDb } from "../../../test/fake-supabase";

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  retryAfterMessage: () => "Too many attempts.",
}));
vi.mock("@/lib/idempotency", () => ({
  beginIdempotentAction: vi.fn(async () => ({ kind: "new", commit: vi.fn(), release: vi.fn() })),
}));
vi.mock("@/lib/duplicate-detection", () => ({ findPossibleDuplicate: vi.fn(async () => null) }));
vi.mock("@/lib/incident-linking", () => ({ evaluateIncidentForReport: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications/new-report", () => ({ notifyGovernmentOfNewReport: vi.fn(async () => 0) }));
vi.mock("@/lib/notifications/targeting", () => ({ findGovernmentUsersForJurisdiction: vi.fn(async () => []) }));

const analyzeReportMock = vi.fn();
vi.mock("@/lib/ai", () => ({
  analyzeReport: analyzeReportMock,
  // The budgeted wrapper's own retry/timeout rules are unit-tested in
  // src/lib/ai.test.ts; here each call is one analysis attempt.
  analyzeReportWithinBudget: (input: unknown) => analyzeReportMock(input),
  AIUnavailableError: class extends Error {},
}));

const CITIZEN_ID = "citizen-1";
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: CITIZEN_ID } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: { full_name: "Test Citizen", mobile_number: "+919876500001" } }) }),
      }),
    }),
  })),
}));

let db: FakeDb;
vi.mock("@/lib/supabase/admin", () => ({
  // Mirrors the real UNIQUE constraints these flows rely on.
  createAdminClient: () =>
    makeFakeClient(db, {
      report_assignments: ["report_id"],
      ai_analyses: ["report_id"],
      idempotency_keys: ["user_id", "action", "client_key"],
    }),
}));

const { createReport, retryAiAnalysis } = await import("./reports");
const { beginIdempotentAction } = await import("@/lib/idempotency");
const actualIdempotency = await vi.importActual<typeof import("@/lib/idempotency")>("@/lib/idempotency");
const { evaluateIncidentForReport } = await import("@/lib/incident-linking");
const { notifyGovernmentOfNewReport } = await import("@/lib/notifications/new-report");

const NARASARAOPET_SCOPE = {
  gov_state: "Andhra Pradesh",
  gov_district: "Palnadu",
  gov_constituency: "Narasaraopet",
  gov_area: "Narasaraopet Municipality",
};

function reportForm(extra: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("description", "Large pothole near RTC Bus Stand causing two-wheeler accidents.");
  fd.set("category", "ROAD");
  fd.set("reporterName", "Test Citizen");
  fd.set("reporterMobile", "9876500001");
  fd.set(
    "location",
    JSON.stringify({
      displayName: "RTC Bus Stand, Narasaraopet",
      state: "Andhra Pradesh",
      district: "Palnadu",
      constituency: "Narasaraopet",
      area: "Narasaraopet Municipality",
      source: "manual",
    })
  );
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

const aiResult = {
  problem_summary: "Large pothole on main road",
  category: "road",
  subcategory: "pothole",
  severity: "high",
  priority: "high",
  reasoning: "Safety risk",
  severity_reasoning: "Deep",
  priority_reasoning: "Busy road",
  recommended_department: "Roads & Infrastructure",
  recommended_action: "Repair",
  action_steps: ["Inspect", "Repair"],
  confidence: 0.9,
  affected_infrastructure: null,
  urgency_factors: null,
  safety_risk: null,
  affected_population: null,
  time_context: null,
  location_context: null,
  evidence: null,
  complaint_subject: "Pothole",
  complaint_impact: "Risk",
  complaint_action: "Repair",
  model: "test-model",
};

beforeEach(() => {
  clearForcedErrors();
  vi.mocked(beginIdempotentAction).mockImplementation(async () => ({ kind: "run", commit: vi.fn(), release: vi.fn() }));
  analyzeReportMock.mockReset();
  vi.mocked(evaluateIncidentForReport).mockClear();
  vi.mocked(notifyGovernmentOfNewReport).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = {
    profiles: [
      { id: CITIZEN_ID, role: "citizen", notification_preferences: null },
      { id: "roads-incharge", role: "department_incharge", department_id: "dept-roads", notification_preferences: null },
      { id: "water-incharge", role: "department_incharge", department_id: "dept-water", notification_preferences: null },
    ],
    departments: [
      { id: "dept-roads", name: "Roads & Infrastructure" },
      { id: "dept-water", name: "Water Supply" },
    ],
    department_incharges: [
      { profile_id: "roads-incharge", department_id: "dept-roads", is_active: true, created_at: "2026-09-01", ...NARASARAOPET_SCOPE },
      { profile_id: "water-incharge", department_id: "dept-water", is_active: true, created_at: "2026-09-01", ...NARASARAOPET_SCOPE },
    ],
    reports: [],
    report_locations: [],
    report_assignments: [],
    ai_analyses: [],
    status_history: [],
    notifications: [],
  };
});

describe("createReport — G3 routing", () => {
  it("AI success: gives the AI the configured departments and routes to the authorized in-charge", async () => {
    analyzeReportMock.mockResolvedValue(aiResult);
    const result = await createReport({ status: "idle" }, reportForm());

    expect(result).toMatchObject({ status: "success", aiFailed: false });
    expect(analyzeReportMock.mock.calls[0][0].departmentNames).toEqual(["Roads & Infrastructure", "Water Supply"]);
    expect(db.report_assignments).toHaveLength(1);
    expect(db.report_assignments[0]).toMatchObject({ department_id: "dept-roads", incharge_id: "roads-incharge" });
    expect(db.reports[0].status).toBe("routed");
    expect(db.notifications.filter((n) => n.type === "report_assigned").map((n) => n.recipient_id)).toEqual([
      "roads-incharge",
    ]);
    // The incident is owned by the department the report was actually routed to.
    expect(vi.mocked(evaluateIncidentForReport).mock.calls[0][1]).toMatchObject({ departmentId: "dept-roads" });
  });

  it("ignores client-supplied department/assignee fields — the server derives the assignment", async () => {
    analyzeReportMock.mockResolvedValue(aiResult);
    await createReport(
      { status: "idle" },
      reportForm({ department_id: "dept-water", departmentId: "dept-water", assigned_user_id: "water-incharge", incharge_id: "water-incharge" })
    );

    expect(db.report_assignments[0]).toMatchObject({ department_id: "dept-roads", incharge_id: "roads-incharge" });
    expect(db.notifications.some((n) => n.recipient_id === "water-incharge")).toBe(false);
  });

  it("AI failure: the report is saved and stays visible, but is NOT routed and no department is invented", async () => {
    analyzeReportMock.mockRejectedValue(new Error("503 Service Unavailable"));
    const result = await createReport({ status: "idle" }, reportForm());

    expect(result).toMatchObject({ status: "success", aiFailed: true });
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].status).toBe("reported");
    expect(db.report_locations[0]).toMatchObject({ area: "Narasaraopet Municipality" });
    expect(db.ai_analyses).toHaveLength(0);
    expect(db.report_assignments).toHaveLength(0);
    expect(db.notifications.some((n) => n.type === "report_assigned")).toBe(false);
    // Government jurisdiction notification still goes out, with priority null (never guessed).
    expect(vi.mocked(notifyGovernmentOfNewReport).mock.calls[0][1]).toMatchObject({ priority: null });
  }, 10_000);

  it("ai_analyses insert failure: report stays `reported` (retryable) — not analyzed, not routed, no success history/notifications", async () => {
    analyzeReportMock.mockResolvedValue(aiResult);
    forceNextError("ai_analyses", "insert failed");
    const result = await createReport({ status: "idle" }, reportForm());

    expect(result).toMatchObject({ status: "success", aiFailed: true });
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].status).toBe("reported");
    expect(db.ai_analyses).toHaveLength(0);
    expect(db.report_assignments).toHaveLength(0);
    expect(db.status_history.some((h) => h.new_status === "ai_analyzed" || h.new_status === "routed")).toBe(false);
    expect(db.notifications.some((n) => n.type === "ai_analysis_completed" || n.type === "report_assigned")).toBe(false);
    expect(vi.mocked(notifyGovernmentOfNewReport).mock.calls[0][1]).toMatchObject({ priority: null });
  });

  it("makes exactly one analysis request on the normal success path", async () => {
    analyzeReportMock.mockResolvedValue(aiResult);
    await createReport({ status: "idle" }, reportForm());
    expect(analyzeReportMock).toHaveBeenCalledTimes(1);
    expect(db.ai_analyses).toHaveLength(1);
    expect(db.status_history.filter((h) => h.new_status === "ai_analyzed")).toHaveLength(1);
  });
});

describe("retryAiAnalysis — persistence and duplicate protection", () => {
  const REPORT_ID = "report-retry-1";

  function seedReportedReport() {
    db.reports.push({
      id: REPORT_ID,
      reporter_id: CITIZEN_ID,
      title: "Pothole near RTC Bus Stand",
      description: "Large pothole near RTC Bus Stand causing two-wheeler accidents.",
      category: "road",
      status: "reported",
    });
    db.report_locations.push({
      report_id: REPORT_ID,
      display_name: "RTC Bus Stand, Narasaraopet",
      location_source: "manual",
      state: "Andhra Pradesh",
      district: "Palnadu",
      constituency: "Narasaraopet",
      area: "Narasaraopet Municipality",
      landmark: null,
      latitude: null,
      longitude: null,
    });
    db.idempotency_keys = [];
  }

  const successHistory = () => db.status_history.filter((h) => h.new_status === "ai_analyzed");
  const aiDoneNotifications = () => db.notifications.filter((n) => n.type === "ai_analysis_completed");

  it("success: analyzes, routes to the authorized in-charge, one history entry and one notification", async () => {
    seedReportedReport();
    analyzeReportMock.mockResolvedValue(aiResult);
    expect(await retryAiAnalysis(REPORT_ID)).toEqual({});
    expect(analyzeReportMock).toHaveBeenCalledTimes(1);
    expect(db.ai_analyses).toHaveLength(1);
    expect(db.report_assignments).toEqual([expect.objectContaining({ department_id: "dept-roads", incharge_id: "roads-incharge" })]);
    expect(successHistory()).toHaveLength(1);
    expect(aiDoneNotifications()).toHaveLength(1);
  });

  it("two concurrent retries (double click / second tab): only ONE calls Gemini; no duplicate routing, history or notifications", async () => {
    seedReportedReport();
    vi.mocked(beginIdempotentAction).mockImplementation(actualIdempotency.beginIdempotentAction);
    analyzeReportMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return aiResult;
    });

    const [a, b] = await Promise.all([retryAiAnalysis(REPORT_ID), retryAiAnalysis(REPORT_ID)]);

    expect(analyzeReportMock).toHaveBeenCalledTimes(1);
    expect([a, b]).toContainEqual({});
    expect([a, b]).toContainEqual({ error: expect.stringMatching(/already being retried/) });
    expect(db.ai_analyses).toHaveLength(1);
    expect(db.report_assignments).toHaveLength(1);
    expect(successHistory()).toHaveLength(1);
    expect(aiDoneNotifications()).toHaveLength(1);
    expect(db.notifications.filter((n) => n.type === "report_assigned")).toHaveLength(1);
    // The finished claim replays its result instead of re-running.
    expect(await retryAiAnalysis(REPORT_ID)).toEqual({});
    expect(analyzeReportMock).toHaveBeenCalledTimes(1);
  });

  it("database backstop: if both requests got past the claim, UNIQUE(report_id) stops the second before any side effect", async () => {
    seedReportedReport();
    // Idempotency failing open (e.g. its table unavailable): both requests run.
    vi.mocked(beginIdempotentAction).mockImplementation(async () => ({ kind: "run", commit: vi.fn(), release: vi.fn() }));
    analyzeReportMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return aiResult;
    });

    const results = await Promise.all([retryAiAnalysis(REPORT_ID), retryAiAnalysis(REPORT_ID)]);

    expect(results).toEqual([{}, {}]);
    expect(db.ai_analyses).toHaveLength(1);
    expect(db.report_assignments).toHaveLength(1);
    expect(successHistory()).toHaveLength(1);
    expect(aiDoneNotifications()).toHaveLength(1);
    expect(db.notifications.filter((n) => n.type === "report_assigned")).toHaveLength(1);
  });

  it("ai_analyses insert failure: stays `reported` and retryable, no side effects, claim released", async () => {
    seedReportedReport();
    const release = vi.fn();
    const commit = vi.fn();
    vi.mocked(beginIdempotentAction).mockImplementation(async () => ({ kind: "run", commit, release }));
    analyzeReportMock.mockResolvedValue(aiResult);
    forceNextError("ai_analyses", "insert failed");

    expect(await retryAiAnalysis(REPORT_ID)).toEqual({ error: "AI analysis is temporarily unavailable." });
    expect(db.reports[0].status).toBe("reported");
    expect(db.ai_analyses).toHaveLength(0);
    expect(db.report_assignments).toHaveLength(0);
    expect(successHistory()).toHaveLength(0);
    expect(aiDoneNotifications()).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it("status update failure: the inserted analysis row is reverted so the report stays retryable", async () => {
    seedReportedReport();
    vi.mocked(beginIdempotentAction).mockImplementation(async () => ({ kind: "run", commit: vi.fn(), release: vi.fn() }));
    analyzeReportMock.mockResolvedValue(aiResult);
    forceNextError("reports", "update failed");

    expect(await retryAiAnalysis(REPORT_ID)).toEqual({ error: "AI analysis is temporarily unavailable." });
    clearForcedErrors();
    expect(db.reports[0].status).toBe("reported");
    expect(db.ai_analyses).toHaveLength(0);
    expect(db.report_assignments).toHaveLength(0);
    expect(successHistory()).toHaveLength(0);

    // ...and a later retry succeeds normally.
    expect(await retryAiAnalysis(REPORT_ID)).toEqual({});
    expect(db.reports[0].status).toBe("routed");
    expect(db.ai_analyses).toHaveLength(1);
  });

  it("Gemini unavailable: no write at all, claim released for a later retry", async () => {
    seedReportedReport();
    const release = vi.fn();
    vi.mocked(beginIdempotentAction).mockImplementation(async () => ({ kind: "run", commit: vi.fn(), release }));
    analyzeReportMock.mockRejectedValue(new Error("503 high demand"));

    expect(await retryAiAnalysis(REPORT_ID)).toEqual({ error: "AI analysis is temporarily unavailable." });
    expect(db.reports[0].status).toBe("reported");
    expect(db.ai_analyses).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("claims per report BEFORE calling Gemini, keyed by report id and a time window", async () => {
    seedReportedReport();
    const order: string[] = [];
    vi.mocked(beginIdempotentAction).mockImplementation(async (_admin, _user, action, key) => {
      order.push(`claim:${action}:${String(key).split(":")[0]}`);
      return { kind: "in_progress" };
    });
    analyzeReportMock.mockImplementation(async () => {
      order.push("gemini");
      return aiResult;
    });

    expect(await retryAiAnalysis(REPORT_ID)).toEqual({ error: expect.stringMatching(/already being retried/) });
    expect(order).toEqual([`claim:retry_ai_analysis:${REPORT_ID}`]);
  });
});
