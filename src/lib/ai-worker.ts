import "server-only";
import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveGeminiModel } from "@/lib/ai";
import {
  AI_JOB_POLICY,
  enqueueAiJob,
  runClaimedAiJob,
  settleExhaustedAiJob,
  type AiJobRow,
  type ProcessAiJobDeps,
} from "@/lib/ai-jobs";
import { INCIDENT_JOB_POLICY, runClaimedIncidentJob, type IncidentJobDeps, type IncidentJobRow } from "@/lib/incident-jobs";
import { INCIDENT_CONFIRM_MODEL } from "@/lib/incident-ai-confirm";
import { settleJob } from "@/lib/job-queue";

/**
 * AI-2 background worker — one run, triggered by the protected route
 * /api/cron/ai-jobs (scheduled by Supabase pg_cron + pg_net every 2 minutes,
 * see supabase/snippets/ai-worker-schedule.sql — NOT scheduled yet).
 *
 * Concurrency / overlap:
 *   - a single global lease (ai_worker_lease, acquire_ai_worker_lease(),
 *     database clock) — a run that can't take it exits immediately with
 *     NO Gemini call, so overlapping cron ticks never stack workers;
 *   - CP2.2 (M2-A): the lease is RENEWED before every claim through the
 *     DATABASE-CLOCK renew_ai_worker_lease() RPC (migration 0021 — NOT
 *     applied yet), a compare-and-set on this run's holder id evaluated
 *     entirely in Postgres; its return value is the remaining lease
 *     duration per Postgres's own now(), so app/DB clock skew can never
 *     make this run believe it holds the lease longer than it really
 *     does. If renewal fails — another run took over after an earlier
 *     expiry — this run stops claiming at once;
 *   - inside a run, jobs are claimed ONE at a time (claim_due_*_jobs with
 *     p_limit = 1, FOR UPDATE SKIP LOCKED) and processed sequentially —
 *     concurrency stays 1, exactly as in CP2;
 *   - CP2.2 (M2): every Gemini request is bounded by
 *     min(90s, DB-returned remaining lease − 30s safety margin), a plain
 *     DURATION never derived from wall-clock subtraction, enforced by an
 *     abort signal AND the SDK's own HTTP timeout; a request is not
 *     started with less than 15s available;
 *   - CP2.2 (M2): the run's own time budget (when to stop starting new
 *     work) is measured with a MONOTONIC clock (performance.now() by
 *     default), immune to an NTP step mid-run — a new job is started only
 *     while >= 120s of the 240s run budget remain, inside the 270s global
 *     lease, the 180s per-job lease and the route's 300s maxDuration;
 *   - the global lease is released in `finally`; a crashed run lets it (and
 *     any job lease) expire, and the next run takes over.
 *
 * SCOPE OF THE "ONE GEMINI REQUEST IN FLIGHT" GUARANTEE: it covers requests
 * made by this worker's jobs (AI analysis and incident confirmation) only.
 * The owner's manual "Retry analysis" (retryAiAnalysis) and the government
 * dashboard's AI insights (generateGovernmentAIInsights) still call Gemini
 * inline and are NOT serialized with the worker.
 */

const HOUR = 60 * 60 * 1000;

export const AI_WORKER_POLICY = {
  leaseName: "ai",
  runBudgetMs: 240_000,
  minRemainingToStartMs: 120_000,
  workerLeaseSeconds: 270,
  jobLeaseSeconds: 180,
  /** M2: a Gemini request must end this long before the global lease expires. */
  leaseSafetyMarginMs: 30_000,
  /** Hard cap per run, on top of the time budget. */
  maxJobsPerRun: 20,
  /** Missing-job recovery: max jobs enqueued per run. */
  recoveryLimit: 20,
  recoveryWindowMs: 48 * HOUR,
  /** M2/M3: recovery is bounded in time and rows scanned per run. */
  recoveryBudgetMs: 20_000,
  recoveryPageSize: 50,
  recoveryMaxPages: 4,
  /** CP2.2 (M3): when an entire fetched page is at-or-before the current
   * (created_at, id) cursor — a tied-timestamp block wider than the page
   * size — the page limit is doubled and the SAME cursor position is
   * retried, up to this cap, so a large group of identical timestamps
   * cannot stall pagination before real new rows are ever reached. */
  recoveryMaxPageLimit: 400,
  authLookupTimeoutMs: 5_000,
  /** Expired-lease rows inspected per run for exhausted final attempts. */
  exhaustedSweepLimit: 20,
} as const;

