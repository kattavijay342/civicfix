import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Per-request Supabase client for Server Components / Server Actions /
 * Route Handlers. Reads the caller's session from cookies and respects RLS
 * — this is the client every read in the app should use, so jurisdiction
 * and ownership filtering happens in the database, not just in the UI.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component during render, where cookies
            // can't be written. proxy.ts refreshes the session cookie on
            // the next request, so this is safe to ignore.
          }
        },
      },
    }
  );
}

/**
 * Convenience helper: the authenticated user's id + profile row, or null.
 * Never trust a role/id passed from the client — always re-derive it here.
 */
export async function getSessionProfile() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (!profile) return null;

  return { user, profile };
}
