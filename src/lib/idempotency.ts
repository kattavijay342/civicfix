import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type IdempotencyOutcome<TResult> =
  | { kind: "run"; commit: (result: TResult) => Promise<void>; release: () => Promise<void> }
  | { kind: "replay"; result: TResult }
  | { kind: "in_progress" };

/**
 * De-duplicates a client-submitted mutation (Phase 4 Step 9) — distinct from
 * report_duplicate_flags, which answers "is this probably the same civic
 * issue?". This answers "did the exact same API call get submitted more
 * than once?" (double form submit, a client retry after a dropped
 * response, ...).
 *
 * `clientKey` is generated once per form mount (crypto.randomUUID(), see
 * the "idempotencyKey" hidden field in the relevant forms) and scoped to
 * (userId, action) via the unique constraint on idempotency_keys — a
 * INSERT ... ON CONFLICT DO NOTHING is the actual dedupe: Postgres itself
 * rejects the second concurrent insert, so there's no separate
 * check-then-insert race window.
 *
 * Only a terminal, side-effect-bearing outcome should ever be `commit`ted
 * (cached for replay) — a request that failed without creating anything
 * should `release` its claim instead, so a genuine retry (not just an
 * accidental double-submit) can actually try again rather than replay a
 * stale failure forever. Callers decide which is which for their own
 * result shape (see src/lib/actions/reports.ts, follow-up.ts, reminders.ts).
 *
 * Usage:
 *   const outcome = await beginIdempotentAction(admin, userId, "create_report", clientKey);
 *   if (outcome.kind === "replay") return outcome.result;
 *   if (outcome.kind === "in_progress") return { status: "error", error: "..." };
 *   const finalState = await performTheRealWork();
 *   if (finalState.status === "error") await outcome.release();
 *   else await outcome.commit(finalState);
 *   return finalState;
 */
export async function beginIdempotentAction<TResult>(
  admin: SupabaseClient,
  userId: string,
  action: string,
  clientKey: string | null | undefined
): Promise<IdempotencyOutcome<TResult>> {
  // No key supplied (e.g. an older client, or a caller that doesn't need
  // this) — just run normally, no dedupe possible.
  if (!clientKey) {
    return { kind: "run", commit: async () => {}, release: async () => {} };
  }

  const runNoDedupe = { kind: "run" as const, commit: async () => {}, release: async () => {} };

  const { data: inserted, error: insertError } = await admin
    .from("idempotency_keys")
    .insert({ user_id: userId, action, client_key: clientKey })
    .select("id")
    .maybeSingle();

  if (!insertError && inserted) {
    const rowId = inserted.id as string;
    return {
      kind: "run",
      commit: async (result: TResult) => {
        await admin.from("idempotency_keys").update({ result: result as object }).eq("id", rowId);
      },
      // Deletes the claim entirely rather than leaving a null-result row —
      // a released key must be fully retry-able, indistinguishable from
      // having never been attempted.
      release: async () => {
        await admin.from("idempotency_keys").delete().eq("id", rowId);
      },
    };
  }

  // Only a real unique-constraint violation (Postgres 23505) means another
  // attempt already claimed this exact key — anything else (the migration
  // hasn't been applied yet, a permissions issue, a transient network
  // error) must fail OPEN, the same as the rate limiter, rather than
  // wrongly blocking every write as "in_progress" forever. An idempotency
  // layer that fails closed is worse than having none at all.
  if (insertError && insertError.code !== "23505") {
    console.error("Idempotency check failed; running without dedupe", insertError);
    return runNoDedupe;
  }

  // Real conflict — a row for this key already exists (this request, or a
  // concurrent one, already claimed it). Look up what it resolved to.
  const { data: existing, error: lookupError } = await admin
    .from("idempotency_keys")
    .select("result")
    .eq("user_id", userId)
    .eq("action", action)
    .eq("client_key", clientKey)
    .maybeSingle();

  if (lookupError) {
    console.error("Idempotency lookup failed; running without dedupe", lookupError);
    return runNoDedupe;
  }

  if (existing?.result != null) {
    return { kind: "replay", result: existing.result as TResult };
  }

  // A row exists but has no result yet — the original attempt is still
  // in-flight. Never re-run the mutation concurrently for the same key.
  return { kind: "in_progress" };
}