/** The per-job lease the batch claim uses must equal the job policies'
 * (asserted in ai-worker.test.ts). */
export const WORKER_JOB_LEASE_MATCHES_POLICIES =
  AI_JOB_POLICY.leaseMs === AI_WORKER_POLICY.jobLeaseSeconds * 1000 &&
  INCIDENT_JOB_POLICY.leaseMs === AI_WORKER_POLICY.jobLeaseSeconds * 1000;

const TEST_ACCOUNT_DOMAIN = "@test.civicfix.local";

export type ReporterVerdict = "ok" | "test_account" | "missing" | "temporary";

/** Resolves `promise`, or `onTimeout` after `ms` (the underlying request is
 * not cancelled — we just stop waiting for it). */
async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((resolve) => (timer = setTimeout(() => resolve(onTimeout), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * M3: classifies a report's reporter, distinguishing a CONFIRMED missing
 * user (HTTP 404 / user_not_found, or no user returned) from a TEMPORARY
 * lookup problem (5xx, network, timeout, anything unexpected) — the latter
 * is skipped this run and retried next run, never treated as deleted.
 */
export async function verifyReporter(admin: SupabaseClient, reporterId: string, timeoutMs: number): Promise<ReporterVerdict> {
  try {
    const res = await withTimeout(admin.auth.admin.getUserById(reporterId), timeoutMs, null);
    if (!res) return "temporary";
    const { data, error } = res as { data: { user: { email?: string | null } | null } | null; error: { status?: number; code?: string } | null };
    if (error) {
      return error.status === 404 || error.code === "user_not_found" ? "missing" : "temporary";
    }
    if (!data?.user) return "missing";
    return (data.user.email ?? "").toLowerCase().endsWith(TEST_ACCOUNT_DOMAIN) ? "test_account" : "ok";
  } catch {
    return "temporary";
  }
}

/**
 * M3: records a permanent recovery exclusion as a terminal job row
 * (status 'failed', attempts 0, sanitized kind) with INSERT ... ON CONFLICT
 * DO NOTHING. The report is never analyzed (attempts 0, never claimable)
 * and find_reports_missing_ai_job() no longer returns it, so excluded
 * reports can't keep occupying the recovery window. Reversible by deleting
 * that job row. Never touches the report itself.
 */
async function recordRecoveryExclusion(
  admin: SupabaseClient,
  reportId: string,
  kind: "excluded_test_account" | "reporter_missing"
): Promise<boolean> {
  const { error } = await admin
    .from("ai_analysis_jobs")
    .upsert(
      { report_id: reportId, status: "failed", attempts: 0, last_error_kind: kind },
      { onConflict: "report_id", ignoreDuplicates: true }
    )
    .select("report_id");
  if (error) console.error("[ai-worker] recording recovery exclusion failed", { reportId, code: error.code ?? "unknown" });
  return !error;
}

export type RecoveryResult =
  | { status: "skipped"; reason: "cutoff_missing" | "cutoff_invalid" }
  | { status: "error" }
  | {
      status: "ran";
      since: string;
      scanned: number;
      pages: number;
      enqueued: number;
      alreadyQueued: number;
      excludedTestAccounts: number;
      reporterMissing: number;
      temporaryErrors: number;
      enqueueFailed: number;
      stoppedBy: "exhausted" | "limit" | "budget" | "max_pages" | "tie_block_exceeded";
    };

/**
 * Missing-job recovery: recent reports with no ai_analyses row and no AI job
 * get one, through the same idempotent enqueueAiJob. NEVER a historical
 * backfill:
 *   - AI_JOB_RECOVERY_SINCE is REQUIRED (ISO-8601, not in the future); if it
 *     is missing or invalid, recovery does not run at all;
 *   - the cutoff is the later of that value and now − 48h, and the SQL
 *     function find_reports_missing_ai_job() enforces the same 48h ceiling;
 *   - E2E fixture locations ('E2E-%') are excluded in SQL.
 * M3 — starvation-proof and bounded:
 *   - pages through candidates with a STABLE (created_at, id) keyset
 *     cursor: a row is only processed once it sorts strictly after the
 *     last-processed (created_at, id) pair. find_reports_missing_ai_job()
 *     (0020) itself only takes p_since/p_limit, so the id-ordering half of
 *     the cursor is applied here, in-process, over its
 *     `order by created_at, id` result — no new migration needed. If an
 *     entire fetched page is at-or-before the cursor (more rows share one
 *     exact timestamp than the page size), the page limit is doubled and
 *     the same cursor position is retried, up to recoveryMaxPageLimit, so
 *     a large tied-timestamp block cannot stall pagination;
 *   - up to recoveryMaxPages RPC calls and recoveryBudgetMs wall-clock time
 *     per run, stopping once recoveryLimit reports are enqueued;
 *   - test-account reporters and CONFIRMED missing reporters are recorded as
 *     terminal exclusions (recordRecoveryExclusion), so they are never
 *     re-scanned; TEMPORARY lookup failures are skipped (fail closed) and
 *     retried on a later run; reporter lookups are cached per run and each
 *     is bounded by authLookupTimeoutMs.
 * Never touches report status, ownership, assignment or routing.
 */
export async function recoverMissingAiJobs(
  admin: SupabaseClient,
  opts: { now: number; recoverySince: string | undefined; limit?: number; clock?: () => number }
): Promise<RecoveryResult> {
  const clock = opts.clock ?? Date.now;
  const raw = opts.recoverySince?.trim();
  if (!raw) return { status: "skipped", reason: "cutoff_missing" };
  const cutoff = Date.parse(raw);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) || !Number.isFinite(cutoff) || cutoff > opts.now) {
    return { status: "skipped", reason: "cutoff_invalid" };
  }
  const since = new Date(Math.max(cutoff, opts.now - AI_WORKER_POLICY.recoveryWindowMs)).toISOString();
  const limit = opts.limit ?? AI_WORKER_POLICY.recoveryLimit;
  const startedAt = clock();

  const result: Extract<RecoveryResult, { status: "ran" }> = {
    status: "ran",
    since,
    scanned: 0,
    pages: 0,
    enqueued: 0,
    alreadyQueued: 0,
    excludedTestAccounts: 0,
    reporterMissing: 0,
    temporaryErrors: 0,
    enqueueFailed: 0,
    stoppedBy: "exhausted",
  };
  const verdicts = new Map<string, ReporterVerdict>();
  /** The stable keyset cursor: the last row actually processed. A row is
   * taken only once it sorts strictly after this pair — matching the SQL
   * result's own `order by created_at, id`. */
  let cursor: { createdAt: string; id: string } | null = null;
  let pageLimit: number = AI_WORKER_POLICY.recoveryPageSize;
  const isAfterCursor = (r: { report_id: string; created_at: string }) =>
    !cursor || r.created_at > cursor.createdAt || (r.created_at === cursor.createdAt && r.report_id > cursor.id);

  pages: while (true) {
    if (result.pages >= AI_WORKER_POLICY.recoveryMaxPages) {
      result.stoppedBy = "max_pages";
      break;
    }
    if (clock() - startedAt >= AI_WORKER_POLICY.recoveryBudgetMs) {
      result.stoppedBy = "budget";
      break;
    }
    // CP2.3 (M-2): capture the limit actually used for THIS fetch before
    // anything below can reset `pageLimit` for the next iteration — the
    // "is this the last page" check must compare against what was really
    // requested just now, never against a value already reset for later.
    const requestedLimit = pageLimit;
    const { data, error } = await admin.rpc("find_reports_missing_ai_job", {
      p_since: cursor ? cursor.createdAt : since,
      p_limit: requestedLimit,
    });
    if (error) {
      console.error("[ai-worker] missing-job lookup failed", { code: error.code ?? "unknown" });
      return result.pages === 0 ? { status: "error" } : result;
    }
    result.pages += 1;
    const rows = (Array.isArray(data) ? data : []) as Array<{ report_id: string; reporter_id: string; created_at: string }>;
    const fresh = rows.filter(isAfterCursor);

    if (fresh.length === 0) {
      if (rows.length < requestedLimit) break; // truly nothing left — done
      // The whole page is at-or-before the cursor: more rows share this
      // exact timestamp than fit in one page. Grow the limit and retry the
      // SAME cursor position instead of stalling.
      if (pageLimit >= AI_WORKER_POLICY.recoveryMaxPageLimit) {
        result.stoppedBy = "tie_block_exceeded";
        break;
      }
      pageLimit = Math.min(pageLimit * 2, AI_WORKER_POLICY.recoveryMaxPageLimit);
      continue;
    }

    for (const row of fresh) {
      cursor = { createdAt: row.created_at, id: row.report_id };
      if (clock() - startedAt >= AI_WORKER_POLICY.recoveryBudgetMs) {
        result.stoppedBy = "budget";
        break pages;
      }
      result.scanned += 1;
      let verdict = verdicts.get(row.reporter_id);
      if (!verdict) {
        verdict = await verifyReporter(admin, row.reporter_id, AI_WORKER_POLICY.authLookupTimeoutMs);
        if (verdict !== "temporary") verdicts.set(row.reporter_id, verdict);
      }
      if (verdict === "temporary") {
        result.temporaryErrors += 1;
        continue;
      }
      if (verdict === "test_account") {
        if (await recordRecoveryExclusion(admin, row.report_id, "excluded_test_account")) result.excludedTestAccounts += 1;
        continue;
      }
      if (verdict === "missing") {
        if (await recordRecoveryExclusion(admin, row.report_id, "reporter_missing")) result.reporterMissing += 1;
        continue;
      }
      const enqueued = await enqueueAiJob(admin, row.report_id);
      if (enqueued === "queued") result.enqueued += 1;
      else if (enqueued === "already_queued") result.alreadyQueued += 1;
      else result.enqueueFailed += 1;
      if (result.enqueued >= limit) {
        result.stoppedBy = "limit";
        break pages;
      }
    }

    // CP2.3 (M-2): compare against requestedLimit (what was actually
    // fetched this time), never the pageLimit value that is about to be
    // reset below for the NEXT iteration.
    const lastPage = rows.length < requestedLimit;
    pageLimit = AI_WORKER_POLICY.recoveryPageSize; // a normal page progressed — reset growth for the NEXT fetch
    if (lastPage) break;
  }
  return result;
}

export interface AiWorkerSummary {
  status: "ran" | "lease_held" | "lease_error";
  stoppedReason?: "no_work" | "deadline" | "max_jobs" | "claim_error" | "lease_lost" | "migration_missing";
  recovery?: RecoveryResult;
  exhaustedSettled: number;
  aiJobs: { processed: number; completed: number; retryScheduled: number; failed: number; notifyPending: number; lostLease: number; errors: number };
  incidentJobs: {
    processed: number;
    confirmed: number;
    notConfirmed: number;
    notEligible: number;
    alreadyLinked: number;
    retryScheduled: number;
    failed: number;
    lostLease: number;
    errors: number;
  };
}

export interface RunAiWorkerOptions {
  admin: SupabaseClient;
  /** Epoch ms by which the run must stop starting new work. Clamped to
   * start + AI_WORKER_POLICY.runBudgetMs. */
  deadline: number;
  limits?: { maxJobsPerRun?: number; recoveryLimit?: number };
  /** Defaults to process.env.AI_JOB_RECOVERY_SINCE. */
  recoverySince?: string;
  deps?: {
    now?: () => number;
    random?: () => number;
    holder?: string;
    /** CP2.2 (M2): a MONOTONIC clock (default performance.now()), used
     * only to measure how much of this run's own time budget has elapsed.
     * Unlike `now` (wall clock, used for DB timestamps), this is never
     * affected by an NTP step or clock adjustment during a run. */
    monotonicNow?: () => number;
    ai?: ProcessAiJobDeps;
    incident?: IncidentJobDeps;
  };
}

function emptySummary(status: AiWorkerSummary["status"]): AiWorkerSummary {
  return {
    status,
    exhaustedSettled: 0,
    aiJobs: { processed: 0, completed: 0, retryScheduled: 0, failed: 0, notifyPending: 0, lostLease: 0, errors: 0 },
    incidentJobs: { processed: 0, confirmed: 0, notConfirmed: 0, notEligible: 0, alreadyLinked: 0, retryScheduled: 0, failed: 0, lostLease: 0, errors: 0 },
  };
}

/** Settles crashed FINAL attempts (expired lease, no attempt left) in both
 * job tables, so nothing stays stuck in `processing` forever. AI jobs go
 * through settleExhaustedAiJob (M4: completes them when the analysis exists,
 * after verified notification delivery). */
async function sweepExhausted(admin: SupabaseClient, nowMs: number): Promise<number> {
  const nowIso = new Date(nowMs).toISOString();
  let settled = 0;
  for (const table of ["ai_analysis_jobs", "incident_confirmation_jobs"] as const) {
    const { data, error } = await admin
      .from(table)
      .select("report_id, status, attempts, max_attempts, next_attempt_at, locked_until, last_error_kind, last_error_status, last_model")
      .eq("status", "processing")
      .lt("locked_until", nowIso)
      .limit(AI_WORKER_POLICY.exhaustedSweepLimit);
    if (error) {
      console.error("[ai-worker] exhausted sweep failed", { table, code: error.code ?? "unknown" });
      continue;
    }
    for (const row of (data ?? []) as AiJobRow[]) {
      if (row.attempts < row.max_attempts) continue; // claimable — the claim functions recover it
      if (table === "ai_analysis_jobs") {
        // notified_at/created_at aren't in the shared query above (the
        // incident table has neither column); read them only for this row.
        const { data: full } = await admin
          .from("ai_analysis_jobs")
          .select("notified_at, created_at")
          .eq("report_id", row.report_id)
          .maybeSingle();
        const r = await settleExhaustedAiJob(
          admin,
          { ...row, notified_at: (full?.notified_at as string | null) ?? null, created_at: full?.created_at as string | undefined },
          nowMs
        );
        if (r?.outcome === "failed" || r?.outcome === "completed") settled += 1;
      } else if (
        await settleJob(admin, table, row.report_id, row.attempts, {
          status: "failed",
          locked_until: null,
          last_error_kind: "lease_expired",
          last_error_status: null,
        })
      ) {
        settled += 1;
      }
    }
  }
  return settled;
}

/** PostgREST's "could not find the function" code — returned when the
 * caller's schema cache has no matching function, e.g. because a required
 * migration hasn't been applied to this database yet. */
const POSTGREST_FUNCTION_NOT_FOUND = "PGRST202";

export type RenewLeaseResult =
  | { ok: true; remainingMs: number }
  /** Normal contention: another holder owns the lease, or it has simply
   * expired without being renewed in time. Expected, routine. */
  | { ok: false; reason: "lost" }
  /** CP2.3 (M-3): the RPC itself does not exist — migration 0021 has not
   * been applied to this database. This is a deployment/configuration
   * problem, not routine lease contention, and is reported distinctly so
   * it is never mistaken for one. */
  | { ok: false; reason: "migration_missing" };

/**
 * CP2.2 (M2-A): renews the global lease for this run's holder through the
 * DATABASE-clock renew_ai_worker_lease() RPC (migration 0021). Compare-and-
 * set on (name, holder) happens in Postgres itself; the function returns
 * the remaining lease duration IN MILLISECONDS, computed entirely from the
 * database's own now() — never from this process's wall clock — so app/DB
 * clock skew cannot make the caller believe it holds the lease longer (or
 * shorter) than Postgres actually grants it.
 *
 * CP2.3 (M-3): a missing-function response (PGRST202) is distinguished
 * from ordinary lease loss and logged as an explicit configuration error
 * naming the migration — never the raw error message (which could include
 * connection/schema details), only its sanitized code. Either way the
 * worker remains fail-closed: no jobs are processed until renewal is
 * confirmed.
 */
async function renewWorkerLease(admin: SupabaseClient, holder: string): Promise<RenewLeaseResult> {
  const { data, error } = await admin.rpc("renew_ai_worker_lease", {
    p_name: AI_WORKER_POLICY.leaseName,
    p_holder: holder,
    p_seconds: AI_WORKER_POLICY.workerLeaseSeconds,
  });
  if (error) {
    if (error.code === POSTGREST_FUNCTION_NOT_FOUND) {
      console.error(
        "[ai-worker] CONFIGURATION ERROR: renew_ai_worker_lease is missing from this database — " +
          "migration 0021_ai_worker_lease_renewal.sql has not been applied. The worker is stopping " +
          "(fail-closed); no AI or incident jobs will be processed until it is applied."
      );
      return { ok: false, reason: "migration_missing" };
    }
    console.error("[ai-worker] lease renewal failed", { code: error.code ?? "unknown" });
    return { ok: false, reason: "lost" };
  }
  return typeof data === "number" ? { ok: true, remainingMs: data } : { ok: false, reason: "lost" };
}

/**
 * Queue-health classification (CP2.2 optional hardening) — distinguishes a
 * job genuinely being worked on from one merely PARKED for a notification
 * retry (status='processing', attempts=max_attempts, last_error_kind in
 * {'notify_failed'}), and from a permanent recovery EXCLUSION
 * (status='failed', attempts=0, last_error_kind in
 * {'excluded_test_account','reporter_missing'}) or an abandoned retry
 * (status='failed', last_error_kind='notify_abandoned'). Monitoring that
 * counts "processing" or "failed" rows as active work should exclude these
 * — see the matching queries in supabase/snippets/ai-worker-schedule.sql.
 */
export type AiJobHealthCategory = "active" | "parked_notify" | "excluded" | "notify_abandoned";

export function aiJobHealthCategory(job: Pick<AiJobRow, "status" | "attempts" | "max_attempts" | "last_error_kind">): AiJobHealthCategory {
  if (job.status === "processing" && job.attempts >= job.max_attempts && job.last_error_kind === "notify_failed") return "parked_notify";
  if (job.status === "failed" && job.attempts === 0 && (job.last_error_kind === "excluded_test_account" || job.last_error_kind === "reporter_missing")) {
    return "excluded";
  }
  if (job.status === "failed" && job.last_error_kind === "notify_abandoned") return "notify_abandoned";
  return "active";
}

/**
 * One worker run. Returns a sanitized summary (counts and categories only —
 * never report content, error messages, keys or personal data).
 */
export async function runAiWorker(opts: RunAiWorkerOptions): Promise<AiWorkerSummary> {
  const { admin } = opts;
  const now = opts.deps?.now ?? Date.now;
  // CP2.2 (M2): `monotonicNow` measures ELAPSED RUN TIME only — it is read
  // once at the top (wall clock, to combine the caller's deadline with the
  // policy cap into one duration) and then exclusively via a monotonic
  // clock from here on, so an NTP step mid-run can't shorten or lengthen
  // how much budget this run believes it has left.
  const monotonicNow = opts.deps?.monotonicNow ?? (() => performance.now());
  const holder = opts.deps?.holder ?? randomUUID();
  const startedAt = now();
  const runBudgetMs = Math.max(0, Math.min(AI_WORKER_POLICY.runBudgetMs, opts.deadline - startedAt));
  const monoStart = monotonicNow();
  const remainingRunMs = () => runBudgetMs - (monotonicNow() - monoStart);
  const maxJobs = opts.limits?.maxJobsPerRun ?? AI_WORKER_POLICY.maxJobsPerRun;

  const { data: acquired, error: leaseError } = await admin.rpc("acquire_ai_worker_lease", {
    p_name: AI_WORKER_POLICY.leaseName,
    p_holder: holder,
    p_seconds: AI_WORKER_POLICY.workerLeaseSeconds,
  });
  if (leaseError) {
    console.error("[ai-worker] lease acquire failed", { code: leaseError.code ?? "unknown" });
    return emptySummary("lease_error");
  }
  if (acquired !== true) return emptySummary("lease_held");

  const summary = emptySummary("ran");
  try {
    summary.recovery = await recoverMissingAiJobs(admin, {
      now: now(),
      clock: now,
      recoverySince: opts.recoverySince ?? process.env.AI_JOB_RECOVERY_SINCE,
      limit: opts.limits?.recoveryLimit,
    });
    summary.exhaustedSettled = await sweepExhausted(admin, now());

    const aiModel = resolveGeminiModel();
    let preferIncident = false;
    let processed = 0;
    summary.stoppedReason = "no_work";

    while (true) {
      if (processed >= maxJobs) {
        summary.stoppedReason = "max_jobs";
        break;
      }
      if (remainingRunMs() < AI_WORKER_POLICY.minRemainingToStartMs) {
        summary.stoppedReason = "deadline";
        break;
      }
      // CP2.2 (M2-A): renew via the database-clock RPC before every claim;
      // its return value is already a DURATION (ms remaining, per
      // Postgres's own now()) — stop at once if the lease is no longer
      // ours. CP2.3 (M-3): a missing migration is reported distinctly from
      // ordinary contention via `renewal.reason`.
      const renewal = await renewWorkerLease(admin, holder);
      if (!renewal.ok) {
        summary.stoppedReason = renewal.reason === "migration_missing" ? "migration_missing" : "lease_lost";
        break;
      }
      const geminiTimeoutMs = Math.max(0, renewal.remainingMs - AI_WORKER_POLICY.leaseSafetyMarginMs);

      // Alternate which queue is tried first so neither can starve the other;
      // still exactly ONE job at a time.
      const order: Array<"ai" | "incident"> = preferIncident ? ["incident", "ai"] : ["ai", "incident"];
      preferIncident = !preferIncident;
      let ranOne = false;
      let claimFailed = false;

      for (const kind of order) {
        const { data, error } =
          kind === "ai"
            ? await admin.rpc("claim_due_ai_jobs", { p_limit: 1, p_lease_seconds: AI_WORKER_POLICY.jobLeaseSeconds, p_model: aiModel })
            : await admin.rpc("claim_due_incident_jobs", {
                p_limit: 1,
                p_lease_seconds: AI_WORKER_POLICY.jobLeaseSeconds,
                p_model: INCIDENT_CONFIRM_MODEL,
              });
        if (error) {
          console.error("[ai-worker] claim failed", { kind, code: error.code ?? "unknown" });
          claimFailed = true;
          continue;
        }
        const row = Array.isArray(data) ? data[0] : null;
        if (!row) continue;

        ranOne = true;
        processed += 1;
        if (kind === "ai") {
          summary.aiJobs.processed += 1;
          try {
            const r = await runClaimedAiJob(admin, row as AiJobRow, {
              now,
              random: opts.deps?.random,
              geminiTimeoutMs,
              ...opts.deps?.ai,
            });
            if (r.outcome === "completed") summary.aiJobs.completed += 1;
            else if (r.outcome === "retry_scheduled") summary.aiJobs.retryScheduled += 1;
            else if (r.outcome === "failed") summary.aiJobs.failed += 1;
            else if (r.outcome === "notify_pending") summary.aiJobs.notifyPending += 1;
            else if (r.outcome === "lost_lease") summary.aiJobs.lostLease += 1;
          } catch (err) {
            // Unexpected — the job keeps its lease and is recovered after it expires.
            summary.aiJobs.errors += 1;
            console.error("[ai-worker] ai job threw", { code: err instanceof Error ? err.name : "unknown" });
          }
        } else {
          summary.incidentJobs.processed += 1;
          try {
            const r = await runClaimedIncidentJob(admin, row as IncidentJobRow, {
              now,
              random: opts.deps?.random,
              geminiTimeoutMs,
              ...opts.deps?.incident,
            });
            if (r.outcome === "confirmed") summary.incidentJobs.confirmed += 1;
            else if (r.outcome === "not_confirmed") summary.incidentJobs.notConfirmed += 1;
            else if (r.outcome === "not_eligible") summary.incidentJobs.notEligible += 1;
            else if (r.outcome === "already_linked") summary.incidentJobs.alreadyLinked += 1;
            else if (r.outcome === "retry_scheduled") summary.incidentJobs.retryScheduled += 1;
            else if (r.outcome === "failed") summary.incidentJobs.failed += 1;
            else if (r.outcome === "lost_lease") summary.incidentJobs.lostLease += 1;
          } catch (err) {
            summary.incidentJobs.errors += 1;
            console.error("[ai-worker] incident job threw", { code: err instanceof Error ? err.name : "unknown" });
          }
        }
        break; // one job per iteration
      }

      if (!ranOne) {
        summary.stoppedReason = claimFailed ? "claim_error" : "no_work";
        break;
      }
    }
  } finally {
    const { error } = await admin.rpc("release_ai_worker_lease", { p_name: AI_WORKER_POLICY.leaseName, p_holder: holder });
    if (error) console.error("[ai-worker] lease release failed (it will expire)", { code: error.code ?? "unknown" });
  }
  return summary;
}
