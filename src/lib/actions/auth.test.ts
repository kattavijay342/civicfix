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
const signOutMock = vi.fn();
const updateUserMock = vi.fn();
const fromMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      signUp: signUpMock,
      signInWithPassword: signInWithPasswordMock,
      getUser: getUserMock,
      signOut: signOutMock,
      updateUser: updateUserMock,
    },
    from: fromMock,
  })),
}));

const { signUp, signIn, signInAuthorized, completeInvitation } = await import("./auth");
const { checkRateLimit } = await import("@/lib/rate-limit");

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
  signOutMock.mockReset();
  updateUserMock.mockReset();
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

  it("sends a fixed emailRedirectTo pointing at /auth/callback, never left for Supabase's default Site URL", async () => {
    signUpMock.mockResolvedValue({ data: { session: null, user: { id: "u1" } }, error: null });

    await signUp({}, signUpFormData());

    expect(signUpMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          emailRedirectTo: expect.stringMatching(/\/auth\/callback$/),
        }),
      })
    );
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

  it("never sends a role to Supabase — even when the client submits one", async () => {
    signUpMock.mockResolvedValue({ data: { session: null, user: { id: "u1" } }, error: null });

    for (const forged of ["admin", "government", "department_incharge"]) {
      await signUp({}, signUpFormData({ role: forged }));
    }

    for (const [args] of signUpMock.mock.calls) {
      expect(args.options.data).not.toHaveProperty("role");
      expect(JSON.stringify(args)).not.toMatch(/admin|government|department_incharge/);
    }
  });

  it("lands a session-returning sign-up on the citizen dashboard even when a privileged role is submitted", async () => {
    signUpMock.mockResolvedValue({ data: { session: { access_token: "t" } }, error: null });

    await signUp({}, signUpFormData({ role: "admin" }));

    expect(redirectMock).toHaveBeenCalledWith("/dashboard");
  });

  it("returns a dedicated, honest message when Supabase's own email-send rate limit is hit", async () => {
    signUpMock.mockResolvedValue({
      data: { session: null },
      error: { code: "over_email_send_rate_limit", status: 429, message: "email rate limit exceeded" },
    });

    const result = await signUp({}, signUpFormData());

    expect(result.error).toBe("We're sending a lot of confirmation emails right now. Please wait a few minutes and try again.");
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

  it.each([
    ["citizen", "/dashboard"],
    ["government", "/government"],
    ["department_incharge", "/department"],
    ["admin", "/admin"],
  ])("detects role %s from the stored profile and redirects to %s", async (role, home) => {
    signInWithPasswordMock.mockResolvedValue({ error: null });
    getUserMock.mockResolvedValue({ data: { user: { id: `${role}-1` } } });
    fromMock.mockReturnValue(profilesRoleQuery(role));

    const result = await signIn({}, signInFormData());

    expect(result).toBeUndefined();
    expect(fromMock).toHaveBeenCalledWith("profiles");
    expect(redirectMock).toHaveBeenCalledWith(home);
  });

  it.each([
    ["a citizen using Government & Department mode", "citizen", "/dashboard"],
    ["a government user using citizen mode", "government", "/government"],
    ["a department in-charge using citizen mode", "department_incharge", "/department"],
    ["an admin using Government & Department mode", "admin", "/admin"],
  ])("sign-in UI mode never affects the result: %s lands on %s's home", async (_label, role, home) => {
    signInWithPasswordMock.mockResolvedValue({ error: null });
    getUserMock.mockResolvedValue({ data: { user: { id: `${role}-1` } } });
    fromMock.mockReturnValue(profilesRoleQuery(role));

    await signIn({}, signInFormData({ mode: role === "citizen" || role === "admin" ? "authorized" : "citizen" }));

    expect(redirectMock).toHaveBeenCalledWith(home);
    expect(signInWithPasswordMock).toHaveBeenCalledWith({ email: "citizen@example.com", password: "password123" });
  });

  it("ignores any role/redirect submitted with the sign-in form — only the stored profile role counts", async () => {
    signInWithPasswordMock.mockResolvedValue({ error: null });
    getUserMock.mockResolvedValue({ data: { user: { id: "citizen-1" } } });
    fromMock.mockReturnValue(profilesRoleQuery("citizen"));

    await signIn({}, signInFormData({ role: "admin", next: "/admin" }));

    expect(redirectMock).toHaveBeenCalledWith("/dashboard");
    expect(redirectMock).not.toHaveBeenCalledWith("/admin");
  });

  it.each([
    ["no profile row", null],
    ["an unrecognized role", "superuser"],
  ])("refuses access with %s: signs out, never guesses a role", async (_label, role) => {
    signInWithPasswordMock.mockResolvedValue({ error: null });
    getUserMock.mockResolvedValue({ data: { user: { id: "u-1" } } });
    fromMock.mockReturnValue(profilesRoleQuery(role));

    const result = await signIn({}, signInFormData());

    expect(redirectMock).not.toHaveBeenCalled();
    expect(signOutMock).toHaveBeenCalled();
    expect(result.error).toMatch(/isn't set up for CivicFix access/);
  });
});

describe("signInAuthorized (/sign-in?mode=authorized)", () => {
  it.each([
    ["government", "/government"],
    ["department_incharge", "/department"],
    ["admin", "/admin"],
  ])("signs in a stored %s and redirects to %s", async (role, home) => {
    signInWithPasswordMock.mockResolvedValue({ error: null });
    getUserMock.mockResolvedValue({ data: { user: { id: `${role}-1` } } });
    fromMock.mockReturnValue(profilesRoleQuery(role));

    await signInAuthorized({}, signInFormData());

    expect(redirectMock).toHaveBeenCalledWith(home);
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("turns a citizen account away: signed back out, no redirect anywhere, told to use Citizen Sign In", async () => {
    signInWithPasswordMock.mockResolvedValue({ error: null });
    getUserMock.mockResolvedValue({ data: { user: { id: "citizen-1" } } });
    fromMock.mockReturnValue(profilesRoleQuery("citizen"));

    const result = await signInAuthorized({}, signInFormData({ role: "admin" }));

    expect(signOutMock).toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(result.error).toMatch(/Citizens, please use Citizen Sign In/);
  });

  it.each([
    ["no profile row", null],
    ["an unrecognized role", "superuser"],
  ])("refuses an account with %s without guessing a role", async (_label, role) => {
    signInWithPasswordMock.mockResolvedValue({ error: null });
    getUserMock.mockResolvedValue({ data: { user: { id: "u-1" } } });
    fromMock.mockReturnValue(profilesRoleQuery(role));

    const result = await signInAuthorized({}, signInFormData());

    expect(signOutMock).toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(result.error).toMatch(/isn't set up for CivicFix access/);
  });

  it("returns the same generic error as citizen sign-in for bad credentials", async () => {
    signInWithPasswordMock.mockResolvedValue({ error: { code: "invalid_credentials", message: "Invalid login credentials" } });

    expect((await signInAuthorized({}, signInFormData())).error).toBe("Invalid email or password.");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("shares the citizen sign-in rate-limit counters (switching modes never buys extra attempts)", async () => {
    vi.mocked(checkRateLimit).mockClear();
    signInWithPasswordMock.mockResolvedValue({ error: { code: "invalid_credentials", message: "x" } });

    await signInAuthorized({}, signInFormData({ email: "Gov@Example.com" }));

    expect(checkRateLimit).toHaveBeenCalledWith("auth_signin:ip:127.0.0.1", 20, 600);
    expect(checkRateLimit).toHaveBeenCalledWith("auth_signin:email:gov@example.com", 8, 600);
  });
});

describe("completeInvitation", () => {
  function passwordForm(password: string, confirmPassword = password): FormData {
    const fd = new FormData();
    fd.set("password", password);
    fd.set("confirmPassword", confirmPassword);
    return fd;
  }

  it("rejects short or mismatched passwords before touching Supabase", async () => {
    expect((await completeInvitation({}, passwordForm("short"))).error).toMatch(/at least 8/);
    expect((await completeInvitation({}, passwordForm("password123", "password124"))).error).toMatch(/don't match/);
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("requires the session established by the invitation link", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const result = await completeInvitation({}, passwordForm("password123"));

    expect(result.error).toMatch(/expired or was already used/);
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("refuses users who were never invited (e.g. self-registered citizens)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "citizen-1", invited_at: null } } });

    const result = await completeInvitation({}, passwordForm("password123"));

    expect(result.error).toMatch(/only for accepting/);
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("sets the user's own password and lands them on the dashboard for their stored role", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "gov-1", invited_at: "2026-09-24T00:00:00Z" } } });
    updateUserMock.mockResolvedValue({ error: null });
    fromMock.mockReturnValue(profilesRoleQuery("government"));

    await completeInvitation({}, passwordForm("password123"));

    expect(updateUserMock).toHaveBeenCalledWith({ password: "password123" });
    expect(redirectMock).toHaveBeenCalledWith("/government");
  });

  it.each([
    ["department_incharge", "/department"],
    ["admin", "/admin"],
  ])("lands an activated %s on %s", async (role, home) => {
    getUserMock.mockResolvedValue({ data: { user: { id: `${role}-1`, invited_at: "2026-09-24T00:00:00Z" } } });
    updateUserMock.mockResolvedValue({ error: null });
    fromMock.mockReturnValue(profilesRoleQuery(role));

    await completeInvitation({}, passwordForm("password123"));

    expect(redirectMock).toHaveBeenCalledWith(home);
  });

  it("ignores any role/data smuggled into the activation form — only the password is written", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "gov-1", invited_at: "2026-09-24T00:00:00Z" } } });
    updateUserMock.mockResolvedValue({ error: null });
    fromMock.mockReturnValue(profilesRoleQuery("government"));
    const fd = passwordForm("password123");
    fd.set("role", "admin");
    fd.set("data", JSON.stringify({ role: "admin" }));

    await completeInvitation({}, fd);

    expect(updateUserMock).toHaveBeenCalledTimes(1);
    expect(updateUserMock).toHaveBeenCalledWith({ password: "password123" });
    expect(redirectMock).toHaveBeenCalledWith("/government");
    expect(redirectMock).not.toHaveBeenCalledWith("/admin");
  });
});
