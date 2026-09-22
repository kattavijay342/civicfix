import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression coverage for the sign-in crash: uses the REAL rate-limit
 * module (unlike auth.test.ts, which mocks it away) so a thrown
 * createAdminClient() genuinely exercises checkRateLimit()'s fail-open
 * path and proves signIn() still reaches Supabase Auth afterwards.
 */

const redirectMock = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirectMock(path),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Map<string, string>(),
}));

const createAdminClientMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClientMock(),
}));

const signInWithPasswordMock = vi.fn();
const getUserMock = vi.fn();
const fromMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      signInWithPassword: signInWithPasswordMock,
      getUser: getUserMock,
    },
    from: fromMock,
  })),
}));

const { signIn } = await import("./auth");

function signInFormData(overrides: Partial<Record<string, string>> = {}): FormData {
  const fd = new FormData();
  const fields = { email: "citizen@example.com", password: "password123", ...overrides };
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

beforeEach(() => {
  redirectMock.mockClear();
  createAdminClientMock.mockReset();
  signInWithPasswordMock.mockReset();
  getUserMock.mockReset();
  fromMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("signIn() when the rate-limit admin client fails to construct", () => {
  it("still reaches Supabase Auth and redirects on success (fails open, never blocks sign-in)", async () => {
    createAdminClientMock.mockImplementation(() => {
      throw new Error(
        "Supabase service role is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
      );
    });
    signInWithPasswordMock.mockResolvedValue({ error: null });
    getUserMock.mockResolvedValue({ data: { user: { id: "citizen-1" } } });
    fromMock.mockReturnValue({
      select: () => ({ eq: () => ({ single: async () => ({ data: { role: "citizen" } }) }) }),
    });

    const result = await signIn({}, signInFormData());

    expect(signInWithPasswordMock).toHaveBeenCalled();
    expect(result).toBeUndefined();
    expect(redirectMock).toHaveBeenCalledWith("/dashboard");
  });

  it("still returns the normal invalid-credentials error (fail-open never bypasses auth)", async () => {
    createAdminClientMock.mockImplementation(() => {
      throw new Error("boom");
    });
    signInWithPasswordMock.mockResolvedValue({
      error: { code: "invalid_credentials", message: "Invalid login credentials" },
    });

    const result = await signIn({}, signInFormData());

    expect(signInWithPasswordMock).toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(result.error).toBe("Invalid email or password.");
  });

  it("still returns the unconfirmed-email message (fail-open never bypasses auth)", async () => {
    createAdminClientMock.mockImplementation(() => {
      throw new Error("boom");
    });
    signInWithPasswordMock.mockResolvedValue({
      error: { code: "email_not_confirmed", message: "Email not confirmed" },
    });

    const result = await signIn({}, signInFormData());

    expect(redirectMock).not.toHaveBeenCalled();
    expect(result.error).toBe("Please confirm your email before signing in. Check your inbox for the confirmation email.");
  });
});
