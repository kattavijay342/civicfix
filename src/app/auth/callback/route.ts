import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { resolveRoleHome } from "@/lib/role-routes";

/** Only these values are ever passed to `verifyOtp` — Supabase's own email
 * templates set `type`, but it still arrives as an untrusted query param,
 * so it's checked against this allowlist rather than cast blindly. */
const EMAIL_OTP_TYPES: readonly EmailOtpType[] = [
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
];

function isEmailOtpType(value: string | null): value is EmailOtpType {
  return value !== null && (EMAIL_OTP_TYPES as readonly string[]).includes(value);
}

/**
 * Where Supabase's email-confirmation link lands. This is the only auth
 * mechanism at work here: it establishes a session — via whichever of the
 * two shapes Supabase actually sent (see below) — using the same
 * per-request Supabase client every other Server Action/Component uses, so
 * it persists a session cookie the normal way — never a second, parallel
 * way of authenticating.
 *
 * Supabase's *default* "Confirm signup" email template uses
 * `{{ .ConfirmationURL }}`, which points at Supabase's own hosted
 * `/auth/v1/verify` endpoint (not this route) and only afterwards redirects
 * here — for an email-OTP confirmation, that lands as
 * `?token_hash=...&type=...`, never `?code=`. `?code=...` is what PKCE
 * flows (e.g. OAuth) deliver directly to this route. Both are handled here
 * rather than in two competing routes, since they're just two shapes of the
 * same "finish authenticating" request.
 *
 * Every redirect target is a fixed, known CivicFix path — `/sign-in` (with
 * an internally-defined `error` code, never raw user input) or
 * the role home from `resolveRoleHome(role)`, where `role` is always re-derived from the
 * authenticated user's own profile row, never trusted from the URL/query.
 *
 * REQUIRES matching config in the Supabase Dashboard, which lives outside
 * this repo and isn't set by any code here:
 *   - Authentication -> URL Configuration -> Redirect URLs: add both
 *       https://<your-production-domain>/auth/callback   (production)
 *       http://localhost:3000/auth/callback              (local dev)
 *   - Authentication -> Email Templates -> Confirm signup: unless it has
 *     already been customized to link straight at this route with a
 *     `token_hash` (e.g. `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email`),
 *     the default template still works via the `/verify` redirect above —
 *     no template change is required for the `token_hash` path added here.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const typeParam = request.nextUrl.searchParams.get("type");

  if (!code && !(tokenHash && isEmailOtpType(typeParam))) {
    return NextResponse.redirect(new URL("/sign-in?error=missing_code", request.url));
  }

  const supabase = await createClient();
  const { error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : await supabase.auth.verifyOtp({ token_hash: tokenHash!, type: typeParam as EmailOtpType });

  if (error) {
    return NextResponse.redirect(new URL("/sign-in?error=confirmation_failed", request.url));
  }

  // An admin invitation (only reaches here when the Supabase "Invite user"
  // template links straight at this route with a token_hash) still needs
  // the invited user to choose their own password before anything else.
  if (!code && typeParam === "invite") {
    return NextResponse.redirect(new URL("/auth/accept-invite", request.url));
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profile } = user
    ? await supabase.from("profiles").select("role").eq("id", user.id).single()
    : { data: null };
  const home = resolveRoleHome(profile?.role);

  if (!home) {
    // Never guess a role (and never default to citizen) for an account
    // with no valid profile — end the session and show a safe message.
    console.error("[auth/callback] authenticated user has no valid application role", {
      userId: user?.id ?? null,
      hasProfile: !!profile,
    });
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/sign-in?error=account_not_configured", request.url));
  }

  return NextResponse.redirect(new URL(home, request.url));
}
