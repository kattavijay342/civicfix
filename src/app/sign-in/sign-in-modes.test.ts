import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseSignInMode, AUTHORIZED_SIGN_IN_PATH, CITIZEN_SIGN_IN_PATH } from "@/lib/sign-in-mode";

vi.mock("@/lib/actions/auth", () => ({
  signIn: vi.fn(),
  signInAuthorized: vi.fn(),
  signUp: vi.fn(),
}));

const { SignInForm } = await import("./SignInForm");

function render(props: Parameters<typeof SignInForm>[0]): string {
  return renderToStaticMarkup(createElement(SignInForm, props));
}

/** Every form field name in the rendered markup. */
function fieldNames(html: string): string[] {
  return [...html.matchAll(/<(?:input|select|textarea)[^>]*\bname="([^"]+)"/g)].map((m) => m[1]);
}

describe("parseSignInMode", () => {
  it("only the exact value 'authorized' opens Government & Department mode", () => {
    expect(parseSignInMode("authorized")).toBe("authorized");
    for (const other of [undefined, null, "", "citizen", "Authorized", "admin", "government", ["authorized"]]) {
      expect(parseSignInMode(other)).toBe("citizen");
    }
  });

  it("uses internal relative paths only (no hard-coded origin)", () => {
    expect(AUTHORIZED_SIGN_IN_PATH).toBe("/sign-in?mode=authorized");
    expect(CITIZEN_SIGN_IN_PATH).toBe("/sign-in");
  });
});

describe("SignInForm — citizen mode (default)", () => {
  const html = render({});

  it("keeps the normal Sign In / Citizen Sign Up experience", () => {
    expect(html).toContain('role="tablist"');
    expect(html).toContain("Citizen Sign Up");
    expect(html).toContain(">Sign In<");
  });

  it("links 'Sign in here →' to Government & Department mode on the same route", () => {
    expect(html).toContain("Authorized Government &amp; Department Users");
    expect(html).toMatch(/<a[^>]*href="\/sign-in\?mode=authorized"[^>]*>Sign in here →<\/a>/);
  });
});

describe("SignInForm — Government & Department mode", () => {
  const html = render({ mode: "authorized" });

  it("shows only email + password and a Sign In button", () => {
    expect(fieldNames(html)).toEqual(["email", "password"]);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>.*Sign In<\/button>/);
  });

  it("offers no role picker and no way to sign up", () => {
    expect(html).not.toMatch(/name="role"/);
    expect(html).not.toMatch(/<select/);
    expect(html).not.toContain("Citizen Sign Up");
    expect(html).not.toContain("Create account");
    expect(html).not.toContain('role="tablist"');
  });

  it("offers account activation via the existing invitation page — never a sign-up", () => {
    expect(html).toMatch(/<a[^>]*href="\/auth\/accept-invite"[^>]*>Activate your invited account →<\/a>/);
    expect(html).toContain("This sign-in is only for authorized government &amp; department users.");
    expect(html).not.toMatch(/sign ?up|create account|register/i);
  });

  it("links back to Citizen Sign In at /sign-in", () => {
    expect(html).toMatch(/<a[^>]*href="\/sign-in"[^>]*>← Back to Citizen Sign In<\/a>/);
    expect(html).not.toContain("Sign in here →");
  });

  it("still shows safe callback errors", () => {
    expect(render({ mode: "authorized", callbackError: "Your account isn't set up" })).toContain("set up");
  });
});
