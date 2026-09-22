import { describe, it, expect, vi, beforeEach } from "vitest";

const redirectMock = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirectMock(path),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: vi.fn().mockResolvedValue("127.0.0.1"),
  retryAfterMessage: (seconds: number) => `Too many attempts. Please try again in ${Math.ceil(seconds / 60)} minutes.`,
}));

const signUpMock = vi.fn();
const signInWithPasswordMock = vi.fn();
const getUserMock = vi.fn();
const fromMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      signUp: signUpMock,
      signInWithPassword: signInWithPasswordMock,
      getUser: getUserMock,
      signOut: vi.fn(),
    },
    from: fromMock,
  })),
}));

const { signUp, signIn } = await import("./auth");

function signUpFormData(overrides: Partial<Record<string, string>> = {}): FormData {
  const fd = new FormData();
  const fields = {
    email: "citizen@example.com",
    password: "password123",
    fullName: "Test Citizen",
    mobile: "9876543210",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function signInFormData(overrides: Partial<Record<string, string>> = {}): FormData {
  const fd = new FormData();
  const fields = { email: "citizen@example.com", password: "password123", ...overrides };
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function profilesRoleQuery(role: string | null) {
  return {
    select: () => ({
      eq: () => ({
        single: async () => ({ data: role ? { role } : null }),
      }),
    }),
  };
}

beforeEach(() => {
  redirectMock.mockClear();
  signUpMock.mockReset();
  signInWithPasswordMock.mockReset();
  getUserMock.mockReset();
  fromMock.mockReset();
});

describe("signUp", () => {
  it("redirects to the citizen dashboard when signUp returns a session (email confirmation not required)", async () => {
    signUpMock.mockResolvedValue({ data: { session: { access_token: "t" } }, error: null });

    const result = await signUp({}, signUpFormData());

    expect(result).toBeUndefined();
    expect(redirectMock).toHaveBeenCalledWith("/dashboard");
  });

  it("does NOT redirect and returns an informational (non-error) state when confirmation is required", async () => {
    signUpMock.mockResolvedValue({ data: { session: null, user: { id: "u1" } }, error: null });

    const result = await signUp({}, signUpFormData());

    expect(redirectMock).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(result.info).toMatch(/check your email/i);
    expect(result.info).toMatch(/confirmation link/i);
  });

  it("returns a safe error for an already-registered email without exposing the raw Supabase message", async () => {
    signUpMock.mockResolvedValue({ data: { session: null }, error: { message: "User already registered" } });

    const result = await signUp({}, signUpFormData());

    expect(redirectMock).not.toHaveBeenCalled();
    expect(result.error).toBe("An account with this email already exists. Try signing in instead.");
  });

  it("returns a generic safe error for any other signUp failure", async () => {
    signUpMock.mockResolvedValue({ data: { session: null }, error: { message: "some internal Supabase detail" } });

    const result = await signUp({}, signUpFormData());

    expect(result.error).toBe("Unable to create your account. Please try again.");
    expect(result.error).not.toContain("internal Supabase detail");
  });
});

describe("signIn", () => {
  it("returns a dedicated, honest message for an unconfirmed-email account", async () => {
    signInWithPasswordMock.mockResolvedValue({
      error: { code: "email_not_confirmed", message: "Email not confirmed" },
    });

    const result = await signIn({}, signInFormData());

    expect(redirectMock).not.toHaveBeenCalled();
    expect(result.error).toBe("Please confirm your email before signing in. Check your inbox for the confirmation email.");
  });

  it("keeps the existing generic error for any other sign-in failure (never reveals which field was wrong)", async () => {
    signInWithPasswordMock.mockResolvedValue({
      error: { code: "invalid_credentials", message: "Invalid login credentials" },
    });

    const result = await signIn({}, signInFormData());

    expect(result.error).toBe("Invalid email or password.");
  });

  it("redirects to the correct role home on successful sign-in", async () => {
    signInWithPasswordMock.mockResolvedValue({ error: null });
    getUserMock.mockResolvedValue({ data: { user: { id: "gov-1" } } });
    fromMock.mockReturnValue(profilesRoleQuery("government"));

    const result = await signIn({}, signInFormData());

    expect(result).toBeUndefined();
    expect(redirectMock).toHaveBeenCalledWith("/government");
  });
});
