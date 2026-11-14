import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Small shared helpers for CivicFix's lease-based job tables
 * (ai_analysis_jobs — 0019, incident_confirmation_jobs — 0020). Both tables
 * share the same lifecycle columns:
 *   status, attempts, max_attempts, next_attempt_at, locked_until,
 *   last_error_kind, last_error_status, last_model
 * Claiming is done either by the per-report compare-and-set in
 * src/lib/ai-jobs.ts or by the batch SQL functions claim_due_*_jobs (0020).
 */

export type JobTable = "ai_analysis_jobs" | "incident_confirmation_jobs";

/** Backoff after failed attempt `failedAttempt` (1-based) from `schedule`
 * (ms), with ±`jitterRatio` jitter; capped at the schedule's last step.
 * `random` in [0, 1) is injectable for tests. */
export function backoffDelayMs(
  schedule: readonly number[],
  failedAttempt: number,
  jitterRatio: number,
  random: () => number = Math.random
): number {
  const base = schedule[Math.min(Math.max(failedAttempt, 1), schedule.length) - 1];
  const factor = 1 - jitterRatio + 2 * jitterRatio * random();
  return Math.round(base * factor);
}

/**
 * Settles a job this worker holds. Compare-and-set on (status=processing,
 * attempts=claimed) so a worker whose lease expired and was re-claimed can
 * never overwrite the newer claim's state. Returns false when the claim was
 * lost (or on a DB error — logged with the error code only).
 */
export async function settleJob(
  admin: SupabaseClient,
  table: JobTable,
  reportId: string,
  claimedAttempts: number,
  patch: Record<string, unknown>
): Promise<boolean> {
  const { data, error } = await admin
    .from(table)
    .update(patch)
    .eq("report_id", reportId)
    .eq("status", "processing")
    .eq("attempts", claimedAttempts)
    .select("report_id");
  if (error) {
    console.error(`[${table}] settle failed`, { reportId, code: error.code ?? "unknown" });
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

/** Sanitized error metadata stored on a job row — never a raw message. */
export interface JobErrorClass {
  kind: string;
  status: number | null;
  retryable: boolean;
}

/**
 * CP2.3 (M-1) — bounded handling for a "not enough remaining lease budget to
 * safely start a Gemini request" shortfall, shared by ai-jobs.ts and
 * incident-jobs.ts so both job types use identical semantics.
 *
 * claim_due_ai_jobs()/claim_due_incident_jobs() (0020) increment `attempts`
 * at claim time, before the caller ever checks the lease budget. A
 * shortfall is therefore NEVER a genuine Gemini failure: this function
 * GIVES BACK that attempt (attempts = claimedAttempts - 1), so `attempts`
 * only ever reflects real tries and a shortfall can never, by itself,
 * exhaust a job's genuine attempt allowance (max_attempts).
 *
 * To bound the alternative risk — a persistently misconfigured worker
 * (e.g. too-short lease relative to its safety margin) deferring the same
 * job forever — a SEPARATE counter, `lease_budget_deferrals`
 * (migration 0022 — NOT applied yet), tracks consecutive shortfalls. Once
 * it exceeds MAX_LEASE_BUDGET_DEFERRALS the job is marked `failed` /
 * `lease_budget_exhausted` instead of deferring again. Every OTHER settle
 * path (a genuine attempt, completion, or notification-only parking)
 * resets this counter to 0 — see the `lease_budget_deferrals: 0` patches
 * in ai-jobs.ts / incident-jobs.ts.
 */
export const MAX_LEASE_BUDGET_DEFERRALS = 20;
/** Deferred jobs become due again after this delay — long enough that a
 * single worker run (240s) cannot hot-loop reclaiming the same job. */
export const LEASE_BUDGET_DEFER_MS = 60_000;

export type LeaseBudgetDeferralResult =
  | { outcome: "retry_scheduled"; attempts: number; nextAttemptAt: string; kind: "lease_budget" }
  | { outcome: "failed"; attempts: number; kind: "lease_budget_exhausted" }
  | { outcome: "lost_lease" };

export async function deferForLeaseBudget(
  admin: SupabaseClient,
  table: JobTable,
  reportId: string,
  claimedAttempts: number,
  currentDeferrals: number,
  nowMs: number
): Promise<LeaseBudgetDeferralResult> {
  const deferrals = currentDeferrals + 1;
  const givenBackAttempts = claimedAttempts - 1;

  if (deferrals > MAX_LEASE_BUDGET_DEFERRALS) {
    const ok = await settleJob(admin, table, reportId, claimedAttempts, {
      status: "failed",
      locked_until: null,
      attempts: givenBackAttempts,
      lease_budget_deferrals: deferrals,
      last_error_kind: "lease_budget_exhausted",
      last_error_status: null,
    });
    return ok ? { outcome: "failed", attempts: givenBackAttempts, kind: "lease_budget_exhausted" } : { outcome: "lost_lease" };
  }

  const nextAttemptAt = new Date(nowMs + LEASE_BUDGET_DEFER_MS).toISOString();
  const ok = await settleJob(admin, table, reportId, claimedAttempts, {
    status: "pending",
    locked_until: null,
    attempts: givenBackAttempts,
    next_attempt_at: nextAttemptAt,
    lease_budget_deferrals: deferrals,
    last_error_kind: "lease_budget",
    last_error_status: null,
  });
  return ok ? { outcome: "retry_scheduled", attempts: givenBackAttempts, nextAttemptAt, kind: "lease_budget" } : { outcome: "lost_lease" };
}
