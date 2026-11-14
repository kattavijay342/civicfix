import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const runAiWorkerMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/ai-worker", () => ({
  AI_WORKER_POLICY: { runBudgetMs: 240_000 },
  runAiWorker: (opts: unknown) => runAiWorkerMock(opts),
}));

const route = await import("./route");
const { GET, POST, maxDuration } = route;

const req = (auth?: string) =>
  new NextRequest("http://localhost/api/cron/ai-jobs", { method: "POST", ...(auth ? { headers: { authorization: auth } } : {}) });

const summary = {
  status: "ran",
  stoppedReason: "no_work",
  exhaustedSettled: 0,
  aiJobs: { processed: 1, completed: 1, retryScheduled: 0, failed: 0, lostLease: 0, errors: 0 },
  incidentJobs: { processed: 0, confirmed: 0, notConfirmed: 0, notEligible: 0, alreadyLinked: 0, retryScheduled: 0, failed: 0, lostLease: 0, errors: 0 },
};

const original = process.env.CRON_SECRET;
beforeEach(() => {
  process.env.CRON_SECRET = "s3cret-value";
  runAiWorkerMock.mockReset();
  runAiWorkerMock.mockResolvedValue(summary);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env.CRON_SECRET = original;
});

describe("/api/cron/ai-jobs", () => {
  it("declares maxDuration = 300", () => {
    expect(maxDuration).toBe(300);
  });

  it("fails closed with 503 when CRON_SECRET is unset (no work, no secret hints)", async () => {
    delete process.env.CRON_SECRET;
    const res = await POST(req("Bearer anything"));
    expect(res.status).toBe(503);
    expect(runAiWorkerMock).not.toHaveBeenCalled();
    expect(JSON.stringify(await res.json())).not.toMatch(/CRON_SECRET/);
  });

  // (A trailing space is not listed: the Fetch Headers API trims header
  // values before the route ever sees them, so it is the same header.)
  it.each([undefined, "Bearer wrong", "Bearer s3cret-valu", "s3cret-value", "bearer s3cret-value", "Bearer s3cret-value-extra"])(
    "rejects authorization %s with 401 and does no work",
    async (auth) => {
      const res = await POST(req(auth));
      expect(res.status).toBe(401);
      expect(runAiWorkerMock).not.toHaveBeenCalled();
    }
  );

  it("runs one worker pass with a 240s deadline for the exact bearer secret (POST and GET)", async () => {
    const before = Date.now();
    const res = await POST(req("Bearer s3cret-value"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...summary });
    const { deadline } = runAiWorkerMock.mock.calls[0][0] as { deadline: number };
    expect(deadline - before).toBeGreaterThanOrEqual(240_000);
    expect(deadline - Date.now()).toBeLessThanOrEqual(240_000);
    expect((await GET(req("Bearer s3cret-value"))).status).toBe(200);
    expect(runAiWorkerMock).toHaveBeenCalledTimes(2);
  });

  it("returns a generic 500 without leaking the internal error", async () => {
    runAiWorkerMock.mockRejectedValue(new Error("connection to db.internal:5432 failed key=abc"));
    const res = await POST(req("Bearer s3cret-value"));
    expect(res.status).toBe(500);
    const body = JSON.stringify(await res.json());
    expect(body).toBe(JSON.stringify({ error: "AI worker run failed." }));
  });
});
