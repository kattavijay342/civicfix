import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client. BYPASSES ROW LEVEL SECURITY. Never import this into
 * client code or a Route Handler/Server Action that hasn't already
 * authenticated and authorized the caller itself — this client trusts
 * whatever ids/filters you pass it.
 *
 * Used for: privileged writes after an explicit auth/role check (AI
 * analysis results, department routing, status transitions, resolution
 * evidence, storage uploads/signed URLs), and for provisioning
 * government/department-incharge/admin accounts.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase service role is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
