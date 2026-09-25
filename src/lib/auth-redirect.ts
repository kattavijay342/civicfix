const PRODUCTION_SITE_URL = "https://civicfix-sbte.vercel.app";

/**
 * Fixed, non-user-controlled origin for links inside auth emails
 * (sign-up confirmation, admin invitations) — never derived from a request
 * header, so a forged Host can't redirect an email link off-domain.
 * Without an explicit redirect, Supabase falls back to whichever single
 * "Site URL" is configured in the dashboard.
 *
 * Every path built from this must also be listed in Supabase Dashboard ->
 * Authentication -> URL Configuration -> Redirect URLs, or Supabase will
 * ignore it regardless of this code.
 */
export function getAuthRedirectOrigin(): string {
  return process.env.NODE_ENV === "production" ? PRODUCTION_SITE_URL : "http://localhost:3000";
}
