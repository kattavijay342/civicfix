import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeClient, type FakeDb } from "../../../test/fake-supabase";

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
  createAdminClient: () => makeFakeClient(db, { report_assignments: ["report_id"] }),
}));

const { createReport } = await import("./reports");
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
});
