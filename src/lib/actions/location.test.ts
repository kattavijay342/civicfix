import { describe, it, expect, vi, beforeEach } from "vitest";

/** attemptReverseGeocode is a "use server" export, i.e. a public endpoint:
 * it must refuse anonymous callers and respect the per-user rate limit
 * before ever reaching the paid geocoding provider. */

let currentUser: { id: string } | null = null;
let allowed = true;
const reverseGeocodeMock = vi.fn(async () => ({ status: "ok" as const, result: {} }));
const checkRateLimitMock = vi.fn(async () => ({ allowed, retryAfterSeconds: allowed ? 0 : 120 }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: async () => ({ data: { user: currentUser } }) } })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...(args as [])),
  retryAfterMessage: () => "Too many attempts.",
}));
vi.mock("@/lib/location/reverse-geocoding", () => ({ reverseGeocode: () => reverseGeocodeMock() }));

const { attemptReverseGeocode } = await import("./location");

beforeEach(() => {
  currentUser = null;
  allowed = true;
  reverseGeocodeMock.mockClear();
  checkRateLimitMock.mockClear();
});

describe("attemptReverseGeocode", () => {
  it("rejects invalid coordinates without any lookup", async () => {
    currentUser = { id: "u1" };
    const out = await attemptReverseGeocode(200, 10);
    expect(out.status).toBe("unavailable");
    expect(reverseGeocodeMock).not.toHaveBeenCalled();
  });

  it("refuses anonymous callers before spending provider quota", async () => {
    const out = await attemptReverseGeocode(16.3, 80.4);
    expect(out).toEqual({ status: "unavailable", reason: "Sign in to look up an address." });
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(reverseGeocodeMock).not.toHaveBeenCalled();
  });

  it("refuses when the per-user rate limit is exhausted", async () => {
    currentUser = { id: "u1" };
    allowed = false;
    const out = await attemptReverseGeocode(16.3, 80.4);
    expect(out).toEqual({ status: "unavailable", reason: "Too many attempts." });
    expect(checkRateLimitMock).toHaveBeenCalledWith("reverse_geocode:u1", 60, 600);
    expect(reverseGeocodeMock).not.toHaveBeenCalled();
  });

  it("looks up the address for a signed-in user within the limit", async () => {
    currentUser = { id: "u1" };
    const out = await attemptReverseGeocode(16.3, 80.4);
    expect(out.status).toBe("ok");
    expect(reverseGeocodeMock).toHaveBeenCalledTimes(1);
  });
});
