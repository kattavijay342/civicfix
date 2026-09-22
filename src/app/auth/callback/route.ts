import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { roleHomePath } from "@/lib/role-routes";

/**
 * Where Supabase's email-confirmation link lands. This is the only auth
 * mechanism at work here: it exchanges the `code` the confirmation email
 * already carries for a session using the same per-request Supabase client
 * every other Server Action/Component uses, so it persists a session cookie
 * the normal way — never a second, parallel way of authenticating.
 *
 * Every redirect target is a fixed, known CivicFix path — `/sign-in` (with
 * an internally-defined `error` code, never raw user input) or
 * `roleHomePath(role)`, where `role` is always re-derived from the
 * authenticated user's own profile row, never trusted from the URL/query.
 *
 * REQUIRES matching config in the Supabase Dashboard (Authentication -> URL
 * Configuration), which lives outside this repo and isn't set by any code
 * here:
 *   - Site URL: your deployed CivicFix URL (e.g. https://<your-production-domain>)
 *   - Redirect URLs: add both
 *       https://<your-production-domain>/auth/callback   (production)
 *       http://localhost:3000/auth/callback              (local dev)
 * Without both listed there, Supabase will reject the redirect and the
 * confirmation link will fail even though this route is correct.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(new URL("/sign-in?error=missing_code", request.url));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(new URL("/sign-in?error=confirmation_failed", request.url));
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  let role = "citizen";
  if (user) {
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    if (profile?.role) role = profile.role;
  }

  return NextResponse.redirect(new URL(roleHomePath(role), request.url));
}
