import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser-side Supabase client. Uses the anon key only — every table it can
 * reach is gated by RLS (see supabase/migrations/0002_rls_policies.sql).
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

/**
 * For /auth/accept-invite only. Supabase admin invitations can't use PKCE
 * (the inviting and accepting browsers differ), so with the default
 * "Invite user" email template the session arrives as tokens in the URL
 * fragment, which the PKCE client above rejects during auto-detection.
 * This separate, non-singleton client skips auto-detection so the page can
 * hand exactly those tokens to setSession() — which validates them with
 * Supabase — and still persists the session to the same cookies.
 */
export function createInviteClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { isSingleton: false, auth: { detectSessionInUrl: false } }
  );
}
