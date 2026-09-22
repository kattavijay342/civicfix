import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();
const createAdminClientMock = vi.fn(() => ({ rpc: rpcMock }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClientMock(),
}));

const { checkRateLimit, retryAfterMessage } = await import("./rate-limit");

beforeEach(() => {
  rpcMock.mockReset();
  createAdminClientMock.mockReset();
  createAdminClientMock.mockImplementation(() => ({ rpc: rpcMock }));
});

describe("checkRateLimit", () => {
  it("allows the request when under the limit", async () => {
    rpcMock.mockResolvedValue({ data: [{ allowed: true, retry_after_seconds: 0 }], error: null });

    const result = await checkRateLimit("k", 5, 60);

    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("rejects the request once the limit is exceeded", async () => {
    rpcMock.mockResolvedValue({ data: [{ allowed: false, retry_after_seconds: 42 }], error: null });

    const result = await checkRateLimit("k", 5, 60);

    expect(result).toEqual({ allowed: false, retryAfterSeconds: 42 });
  });

  it("fails open when the check_rate_limit RPC itself errors", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    rpcMock.mockResolvedValue({ data: null, error: { message: "connection refused" } });

    const result = await checkRateLimit("k", 5, 60);

    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("fails open when the admin client fails to construct (e.g. missing SUPABASE_SERVICE_ROLE_KEY)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    createAdminClientMock.mockImplementation(() => {
      throw new Error(
        "Supabase service role is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
      );
    });

    const result = await checkRateLimit("k", 5, 60);

    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
    // Never surfaces the underlying config/credential detail to the caller.
    expect(JSON.stringify(result)).not.toMatch(/SERVICE_ROLE|service role/i);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("never lets a rate-limit-subsystem failure throw out of checkRateLimit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    createAdminClientMock.mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(checkRateLimit("k", 5, 60)).resolves.not.toThrow();
  });
});

describe("retryAfterMessage", () => {
  it("rounds up to whole minutes and uses singular phrasing under a minute", () => {
    expect(retryAfterMessage(30)).toBe("Too many attempts. Please try again in a minute.");
  });

  it("uses plural phrasing for multiple minutes", () => {
    expect(retryAfterMessage(125)).toBe("Too many attempts. Please try again in 3 minutes.");
  });
});
