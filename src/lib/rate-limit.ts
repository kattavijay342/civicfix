import "server-only";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Postgres-backed shared rate limiter (see supabase/migrations/0005 for why
 * not an in-memory counter — this app runs as stateless serverless
 * functions, so an in-memory counter would silently under-count). One round
 * trip per check via the `check_rate_limit` SECURITY DEFINER function,
 * which is not reachable by anon/authenticated roles — only this
 * service-role call can invoke it.
 *
 * Fails OPEN on ANY failure of the rate-limit subsystem itself (logged,
 * never thrown) — including the admin client failing to construct (e.g.
 * missing/misconfigured SUPABASE_SERVICE_ROLE_KEY) as well as the RPC call
 * itself failing. A broken limiter should not become a second way to take
 * the whole app down — including blocking sign-in entirely — and if the
 * database is unreachable the request is about to fail for other reasons
 * anyway. This is a deliberate tradeoff — see the Phase 4 report. This must
 * never mask a genuine Supabase Auth failure — callers only reach Auth once
 * this returns `allowed`.
 */
export async function checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("check_rate_limit", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });

    if (error) {
      console.error("Rate limit check failed; failing open", error);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const row = Array.isArray(data) ? data[0] : data;
    return {
      allowed: row?.allowed ?? true,
      retryAfterSeconds: row?.retry_after_seconds ?? 0,
    };
  } catch (err) {
    console.error("Rate limit subsystem unavailable; failing open", err);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/** Human-readable "try again in..." for Server Action error states. */
export function retryAfterMessage(retryAfterSeconds: number): string {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  const when = minutes <= 1 ? "a minute" : `${minutes} minutes`;
  return `Too many attempts. Please try again in ${when}.`;
}

/**
 * Best-effort caller IP for anonymous (pre-auth) actions like sign-in/up,
 * where there's no user id yet to key the bucket on. Not spoof-proof
 * on its own (a client can forge X-Forwarded-For), but this app has no
 * reverse proxy of its own to strip that header, so this matches what the
 * hosting platform (Vercel) actually forwards. Combined with a per-email
 * bucket for auth actions, this still meaningfully raises the cost of
 * credential-stuffing / signup abuse even if the IP signal is imperfect.
 */
export async function getClientIp(): Promise<string> {
  const h = await headers();
  const forwardedFor = h.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  const realIp = h.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}
