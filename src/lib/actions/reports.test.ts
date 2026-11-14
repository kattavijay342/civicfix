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
/** In-memory stand-in for the `report-media` Storage bucket. */
const storage = { objects: new Map<string, Buffer>(), failUpload: false };
vi.mock("@/lib/supabase/admin", () => ({
  // Mirrors the real UNIQUE constraints these flows rely on.
  createAdminClient: () => ({
    ...makeFakeClient(db, {
      report_assignments: ["report_id"],
      ai_analyses: ["report_id"],
      idempotency_keys: ["user_id", "action", "client_key"],
      ai_analysis_jobs: ["report_id"],
    }),
    storage: {
      from: () => ({
        upload: async (path: string, buffer: Buffer) => {
          if (storage.failUpload) return { data: null, error: { message: "simulated storage outage" } };
          storage.objects.set(path, buffer);
          return { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          for (const p of paths) storage.objects.delete(p);
          return { data: paths.map((name) => ({ name })), error: null };
        },
      }),
    },
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
  storage.objects.clear();
  storage.failUpload = false;
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

const assignedNotifications = () => db.notifications.filter((n) => n.type === "report_assigned");
const routedHistory = () => db.status_history.filter((h) => h.new_status === "routed");

/** Failures shaped like the AIUnavailableError analyzeReportWithinBudget throws. */
function geminiError(message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { name: "AIUnavailableError", transient: true, ...extra });
}

describe("createReport — direct department routing, AI queued (never inline)", () => {
  const aiJobs = () => db.ai_analysis_jobs ?? [];

  it("normal submission: saved, routed to the authorized in-charge by category, in-charge notified once, AI job queued", async () => {
    const result = await createReport({ status: "idle" }, reportForm());

    expect(result).toMatchObject({ status: "success", aiQueued: true });
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].status).toBe("routed");
    expect(db.report_assignments).toEqual([
      expect.objectContaining({ department_id: "dept-roads", incharge_id: "roads-incharge", assignment_method: "auto" }),
    ]);
    expect(routedHistory()).toEqual([expect.objectContaining({ old_status: "reported", new_status: "routed" })]);
    expect(assignedNotifications().map((n) => n.recipient_id)).toEqual(["roads-incharge"]);
    // The incident is owned by the department the report was actually routed to.
    expect(vi.mocked(evaluateIncidentForReport).mock.calls[0][1]).toMatchObject({ departmentId: "dept-roads" });
    // Exactly one pending AI job for the saved report.
    expect(aiJobs()).toEqual([expect.objectContaining({ report_id: db.reports[0].id, status: "pending" })]);
  });

  it("never calls Gemini during submission: no analysis, no AI notification, priority/severity left unknown", async () => {
    analyzeReportMock.mockResolvedValue(aiResult);
    await createReport({ status: "idle" }, reportForm());

    expect(analyzeReportMock).not.toHaveBeenCalled();
    expect(db.ai_analyses).toHaveLength(0);
    expect(db.reports[0]).toMatchObject({ status: "routed" });
    expect(db.reports[0].priority ?? null).toBeNull();
    expect(db.status_history.some((h) => h.new_status === "ai_analyzed")).toBe(false);
    expect(db.notifications.some((n) => n.type === "ai_analysis_completed")).toBe(false);
    // Government jurisdiction notification still goes out, with priority null (never guessed).
    expect(vi.mocked(notifyGovernmentOfNewReport).mock.calls[0][1]).toMatchObject({ priority: null });
    expect(vi.mocked(evaluateIncidentForReport).mock.calls[0][1]).toMatchObject({ subcategory: null, severity: null });
  });

  it("ignores client-supplied department/assignee fields — the server derives the assignment", async () => {
    await createReport(
      { status: "idle" },
      reportForm({ department_id: "dept-water", departmentId: "dept-water", assigned_user_id: "water-incharge", incharge_id: "water-incharge" })
    );

    expect(db.report_assignments[0]).toMatchObject({ department_id: "dept-roads", incharge_id: "roads-incharge" });
    expect(db.notifications.some((n) => n.recipient_id === "water-incharge")).toBe(false);
  });

  it("Gemini being down cannot affect submission: routed exactly once, AI job queued", async () => {
    analyzeReportMock.mockRejectedValue(geminiError("503 high demand", { status: 503 }));
    const result = await createReport({ status: "idle" }, reportForm());

    expect(result).toMatchObject({ status: "success", aiQueued: true });
    expect(analyzeReportMock).not.toHaveBeenCalled();
    expect(db.reports[0].status).toBe("routed");
    expect(routedHistory()).toHaveLength(1);
    expect(assignedNotifications()).toHaveLength(1);
    expect(aiJobs()).toHaveLength(1);
  });

  it("AI job enqueue failure: report still saved and routed, reported honestly as NOT queued", async () => {
    forceNextError("ai_analysis_jobs", "insert failed");
    const result = await createReport({ status: "idle" }, reportForm());

    expect(result).toMatchObject({ status: "success", aiQueued: false });
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].status).toBe("routed");
    expect(db.report_assignments).toHaveLength(1);
    expect(aiJobs()).toHaveLength(0);
    expect(analyzeReportMock).not.toHaveBeenCalled();
  });

  it("no configured department for the category: saved and visible, left unrouted — AI job still queued", async () => {
    db.departments = db.departments.filter((d) => d.id !== "dept-roads");
    const result = await createReport({ status: "idle" }, reportForm());

    expect(result).toMatchObject({ status: "success", aiQueued: true });
    expect(db.reports[0].status).toBe("reported");
    expect(db.report_assignments).toHaveLength(0);
    expect(assignedNotifications()).toHaveLength(0);
    // AI enrichment is independent of routing and is still queued.
    expect(aiJobs()).toHaveLength(1);
  });

  it("a repeated submission with the same idempotency key replays — no second report, routing, job or Gemini call", async () => {
    vi.mocked(beginIdempotentAction).mockImplementation(actualIdempotency.beginIdempotentAction);
    db.idempotency_keys = [];

    const first = await createReport({ status: "idle" }, reportForm({ idempotencyKey: "key-1" }));
    const second = await createReport({ status: "idle" }, reportForm({ idempotencyKey: "key-1" }));

    expect(second).toEqual(first);
    expect(db.reports).toHaveLength(1);
    expect(db.report_assignments).toHaveLength(1);
    expect(aiJobs()).toHaveLength(1);
    expect(analyzeReportMock).not.toHaveBeenCalled();
    expect(assignedNotifications()).toHaveLength(1);
  });
});

describe("createReport — location coordinates are validated server-side", () => {
  function formWithLocation(loc: Record<string, unknown>) {
    return reportForm({
      location: JSON.stringify({
        displayName: "RTC Bus Stand, Narasaraopet",
        state: "Andhra Pradesh",
        district: "Palnadu",
        constituency: "Narasaraopet",
        area: "Narasaraopet Municipality",
        ...loc,
      }),
    });
  }

  it("stores a valid GPS fix with its source and accuracy", async () => {
    const result = await createReport(
      { status: "idle" },
      formWithLocation({ source: "gps", latitude: 16.2354, longitude: 80.0479, accuracy: 12.5 })
    );

    expect(result).toMatchObject({ status: "success" });
    expect(db.report_locations).toEqual([
      expect.objectContaining({ latitude: 16.2354, longitude: 80.0479, location_source: "gps", accuracy_meters: 12.5 }),
    ]);
  });

  it("stores a map-pin or search selection as given, without accuracy", async () => {
    await createReport({ status: "idle" }, formWithLocation({ source: "search", latitude: 16.24, longitude: 80.05 }));

    const loc = db.report_locations[0];
    expect(loc).toMatchObject({ latitude: 16.24, longitude: 80.05, location_source: "search" });
    expect(loc.accuracy_meters ?? null).toBeNull();
  });

  it.each([
    ["out-of-range latitude", { latitude: 123, longitude: 80.05 }],
    ["out-of-range longitude", { latitude: 16.24, longitude: 200 }],
    ["non-numeric values", { latitude: "16.24", longitude: "80.05" }],
    ["only one coordinate", { latitude: 16.24 }],
  ])("drops %s: null coordinates, source downgraded to manual, never (0, 0)", async (_label, coords) => {
    const result = await createReport({ status: "idle" }, formWithLocation({ source: "gps", accuracy: 5, ...coords }));

    expect(result).toMatchObject({ status: "success" });
    const loc = db.report_locations[0];
    expect(loc).toMatchObject({ latitude: null, longitude: null, location_source: "manual" });
    expect(loc.accuracy_meters ?? null).toBeNull();
  });

  it("drops an invalid accuracy but keeps otherwise-valid GPS coordinates", async () => {
    await createReport(
      { status: "idle" },
      formWithLocation({ source: "gps", latitude: 16.2354, longitude: 80.0479, accuracy: -3 })
    );

    const loc = db.report_locations[0];
    expect(loc).toMatchObject({ latitude: 16.2354, longitude: 80.0479, location_source: "gps" });
    expect(loc.accuracy_meters ?? null).toBeNull();
  });

  it("still routes and queues AI for a report without coordinates (manual jurisdiction only)", async () => {
    const result = await createReport({ status: "idle" }, reportForm());

    expect(result).toMatchObject({ status: "success", aiQueued: true });
    expect(db.report_locations[0]).toMatchObject({ latitude: null, longitude: null, location_source: "manual" });
    expect(db.report_assignments).toHaveLength(1);
  });
});

describe("createReport — photo upload never leaves a stray report", () => {
  /** A real JPEG signature followed by filler bytes. */
  const jpegBytes = (size = 64) => {
    const b = Buffer.alloc(size, 0);
    b[0] = 0xff;
    b[1] = 0xd8;
    b[2] = 0xff;
    return b;
  };
  const withPhoto = (bytes: Buffer, type = "image/jpeg", name = "evidence.jpg") => {
    const fd = reportForm();
    fd.set("photo", new File([new Uint8Array(bytes)], name, { type }));
    return fd;
  };
  /** Every record a submission can create — all must stay empty on failure. */
  const nothingCreated = () => {
    expect(db.reports).toHaveLength(0);
    expect(db.report_locations).toHaveLength(0);
    expect(db.report_assignments).toHaveLength(0);
    expect(db.notifications).toHaveLength(0);
    expect(db.report_media ?? []).toHaveLength(0);
    expect(db.ai_analysis_jobs ?? []).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
  };

  it("oversized image: clear error, and no report, location, assignment, notification or storage object", async () => {
    const result = await createReport({ status: "idle" }, withPhoto(jpegBytes(8 * 1024 * 1024 + 1)));

    expect(result).toEqual({ status: "error", error: "Photo is too large (8MB max)." });
    nothingCreated();
  });

  it("spoofed image (claims image/jpeg, content is text): rejected before anything is written", async () => {
    const spoofed = Buffer.from("This is definitely not a JPEG — just plain text pretending to be one.");
    const result = await createReport({ status: "idle" }, withPhoto(spoofed, "image/jpeg"));

    expect(result).toEqual({ status: "error", error: "Please upload a JPEG, PNG, WEBP, or HEIC photo." });
    nothingCreated();
  });

  it("disallowed declared type (e.g. a PDF): rejected before anything is written", async () => {
    const result = await createReport({ status: "idle" }, withPhoto(jpegBytes(), "application/pdf", "evidence.pdf"));

    expect(result).toMatchObject({ status: "error" });
    nothingCreated();
  });

  it("valid image: report saved, photo stored under the report's path, media row recorded, citizen notified once", async () => {
    const result = await createReport({ status: "idle" }, withPhoto(jpegBytes()));

    expect(result).toMatchObject({ status: "success" });
    const reportId = db.reports[0].id as string;
    expect(storage.objects.size).toBe(1);
    const [path] = [...storage.objects.keys()];
    expect(path).toMatch(new RegExp(`^${CITIZEN_ID}/${reportId}/[0-9a-f-]+\\.jpg$`));
    expect(db.report_media).toEqual([
      expect.objectContaining({ report_id: reportId, file_path: path, mime_type: "image/jpeg", file_type: "image", kind: "evidence" }),
    ]);
    expect(db.notifications.filter((n) => n.type === "report_created")).toHaveLength(1);
    expect(db.report_assignments).toHaveLength(1);
  });

  it("no photo (optional): report saved and routed, nothing uploaded", async () => {
    const result = await createReport({ status: "idle" }, reportForm());

    expect(result).toMatchObject({ status: "success" });
    expect(db.reports).toHaveLength(1);
    expect(storage.objects.size).toBe(0);
    expect(db.report_media ?? []).toHaveLength(0);
    expect(db.notifications.filter((n) => n.type === "report_created")).toHaveLength(1);
  });

  it("an empty file part is treated as no photo", async () => {
    const result = await createReport({ status: "idle" }, withPhoto(Buffer.alloc(0)));

    expect(result).toMatchObject({ status: "success" });
    expect(storage.objects.size).toBe(0);
  });

  it("storage upload failure: error returned and the partially created report is fully discarded", async () => {
    storage.failUpload = true;
    const result = await createReport({ status: "idle" }, withPhoto(jpegBytes()));

    expect(result).toEqual({ status: "error", error: "Evidence upload failed. Please try again." });
    nothingCreated();
  });

  it("report_media insert failure after upload: the uploaded object is removed and the report discarded", async () => {
    forceNextError("report_media", "simulated insert failure");
    const result = await createReport({ status: "idle" }, withPhoto(jpegBytes()));

    expect(result).toEqual({ status: "error", error: "Evidence upload failed. Please try again." });
    expect(db.reports).toHaveLength(0);
    expect(db.report_locations).toHaveLength(0);
    expect(db.notifications).toHaveLength(0);
    expect(db.report_assignments).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
  });

  it("report insert failure: error, nothing uploaded and nothing else written", async () => {
    forceNextError("reports", "simulated insert failure");
    const result = await createReport({ status: "idle" }, withPhoto(jpegBytes()));

    expect(result).toMatchObject({ status: "error" });
    nothingCreated();
  });

  it("location insert failure: the report row is discarded and no photo is uploaded", async () => {
    forceNextError("report_locations", "simulated insert failure");
    const result = await createReport({ status: "idle" }, withPhoto(jpegBytes()));

    expect(result).toMatchObject({ status: "error" });
    expect(db.reports).toHaveLength(0);
    expect(db.notifications).toHaveLength(0);
    expect(db.report_assignments).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
  });

  it("a failed submission releases its idempotency key so the citizen can retry", async () => {
    const release = vi.fn();
    vi.mocked(beginIdempotentAction).mockImplementationOnce(async () => ({ kind: "run", commit: vi.fn(), release }));
    storage.failUpload = true;

    await createReport({ status: "idle" }, withPhoto(jpegBytes()));
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("retryAiAnalysis — enrichment only, routing untouched", () => {
  const REPORT_ID = "report-retry-1";

  /** A report as createReport now leaves it when Gemini failed: routed,
   * assigned, notified — just no AI analysis yet. */
  function seedRoutedReportWithoutAnalysis() {
    seedLegacyUnroutedReport();
    db.reports[0].status = "routed";
    db.report_assignments.push({
      report_id: REPORT_ID,
      department_id: "dept-roads",
      incharge_id: "roads-incharge",
      assignment_method: "auto",
      assigned_at: "2026-10-08T10:00:00Z",
    });
    db.notifications.push({ id: "n-assigned", recipient_id: "roads-incharge", type: "report_assigned", related_report_id: REPORT_ID });
  }

  /** A report submitted before routing stopped waiting for AI. */
  function seedLegacyUnroutedReport() {
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

  const aiDoneNotifications = () => db.notifications.filter((n) => n.type === "ai_analysis_completed");
  const assignmentSnapshot = () => JSON.parse(JSON.stringify(db.report_assignments));

  it("retry after failure: AI enrichment saved, existing department assignment unchanged", async () => {
    seedRoutedReportWithoutAnalysis();
    const before = assignmentSnapshot();
    analyzeReportMock.mockResolvedValue({ ...aiResult, recommended_department: "Water Supply" });

    expect(await retryAiAnalysis(REPORT_ID)).toEqual({});
    expect(analyzeReportMock).toHaveBeenCalledTimes(1);
    expect(db.ai_analyses).toHaveLength(1);
    expect(db.reports[0]).toMatchObject({ status: "routed", severity: "high", priority: "high" });
    expect(db.report_assignments).toEqual(before);
    expect(db.status_history).toHaveLength(0);
    expect(aiDoneNotifications()).toHaveLength(1);
    expect(db.notifications.filter((n) => n.type === "report_assigned")).toHaveLength(1);
  });

  it("never moves an acknowledged report's status (AI only enriches)", async () => {
    seedRoutedReportWithoutAnalysis();
    db.reports[0].status = "acknowledged";
    analyzeReportMock.mockResolvedValue(aiResult);

    expect(await retryAiAnalysis(REPORT_ID)).toEqual({});
    expect(analyzeReportMock).not.toHaveBeenCalled();
    expect(db.reports[0].status).toBe("acknowledged");
  });

  it("repeat retry after success is a no-op: no second Gemini call, analysis or notification", async () => {
    seedRoutedReportWithoutAnalysis();
    analyzeReportMock.mockResolvedValue(aiResult);
    await retryAiAnalysis(REPORT_ID);
    expect(await retryAiAnalysis(REPORT_ID)).toEqual({});

    expect(analyzeReportMock).toHaveBeenCalledTimes(1);
    expect(db.ai_analyses).toHaveLength(1);
    expect(db.report_assignments).toHaveLength(1);
    expect(aiDoneNotifications()).toHaveLength(1);
  });

  it("two concurrent retries (double click / second tab): only ONE calls Gemini; no duplicates", async () => {
    seedRoutedReportWithoutAnalysis();
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
    expect(aiDoneNotifications()).toHaveLength(1);
    expect(db.notifications.filter((n) => n.type === "report_assigned")).toHaveLength(1);
  });

  it("database backstop: if both requests got past the claim, UNIQUE(report_id) stops the second before any side effect", async () => {
    seedRoutedReportWithoutAnalysis();
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
    expect(aiDoneNotifications()).toHaveLength(1);
  });

  it("ai_analyses insert failure: stays routed and retryable, no AI side effects, claim released", async () => {
    seedRoutedReportWithoutAnalysis();
    const release = vi.fn();
    const commit = vi.fn();
    vi.mocked(beginIdempotentAction).mockImplementation(async () => ({ kind: "run", commit, release }));
    analyzeReportMock.mockResolvedValue(aiResult);
    forceNextError("ai_analyses", "insert failed");

    expect(await retryAiAnalysis(REPORT_ID)).toEqual({ error: "AI analysis is temporarily unavailable." });
    expect(db.reports[0].status).toBe("routed");
    expect(db.ai_analyses).toHaveLength(0);
    expect(db.report_assignments).toHaveLength(1);
    expect(aiDoneNotifications()).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it("severity/priority update failure: the inserted analysis row is reverted so the report stays retryable", async () => {
    seedRoutedReportWithoutAnalysis();
    vi.mocked(beginIdempotentAction).mockImplementation(async () => ({ kind: "run", commit: vi.fn(), release: vi.fn() }));
    analyzeReportMock.mockResolvedValue(aiResult);
    forceNextError("reports", "update failed");

    expect(await retryAiAnalysis(REPORT_ID)).toEqual({ error: "AI analysis is temporarily unavailable." });
    clearForcedErrors();
    expect(db.reports[0].status).toBe("routed");
    expect(db.ai_analyses).toHaveLength(0);

    // ...and a later retry succeeds normally.
    expect(await retryAiAnalysis(REPORT_ID)).toEqual({});
    expect(db.reports[0].status).toBe("routed");
    expect(db.ai_analyses).toHaveLength(1);
    expect(db.report_assignments).toHaveLength(1);
  });

  for (const [label, error] of [
    ["503", Object.assign(new Error("503 high demand"), { status: 503 })],
    ["429", Object.assign(new Error("429 RESOURCE_EXHAUSTED"), { status: 429 })],
    ["timeout", Object.assign(new Error("AI analysis timed out"), { timedOut: true })],
  ] as const) {
    it(`Gemini ${label} on retry: no write at all, still routed, claim released for a later retry`, async () => {
      seedRoutedReportWithoutAnalysis();
      const before = assignmentSnapshot();
      const release = vi.fn();
      vi.mocked(beginIdempotentAction).mockImplementation(async () => ({ kind: "run", commit: vi.fn(), release }));
      analyzeReportMock.mockRejectedValue(error);

      expect(await retryAiAnalysis(REPORT_ID)).toEqual({ error: "AI analysis is temporarily unavailable." });
      expect(db.reports[0].status).toBe("routed");
      expect(db.report_assignments).toEqual(before);
      expect(db.ai_analyses).toHaveLength(0);
      expect(release).toHaveBeenCalledTimes(1);
    });
  }

  it("legacy unrouted report: retry routes it even while Gemini is still down", async () => {
    seedLegacyUnroutedReport();
    analyzeReportMock.mockRejectedValue(new Error("503 high demand"));

    expect(await retryAiAnalysis(REPORT_ID)).toEqual({ error: "AI analysis is temporarily unavailable." });
    expect(db.reports[0].status).toBe("routed");
    expect(db.report_assignments).toEqual([
      expect.objectContaining({ department_id: "dept-roads", incharge_id: "roads-incharge" }),
    ]);
    expect(db.notifications.filter((n) => n.type === "report_assigned")).toHaveLength(1);

    // A later successful retry only adds the analysis — no second routing.
    analyzeReportMock.mockResolvedValue(aiResult);
    expect(await retryAiAnalysis(REPORT_ID)).toEqual({});
    expect(db.ai_analyses).toHaveLength(1);
    expect(db.report_assignments).toHaveLength(1);
    expect(db.status_history.filter((h) => h.new_status === "routed")).toHaveLength(1);
    expect(db.notifications.filter((n) => n.type === "report_assigned")).toHaveLength(1);
  });

  it("claims per report BEFORE calling Gemini, keyed by report id and a time window", async () => {
    seedRoutedReportWithoutAnalysis();
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
