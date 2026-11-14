import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeClient, type FakeDb } from "../../test/fake-supabase";
import { fakeAiWorkerExtras } from "../../test/fake-ai-worker-db";

/**
 * AI-2 CP2.3 — regression tests for the final-review fixes:
 *   M-2 recovery-pagination page-limit mismatch (a tied-timestamp block no
 *   longer wastes RPC calls after escaping it, and real rows past the
 *   block are still reached);
 *   M-3 renew_ai_worker_lease's "function not found" (PGRST202) is
 *   distinguished from ordinary lease contention.
 * Gemini is never reachable from these tests.
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

const { runAiWorker, recoverMissingAiJobs, AI_WORKER_POLICY } = await import("./ai-worker");

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

// ------------------------------------------------- M-2
describe("M-2 — recovery pagination no longer wastes RPC calls escaping a tied-timestamp block", () => {
  it("a 60-row tied-timestamp block (page size 50) is fully reached in the minimum number of pages", async () => {
    // Reporter lookups are "temporary" (never enqueued), so no row is ever
    // excluded by find_reports_missing_ai_job's own filters — this is the
    // scenario that actually exercises page-limit growth: the SQL keeps
    // returning the same un-enqueued rows until the app-side cursor (not
    // the SQL) has moved past them.
    const tiedAt = NOW - HOUR;
    for (let i = 0; i < 60; i++) addReport(`tie-${String(i).padStart(3, "0")}`, { createdAt: tiedAt, reporter: "flaky-user" });
    extras = fakeAiWorkerExtras(db, { now, emails: { "flaky-user": "__TEMP__" } });

    const result = await recoverMissingAiJobs(admin(), { now: NOW, clock: now, recoverySince: iso(NOW - 24 * HOUR), limit: 200 });

    expect(result).toMatchObject({ status: "ran", scanned: 60, temporaryErrors: 60, stoppedBy: "exhausted" });
    expect(db.ai_analysis_jobs).toHaveLength(0);
    // Before the M-2 fix this took 2 extra, unnecessary growth-cycle pages
    // (5 total) after already escaping the tie block — now it's exactly 3:
    // page 1 (50, limit 50) -> page 2 (0 new, limit 50, grows) -> page 3
    // (the remaining 10, limit 100, correctly recognized as the last page).
    expect(result.status === "ran" && result.pages).toBe(3);
  });

  it("eligible rows AFTER a tied-timestamp block are still reached, without being starved by the block", async () => {
    const tiedAt = NOW - 2 * HOUR;
    for (let i = 0; i < 60; i++) addReport(`tie-${String(i).padStart(3, "0")}`, { createdAt: tiedAt });
    addReport("later-1", { createdAt: NOW - HOUR });
    addReport("later-2", { createdAt: NOW - 30 * MIN });

    const result = await recoverMissingAiJobs(admin(), { now: NOW, clock: now, recoverySince: iso(NOW - 24 * HOUR), limit: 200 });

    expect(result).toMatchObject({ status: "ran", scanned: 62, enqueued: 62 });
    expect(job("later-1")).toMatchObject({ status: "pending" });
    expect(job("later-2")).toMatchObject({ status: "pending" });
  });

  it("exhaustion is detected on the fetch that actually returns fewer rows than it requested — never a stale, already-reset limit", async () => {
    // A tie block whose size is NOT a clean multiple of the page size, so
    // the "last page" detection must use the ACTUAL limit of that specific
    // fetch (100), not the value pageLimit is reset to right after (50).
    const tiedAt = NOW - HOUR;
    for (let i = 0; i < 73; i++) addReport(`tie-${String(i).padStart(3, "0")}`, { createdAt: tiedAt, reporter: "flaky-user" });
    extras = fakeAiWorkerExtras(db, { now, emails: { "flaky-user": "__TEMP__" } });

    const result = await recoverMissingAiJobs(admin(), { now: NOW, clock: now, recoverySince: iso(NOW - 24 * HOUR), limit: 200 });

    expect(result).toMatchObject({ status: "ran", scanned: 73, temporaryErrors: 73, stoppedBy: "exhausted" });
    // page1 (50) -> page2 (0 new, grows to 100) -> page3 (100 requested,
    // 73 returned < 100 -> correctly recognized as the last page here).
    expect(result.status === "ran" && result.pages).toBe(3);
  });

  it("still stops cleanly (bounded) when a block is larger than recoveryMaxPageLimit — no infinite loop", async () => {
    const tiedAt = NOW - HOUR;
    const count = AI_WORKER_POLICY.recoveryMaxPageLimit + 20;
    for (let i = 0; i < count; i++) addReport(`huge-${String(i).padStart(4, "0")}`, { createdAt: tiedAt });

    const result = await recoverMissingAiJobs(admin(), { now: NOW, clock: now, recoverySince: iso(NOW - 24 * HOUR), limit: count });

    expect(result.status).toBe("ran");
    if (result.status === "ran") {
      expect(["tie_block_exceeded", "max_pages"]).toContain(result.stoppedBy);
      expect(result.pages).toBeLessThan(10); // bounded — never one RPC call per row
    }
  });
});

// ------------------------------------------------- M-3
describe("M-3 — renew_ai_worker_lease: missing migration vs. ordinary lease loss", () => {
  it("PGRST202 (function not found) is reported as stoppedReason 'migration_missing', with a sanitized log naming 0021 — no claims made", async () => {
    addReport("r1");
    db.ai_analysis_jobs.push({
      report_id: "r1",
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
    });
    const errorSpy = vi.spyOn(console, "error");
    extras.rpc!.renew_ai_worker_lease = () => ({ data: null, error: { message: "Could not find the function public.renew_ai_worker_lease", code: "PGRST202" } });

    const summary = await run();

    expect(summary.stoppedReason).toBe("migration_missing");
    expect(extras.calls.claim_due_ai_jobs).toBeUndefined();
    const logged = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("0021_ai_worker_lease_renewal.sql");
    expect(logged).toContain("CONFIGURATION ERROR");
    // Never leaks connection strings, keys or raw provider payloads.
    expect(logged).not.toMatch(/postgres(ql)?:\/\/|service_role|apikey/i);
  });

  it("a DIFFERENT RPC error code is ordinary lease loss, not a migration diagnosis", async () => {
    extras.rpc!.renew_ai_worker_lease = () => ({ data: null, error: { message: "connection reset by peer", code: "08006" } });
    const summary = await run();
    expect(summary.stoppedReason).toBe("lease_lost");
  });

  it("normal contention (another holder owns the lease, no error) is still ordinary lease loss", async () => {
    extras.rpc!.renew_ai_worker_lease = () => ({ data: null, error: null });
    const summary = await run();
    expect(summary.stoppedReason).toBe("lease_lost");
  });

  it("a successful renewal is unaffected by the new error classification", async () => {
    addReport("r1");
    db.ai_analysis_jobs.push({
      report_id: "r1",
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
    });
    const summary = await run({ deps: { ai: { analyze: async () => Promise.reject(Object.assign(new Error("x"), { status: 503 })) } } });
    expect(summary.stoppedReason).not.toBe("migration_missing");
    expect(summary.aiJobs.retryScheduled).toBe(1);
  });
});
