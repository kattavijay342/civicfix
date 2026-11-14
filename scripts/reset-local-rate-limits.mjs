// Test-harness helper — LOCAL Supabase only. Clears the rate-limiter's
// counters (public.rate_limit_buckets, supabase/migrations/0005) so a full
// local E2E run isn't blocked by counts left over from earlier runs: every
// local sign-in comes from the same IP, which shares one
// auth_signin:ip bucket (20 per 10 minutes, src/lib/actions/auth.ts).
//
// Touches nothing else: no limits, no check_rate_limit(), no application
// code, and no other table (idempotency_keys included). The existing
// cleanup_stale_rate_limit_buckets() only removes rows idle for more than a
// day, so it can't reset same-day buckets.
//
// Aborts before creating any client unless the URL + keys are the local
// Supabase CLI's (scripts/lib/local-supabase-guard.mjs) — a hosted project
// can never be targeted.
// Usage: node --env-file=.env.g8-local scripts/reset-local-rate-limits.mjs
import { createClient } from "@supabase/supabase-js";
import { exitUnlessLocalSupabaseEnv } from "./lib/local-supabase-guard.mjs";

const { url, serviceRoleKey } = exitUnlessLocalSupabaseEnv({ requireAnon: false });
const admin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

const count = async (table) => {
  const { count: n, error } = await admin.from(table).select("*", { count: "exact", head: true });
  if (error) throw new Error(`count(${table}) failed: ${error.message}`);
  return n;
};

// Exit codes are set with process.exitCode, never process.exit(): on Windows
// (Node 24), forcing an exit while the HTTP client's sockets are still
// closing intermittently aborts with
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
// (exit 127) even though the reset itself succeeded. Letting the event loop
// drain avoids that.
const before = { rate_limit_buckets: await count("rate_limit_buckets"), idempotency_keys: await count("idempotency_keys") };
const { error } = await admin.from("rate_limit_buckets").delete().not("key", "is", null);
if (error) {
  console.error(`reset failed: ${error.message}`);
  process.exitCode = 1;
} else {
  const after = { rate_limit_buckets: await count("rate_limit_buckets"), idempotency_keys: await count("idempotency_keys") };
  console.log(`local rate_limit_buckets reset at ${url}: ${before.rate_limit_buckets} -> ${after.rate_limit_buckets}`);
  console.log(`idempotency_keys untouched: ${before.idempotency_keys} -> ${after.idempotency_keys}`);
  process.exitCode = after.rate_limit_buckets === 0 && after.idempotency_keys === before.idempotency_keys ? 0 : 1;
}
