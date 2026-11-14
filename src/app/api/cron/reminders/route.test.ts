import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const processDueRemindersMock = vi.fn(async () => ({ processed: 0 }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/reminders", () => ({ processDueReminders: () => processDueRemindersMock() }));

const { GET, POST } = await import("./route");

const req = (auth?: string) =>
  new NextRequest("http://localhost/api/cron/reminders", auth ? { headers: { authorization: auth } } : undefined);

const original = process.env.CRON_SECRET;
beforeEach(() => {
  process.env.CRON_SECRET = "s3cret-value";
  processDueRemindersMock.mockClear();
});
afterEach(() => {
  process.env.CRON_SECRET = original;
});

describe("/api/cron/reminders", () => {
  it("fails closed with 503 when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(req("Bearer anything"));
    expect(res.status).toBe(503);
    expect(processDueRemindersMock).not.toHaveBeenCalled();
  });

  it.each([undefined, "Bearer wrong", "Bearer s3cret-valu", "s3cret-value", "bearer s3cret-value"])(
    "rejects authorization %s with 401",
    async (auth) => {
      const res = await GET(req(auth));
      expect(res.status).toBe(401);
      expect(processDueRemindersMock).not.toHaveBeenCalled();
    }
  );

  it("runs the reminder job for the exact bearer secret (GET and POST)", async () => {
    expect((await GET(req("Bearer s3cret-value"))).status).toBe(200);
    expect((await POST(req("Bearer s3cret-value"))).status).toBe(200);
    expect(processDueRemindersMock).toHaveBeenCalledTimes(2);
  });
});
