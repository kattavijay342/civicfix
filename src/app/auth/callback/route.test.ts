import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const exchangeCodeForSessionMock = vi.fn();
const verifyOtpMock = vi.fn();
const getUserMock = vi.fn();
const fromMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      exchangeCodeForSession: exchangeCodeForSessionMock,
      verifyOtp: verifyOtpMock,
      getUser: getUserMock,
    },
    from: fromMock,
  })),
}));

const { GET } = await import("./route");

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
  exchangeCodeForSessionMock.mockReset();
  verifyOtpMock.mockReset();
  getUserMock.mockReset();
  fromMock.mockReset();
});

describe("GET /auth/callback", () => {
  it("redirects safely to /sign-in with an internal error code when no code is present", async () => {
    const request = new NextRequest("http://localhost:3000/auth/callback");

    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/sign-in?error=missing_code");
    expect(exchangeCodeForSessionMock).not.toHaveBeenCalled();
  });

  it("redirects safely to /sign-in without exposing the raw Supabase error when the exchange fails", async () => {
    exchangeCodeForSessionMock.mockResolvedValue({ error: { message: "invalid grant: some internal detail" } });
    const request = new NextRequest("http://localhost:3000/auth/callback?code=bad-code");

    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/sign-in?error=confirmation_failed");
    expect(response.headers.get("location")).not.toContain("internal detail");
  });

  it("redirects to the citizen dashboard on success when the profile role is citizen", async () => {
    exchangeCodeForSessionMock.mockResolvedValue({ error: null });
    getUserMock.mockResolvedValue({ data: { user: { id: "citizen-1" } } });
    fromMock.mockReturnValue(profilesRoleQuery("citizen"));
    const request = new NextRequest("http://localhost:3000/auth/callback?code=good-code");

    const response = await GET(request);

    expect(response.headers.get("location")).toBe("http://localhost:3000/dashboard");
  });

  it("redirects according to the user's ACTUAL profile role, not anything from the URL", async () => {
    exchangeCodeForSessionMock.mockResolvedValue({ error: null });
    getUserMock.mockResolvedValue({ data: { user: { id: "gov-1" } } });
    fromMock.mockReturnValue(profilesRoleQuery("government"));
    // Even though the request carries other query params, the redirect
    // target must come only from the server-verified profile role.
    const request = new NextRequest(
      "http://localhost:3000/auth/callback?code=good-code&role=admin&next=https://evil.example.com"
    );

    const response = await GET(request);

    const location = response.headers.get("location")!;
    expect(location).toBe("http://localhost:3000/government");
    expect(location).not.toContain("evil.example.com");
    expect(location).not.toContain("/admin");
  });

  it("falls back to the citizen home if no user/profile is found after a successful exchange", async () => {
    exchangeCodeForSessionMock.mockResolvedValue({ error: null });
    getUserMock.mockResolvedValue({ data: { user: null } });
    const request = new NextRequest("http://localhost:3000/auth/callback?code=good-code");

    const response = await GET(request);

    expect(response.headers.get("location")).toBe("http://localhost:3000/dashboard");
  });

  describe("token_hash flow (Supabase's default 'Confirm signup' email template)", () => {
    it("verifies via token_hash + type and redirects to the correct role home on success", async () => {
      verifyOtpMock.mockResolvedValue({ error: null });
      getUserMock.mockResolvedValue({ data: { user: { id: "gov-1" } } });
      fromMock.mockReturnValue(profilesRoleQuery("government"));
      const request = new NextRequest("http://localhost:3000/auth/callback?token_hash=good-hash&type=email");

      const response = await GET(request);

      expect(verifyOtpMock).toHaveBeenCalledWith({ token_hash: "good-hash", type: "email" });
      expect(exchangeCodeForSessionMock).not.toHaveBeenCalled();
      expect(response.headers.get("location")).toBe("http://localhost:3000/government");
    });

    it("redirects safely to /sign-in without exposing the raw Supabase error when verifyOtp fails", async () => {
      verifyOtpMock.mockResolvedValue({ error: { message: "otp expired: some internal detail" } });
      const request = new NextRequest("http://localhost:3000/auth/callback?token_hash=expired-hash&type=email");

      const response = await GET(request);

      expect(response.headers.get("location")).toBe("http://localhost:3000/sign-in?error=confirmation_failed");
      expect(response.headers.get("location")).not.toContain("internal detail");
    });

    it("treats a token_hash with no type as an incomplete link, never calling verifyOtp", async () => {
      const request = new NextRequest("http://localhost:3000/auth/callback?token_hash=good-hash");

      const response = await GET(request);

      expect(response.headers.get("location")).toBe("http://localhost:3000/sign-in?error=missing_code");
      expect(verifyOtpMock).not.toHaveBeenCalled();
    });

    it("rejects an unrecognized type value instead of passing it through to verifyOtp", async () => {
      const request = new NextRequest(
        "http://localhost:3000/auth/callback?token_hash=good-hash&type=not_a_real_type"
      );

      const response = await GET(request);

      expect(response.headers.get("location")).toBe("http://localhost:3000/sign-in?error=missing_code");
      expect(verifyOtpMock).not.toHaveBeenCalled();
    });
  });
});
