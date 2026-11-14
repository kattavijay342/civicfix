import "server-only";
import { timingSafeEqual } from "node:crypto";

/**
 * Shared authorization for scheduler-invoked routes (/api/cron/*): a single
 * shared secret, CRON_SECRET, sent as `Authorization: Bearer <secret>` —
 * the standard pattern for Vercel Cron and for Supabase pg_cron + pg_net.
 * Extracted unchanged from the reminders route.
 */

/** Constant-time comparison so response timing can't be used to recover
 * the secret byte by byte. */
export function isAuthorizedCronRequest(header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
