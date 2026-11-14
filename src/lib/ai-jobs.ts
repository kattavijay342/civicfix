import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { analyzeReport, resolveGeminiModel } from "@/lib/ai";
import { ensureAiAnalysisNotifications, persistAnalysis, type AnalysisResult } from "@/lib/ai-analysis-persistence";
import { categoryFromDb } from "@/lib/db-enums";
import { backoffDelayMs, deferForLeaseBudget, settleJob, type JobErrorClass } from "@/lib/job-queue";
import type { CivicLocation } from "@/lib/types";

/**
 * Gemini AI analysis job queue — table `ai_analysis_jobs`
 * (supabase/migrations/0019_ai_analysis_jobs.sql, notified_at from 0020).
 *
 * Report creation calls enqueueAiJob() once the report row exists and then
 * returns WITHOUT calling Gemini. A job is run by:
 *   - processAiJob(reportId): per-report read + compare-and-set claim, then
 *     runClaimedAiJob — used for targeted/manual processing and tests;
 *   - the AI-2 background worker (src/lib/ai-worker.ts), which claims in
 *     batches with the claim_due_ai_jobs() SQL function (FOR UPDATE SKIP
 *     LOCKED, database clock) and then calls runClaimedAiJob.
 * Either way, at most ONE Gemini request is made per successful claim.
 *
 * Invariants (unit-tested in ai-jobs.test.ts / ai-worker.test.ts):
 *   - one job per report (PK report_id + INSERT ... ON CONFLICT DO NOTHING);
 *   - one worker per job at a time (compare-and-set claim on status +
 *     attempts, with a time-limited lease);
 *   - never routes, never writes report_assignments, never changes
 *     reports.status or reports.reporter_id — AI is enrichment only;
 *   - ai_analyses.report_id UNIQUE makes a second analysis a no-op;
 *   - AI-analysis notifications are sent through
 *     ensureAiAnalysisNotifications (check-then-send) and recorded in
 *     notified_at, so a crash between saving and notifying is recovered on
 *     the next claim without duplicating what already exists;
 *   - only sanitized error categories / HTTP status codes are stored.
 */

const MINUTE = 60_000;

/** Centralized, unit-testable retry policy. */
export const AI_JOB_POLICY = {
  /** Delay before the next attempt after failed attempt n (1-based):
   * 1 min, 5 min, 15 min, 60 min, 180 min. The attempt that reaches
   * max_attempts is never rescheduled — the job is marked failed. */
  retryDelaysMs: [1 * MINUTE, 5 * MINUTE, 15 * MINUTE, 60 * MINUTE, 180 * MINUTE],
  /** ±20% jitter so jobs that failed together don't retry together. */
  jitterRatio: 0.2,
  /** One Gemini request's own timeout inside the worker. Google currently
   * returns its 503 after ~60s, so this is long enough to see the real
   * status. It applies to background processing only — never to the
   * citizen's request. */
  attemptTimeoutMs: 90_000,
  /** Lease held while processing; must exceed attemptTimeoutMs plus the
   * DB reads/writes around it, so a live worker never loses its job. */
  leaseMs: 3 * MINUTE,
} as const;

export type AiJobStatus = "pending" | "processing" | "completed" | "failed";

export interface AiJobRow {
  report_id: string;
  status: AiJobStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  locked_until: string | null;
  last_error_kind: string | null;
  last_error_status: number | null;
  last_model: string | null;
  /** 0020 — when the AI-analysis notifications were confirmed sent. */
  notified_at?: string | null;
  /** When this job row was first created — used only for the 7-day
   * notification-retry abandonment check (CP2.2); not selected by every
   * caller, so it's optional here. */
  created_at?: string;
  /** CP2.3 (M-1, migration 0022 — NOT applied yet): consecutive lease-
   * budget shortfalls. Absent on an older/partial select, treated as 0. */
  lease_budget_deferrals?: number;
}

/** Backoff after failed attempt `failedAttempt` (1-based), with jitter.
 * `random` in [0, 1) is injectable for tests. */
export function aiJobRetryDelayMs(failedAttempt: number, random: () => number = Math.random): number {
  return backoffDelayMs(AI_JOB_POLICY.retryDelaysMs, failedAttempt, AI_JOB_POLICY.jitterRatio, random);
}

export type AiJobErrorClass = JobErrorClass;

/** HTTP statuses worth retrying later (capacity / rate limit / server side). */
const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Classifies a failure from analyzeReport() (an AIUnavailableError, see
 * src/lib/ai.ts) — duck-typed so it works on any error shape:
 *   - HTTP 408/429/5xx                  -> retryable  (`http_<status>`)
 *   - any other HTTP status (400/401/403/404/...) -> permanent: invalid
 *     request, auth/permission failure or unknown model — retrying can't
 *     help and only spends quota;
 *   - our own attempt timeout           -> retryable  (`timeout`)
 *   - no HTTP response (fetch failed)   -> retryable  (`network`)
 *   - GEMINI_API_KEY missing            -> permanent  (`not_configured`)
 *   - empty / non-JSON / schema-invalid model output -> retryable
 *     (`invalid_output`): model output varies run to run, and the attempt
 *     cap still bounds it;
 *   - anything else                     -> retryable  (`unknown`), bounded.
 */
export function classifyAiJobError(err: unknown): AiJobErrorClass {
  const e = (err ?? {}) as { status?: unknown; timedOut?: unknown; networkLevel?: unknown; transient?: unknown; message?: unknown };
  if (typeof e.status === "number" && e.status >= 100 && e.status <= 599) {
    return { kind: `http_${e.status}`, status: e.status, retryable: RETRYABLE_HTTP.has(e.status) };
  }
  if (e.timedOut === true) return { kind: "timeout", status: null, retryable: true };
  if (e.networkLevel === true) return { kind: "network", status: null, retryable: true };
  if (typeof e.message === "string" && /GEMINI_API_KEY/.test(e.message)) {
    return { kind: "not_configured", status: null, retryable: false };
  }
  if (e.transient === false) return { kind: "invalid_output", status: null, retryable: true };
  return { kind: "unknown", status: null, retryable: true };
}

export type EnqueueAiJobResult = "queued" | "already_queued" | "failed";

/**
 * Enqueues exactly one AI job for a saved report:
 * INSERT ... ON CONFLICT (report_id) DO NOTHING. A repeat call for the same
 * report (form double-submit replayed past idempotency, a retry, missing-job
 * recovery) is "already_queued", never a second job. Never throws; a DB
 * failure is returned as "failed" (with a sanitized log line) so the caller
 * never claims AI is queued when it isn't.
 */
export async function enqueueAiJob(admin: SupabaseClient, reportId: string): Promise<EnqueueAiJobResult> {
  try {
    const { data, error } = await admin
      .from("ai_analysis_jobs")
      .upsert({ report_id: reportId, status: "pending" }, { onConflict: "report_id", ignoreDuplicates: true })
      .select("report_id");
    if (error) {
      console.error("[ai-jobs] enqueue failed", { reportId, code: error.code ?? "unknown" });
      return "failed";
    }
    return Array.isArray(data) && data.length > 0 ? "queued" : "already_queued";
  } catch (err) {
    console.error("[ai-jobs] enqueue failed", { reportId, code: err instanceof Error ? err.name : "unknown" });
    return "failed";
  }
}

export type ProcessAiJobResult =
  | { outcome: "not_found" }
  /** Not due, already settled, held by another live worker, or another
   * worker won the claim race. Nothing was changed. */
  | { outcome: "not_claimable"; status: AiJobStatus }
  | { outcome: "completed"; via: "analysis" | "already_present" }
  | { outcome: "retry_scheduled"; attempts: number; nextAttemptAt: string; kind: string }
  | { outcome: "failed"; attempts: number; kind: string }
  /** Analysis saved, notifications not yet deliverable, no attempt left:
   * parked so the worker's sweep retries notifications only (no Gemini). */
  | { outcome: "notify_pending"; attempts: number }
  /** This worker's lease expired and another worker re-claimed the job
   * before it could settle; the newer claim owns the job. */
  | { outcome: "lost_lease" };

export interface ProcessAiJobDeps {
  now?: () => number;
  random?: () => number;
  /** The single Gemini request — injectable so tests never call Gemini.
   * `timeoutMs` is the bound this request must respect (see geminiTimeoutMs). */
  analyze?: (input: Parameters<typeof analyzeReport>[0], opts: { timeoutMs: number }) => Promise<AnalysisResult>;
  /** CP2.2 (M2-A): an already-computed Gemini request budget in ms, derived
   * by the worker from the DATABASE-returned remaining global-lease
   * duration (renew_ai_worker_lease's return value) minus the safety
   * margin — never from a wall-clock epoch subtraction, so app/DB clock
   * skew can't under- or over-estimate it. Undefined (manual/inline use,
   * e.g. processAiJob called directly) means "no external bound": the
   * full policy cap applies. */
  geminiTimeoutMs?: number;
}

/** Below this, a Gemini request is not started at all (it could not
 * realistically finish inside the remaining lease). */
export const MIN_GEMINI_ATTEMPT_MS = 15_000;

/**
 * Clamps a caller-supplied Gemini request budget to the policy cap.
 * `explicitTimeoutMs` is a plain DURATION (ms) the caller already derived
 * from a database-returned remaining-lease value — this function does no
 * clock arithmetic of its own, by design (CP2.2 M2-A).
 */
export function clampGeminiTimeoutMs(explicitTimeoutMs: number | undefined, capMs: number): number {
  if (explicitTimeoutMs === undefined) return capMs;
  return Math.max(0, Math.min(capMs, explicitTimeoutMs));
}

const JOB_COLUMNS =
  "report_id, status, attempts, max_attempts, next_attempt_at, locked_until, last_error_kind, last_error_status, last_model, notified_at, created_at, lease_budget_deferrals";

function isClaimable(job: AiJobRow, nowMs: number): boolean {
  if (job.status === "pending") return Date.parse(job.next_attempt_at) <= nowMs && job.attempts < job.max_attempts;
  if (job.status === "processing") {
    return job.locked_until !== null && Date.parse(job.locked_until) < nowMs && job.attempts < job.max_attempts;
  }
  return false;
}

function settle(admin: SupabaseClient, reportId: string, claimedAttempts: number, patch: Partial<AiJobRow>) {
  return settleJob(admin, "ai_analysis_jobs", reportId, claimedAttempts, patch);
}

/** Best-effort: the report's first evidence photo, so a worker analysis
 * sees the same input the inline analysis did. Any failure means a
 * text-only analysis, never a failed job. */
async function loadEvidenceImage(admin: SupabaseClient, reportId: string): Promise<{ imageBase64: string; imageMimeType: string } | null> {
  try {
    const { data: media } = await admin
      .from("report_media")
      .select("file_path, mime_type")
      .eq("report_id", reportId)
      .eq("kind", "evidence")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!media?.file_path || !media.mime_type || !admin.storage) return null;
    const { data: blob, error } = await admin.storage.from("report-media").download(media.file_path as string);
    if (error || !blob) return null;
    return { imageBase64: Buffer.from(await blob.arrayBuffer()).toString("base64"), imageMimeType: media.mime_type as string };
  } catch {
    console.warn("[ai-jobs] evidence image unavailable; analyzing text only", { reportId });
    return null;
  }
}

/** How long a job whose analysis exists but whose notifications could not
 * be delivered is parked before the worker's sweep retries them (no Gemini). */
export const NOTIFY_RETRY_MS = 5 * MINUTE;

/** CP2.2 optional hardening: a job whose analysis exists but whose
 * notifications keep failing is retried for at most this long (measured
 * from the job row's own created_at) before being abandoned — a
 * persistently broken recipient (e.g. a constraint violation on every
 * insert) must not loop forever. The analysis itself is never discarded;
 * only notification delivery is given up on, visibly (`notify_abandoned`),
 * never silently. */
export const NOTIFY_MAX_AGE_MS = 7 * 24 * 60 * MINUTE;

/** True once `job` has been retrying notification delivery for longer than
 * NOTIFY_MAX_AGE_MS. Requires created_at (selected by JOB_COLUMNS); a job
 * row without it (an older/partial select) is never treated as abandoned. */
function notifyRetryExpired(job: AiJobRow, nowMs: number): boolean {
  return job.created_at !== undefined && nowMs - Date.parse(job.created_at) > NOTIFY_MAX_AGE_MS;
}

/**
 * Parks a job whose analysis IS saved but whose notifications could not be
 * delivered and which has no attempt left: it stays `processing` with
 * attempts = max_attempts (so it can never be claimed for Gemini again) and
 * a short lease; once that lease expires the worker's exhausted-job sweep
 * (settleExhaustedAiJob) retries ONLY the notifications. Past
 * NOTIFY_MAX_AGE_MS it is instead marked `failed` / `notify_abandoned` —
 * the analysis row itself is untouched and still fully readable.
 */
async function parkForNotificationRetry(admin: SupabaseClient, job: AiJobRow, nowMs: number): Promise<ProcessAiJobResult> {
  if (notifyRetryExpired(job, nowMs)) {
    console.error("[ai-jobs] notification retry abandoned after max age; analysis is saved but notifications were not delivered", {
      reportId: job.report_id,
      maxAgeMs: NOTIFY_MAX_AGE_MS,
    });
    const ok = await settle(admin, job.report_id, job.attempts, {
      status: "failed",
      locked_until: null,
      last_error_kind: "notify_abandoned",
      last_error_status: null,
      lease_budget_deferrals: 0,
    });
    return ok ? { outcome: "failed", attempts: job.attempts, kind: "notify_abandoned" } : { outcome: "lost_lease" };
  }
  const ok = await settle(admin, job.report_id, job.attempts, {
    status: "processing",
    locked_until: new Date(nowMs + NOTIFY_RETRY_MS).toISOString(),
    last_error_kind: "notify_failed",
    last_error_status: null,
    lease_budget_deferrals: 0,
  });
  return ok ? { outcome: "notify_pending", attempts: job.attempts } : { outcome: "lost_lease" };
}

/**
 * Final-attempt handling (M4). For a `processing` job with an expired lease
 * and no attempt left (a crashed final attempt, or a job parked by
 * parkForNotificationRetry):
 *   - analysis exists -> deliver/verify notifications (no Gemini call) and
 *     mark it completed with notified_at; if delivery still fails, park it
 *     again for a later retry;
 *   - no analysis     -> failed / lease_expired (correct terminal state).
 * The job is first re-leased with a compare-and-set on its exact
 * (attempts, locked_until), so two concurrent sweeps can't both send.
 * Returns null when `job` is not in that state.
 */
export async function settleExhaustedAiJob(admin: SupabaseClient, job: AiJobRow, nowMs: number): Promise<ProcessAiJobResult | null> {
  if (job.status !== "processing" || !job.locked_until || Date.parse(job.locked_until) >= nowMs || job.attempts < job.max_attempts) {
    return null;
  }

  const lockedUntil = new Date(nowMs + NOTIFY_RETRY_MS).toISOString();
  const { data: taken, error: takeError } = await admin
    .from("ai_analysis_jobs")
    .update({ locked_until: lockedUntil })
    .eq("report_id", job.report_id)
    .eq("status", "processing")
    .eq("attempts", job.attempts)
    .eq("locked_until", job.locked_until)
    .select("report_id");
  if (takeError || !Array.isArray(taken) || taken.length === 0) return { outcome: "lost_lease" };
  const held: AiJobRow = { ...job, locked_until: lockedUntil };

  const { data: existing } = await admin.from("ai_analyses").select("report_id").eq("report_id", job.report_id).maybeSingle();
  if (!existing) {
    const ok = await settle(admin, job.report_id, job.attempts, {
      status: "failed",
      locked_until: null,
      last_error_kind: "lease_expired",
      last_error_status: null,
      lease_budget_deferrals: 0,
    });
    return ok ? { outcome: "failed", attempts: job.attempts, kind: "lease_expired" } : { outcome: "lost_lease" };
  }

  let notifiedAt = job.notified_at ?? null;
  if (!notifiedAt) {
    try {
      await ensureAiAnalysisNotifications(admin, job.report_id);
      notifiedAt = new Date(nowMs).toISOString();
    } catch (err) {
      console.error("[ai-jobs] final-attempt notification retry failed; parked again", {
        reportId: job.report_id,
        code: err instanceof Error ? err.name : "unknown",
      });
      return parkForNotificationRetry(admin, held, nowMs);
    }
  }
  const ok = await settle(admin, job.report_id, job.attempts, {
    status: "completed",
    locked_until: null,
    last_error_kind: null,
    last_error_status: null,
    notified_at: notifiedAt,
    lease_budget_deferrals: 0,
  });
  return ok ? { outcome: "completed", via: "already_present" } : { outcome: "lost_lease" };
}

/**
 * Per-report entry point: read, compare-and-set claim, then run. Safe to
 * call concurrently and repeatedly — only the caller that wins the claim
 * does any work. Two workers that read the same row both try
 * `... where status = X and attempts = N`; Postgres re-checks the WHERE
 * after the first commits, so exactly one update matches.
 */
export async function processAiJob(
  admin: SupabaseClient,
  reportId: string,
  deps: ProcessAiJobDeps = {}
): Promise<ProcessAiJobResult> {
  const now = deps.now ?? Date.now;

  const { data: jobRow, error: readError } = await admin
    .from("ai_analysis_jobs")
    .select(JOB_COLUMNS)
    .eq("report_id", reportId)
    .maybeSingle();
  if (readError) {
    console.error("[ai-jobs] read failed", { reportId, code: readError.code ?? "unknown" });
    return { outcome: "not_claimable", status: "pending" };
  }
  if (!jobRow) return { outcome: "not_found" };
  const job = jobRow as AiJobRow;

  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();
  if (!isClaimable(job, nowMs)) {
    const exhausted = await settleExhaustedAiJob(admin, job, nowMs);
    if (exhausted && exhausted.outcome !== "lost_lease") return exhausted;
    return { outcome: "not_claimable", status: job.status };
  }

  const model = resolveGeminiModel();
  const attempt = job.attempts + 1;
  const lockedUntil = new Date(nowMs + AI_JOB_POLICY.leaseMs).toISOString();
  let claim = admin
    .from("ai_analysis_jobs")
    .update({ status: "processing", attempts: attempt, locked_until: lockedUntil, last_model: model })
    .eq("report_id", reportId)
    .eq("status", job.status)
    .eq("attempts", job.attempts);
  claim = job.status === "pending" ? claim.lte("next_attempt_at", nowIso) : claim.lt("locked_until", nowIso);
  const { data: claimed, error: claimError } = await claim.select("report_id");
  if (claimError || !Array.isArray(claimed) || claimed.length === 0) {
    if (claimError) console.error("[ai-jobs] claim failed", { reportId, code: claimError.code ?? "unknown" });
    return { outcome: "not_claimable", status: job.status };
  }

  return runClaimedAiJob(
    admin,
    { ...job, status: "processing", attempts: attempt, locked_until: lockedUntil, last_model: model },
    deps
  );
}

/**
 * Runs ONE job that the caller has already claimed (status=processing,
 * attempts already incremented for this claim). Makes at most one Gemini
 * request. Never calls routeReport, never writes report_assignments, never
 * changes reports.status or reports.reporter_id. On success it writes only
 * the ai_analyses row and the report's severity/priority (persistAnalysis),
 * exactly as the inline analysis did, plus notifications.
 */
export async function runClaimedAiJob(
  admin: SupabaseClient,
  job: AiJobRow,
  deps: ProcessAiJobDeps = {}
): Promise<ProcessAiJobResult> {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  // M2: both an abort signal AND the SDK's own HTTP timeout bound the request.
  const analyze =
    deps.analyze ??
    ((input, { timeoutMs }) => analyzeReport(input, { signal: AbortSignal.timeout(timeoutMs), timeoutMs }));
  const reportId = job.report_id;
  const attempt = job.attempts;
  const model = job.last_model ?? resolveGeminiModel();

  const failure = async (error: AiJobErrorClass): Promise<ProcessAiJobResult> => {
    const exhausted = attempt >= job.max_attempts;
    if (error.retryable && !exhausted) {
      const nextAttemptAt = new Date(now() + aiJobRetryDelayMs(attempt, random)).toISOString();
      const ok = await settle(admin, reportId, attempt, {
        status: "pending",
        locked_until: null,
        next_attempt_at: nextAttemptAt,
        last_error_kind: error.kind,
        last_error_status: error.status,
        lease_budget_deferrals: 0,
      });
      return ok ? { outcome: "retry_scheduled", attempts: attempt, nextAttemptAt, kind: error.kind } : { outcome: "lost_lease" };
    }
    const ok = await settle(admin, reportId, attempt, {
      status: "failed",
      locked_until: null,
      last_error_kind: error.kind,
      last_error_status: error.status,
      lease_budget_deferrals: 0,
    });
    return ok ? { outcome: "failed", attempts: attempt, kind: error.kind } : { outcome: "lost_lease" };
  };

  /** Completes the job once the analysis exists. Notifications are ensured
   * (verified check-then-send) unless this job already recorded them; a
   * delivery failure is retried later WITHOUT another Gemini call: with
   * attempts left, the next claim finds the analysis and only re-checks
   * notifications; on the final attempt the job is parked for the worker's
   * notification-only sweep (M4) instead of being marked failed. */
  const completed = async (via: "analysis" | "already_present"): Promise<ProcessAiJobResult> => {
    let notifiedAt = job.notified_at ?? null;
    if (!notifiedAt) {
      try {
        await ensureAiAnalysisNotifications(admin, reportId);
        notifiedAt = new Date(now()).toISOString();
      } catch (err) {
        console.error("[ai-jobs] notification delivery failed; will retry without Gemini", {
          reportId,
          code: err instanceof Error ? err.name : "unknown",
        });
        if (attempt >= job.max_attempts) return parkForNotificationRetry(admin, job, now());
        return failure({ kind: "notify_failed", status: null, retryable: true });
      }
    }
    const ok = await settle(admin, reportId, attempt, {
      status: "completed",
      locked_until: null,
      last_error_kind: null,
      last_error_status: null,
      notified_at: notifiedAt,
      lease_budget_deferrals: 0,
    });
    return ok ? { outcome: "completed", via } : { outcome: "lost_lease" };
  };

  // 1. Already analyzed (e.g. by the owner's manual retry, or this job's own
  //    earlier claim that crashed before settling)? No Gemini request.
  const { data: existing } = await admin.from("ai_analyses").select("report_id").eq("report_id", reportId).maybeSingle();
  if (existing) return completed("already_present");

  // 2. Inputs — read only. Departments are read directly (not through the
  //    routing module): this worker has no routing dependency at all.
  const [{ data: report }, { data: location }, { data: departments }] = await Promise.all([
    admin.from("reports").select("id, reporter_id, title, description, category").eq("id", reportId).maybeSingle(),
    admin
      .from("report_locations")
      .select("display_name, state, district, constituency, area, landmark, latitude, longitude, location_source")
      .eq("report_id", reportId)
      .maybeSingle(),
    admin.from("departments").select("name"),
  ]);
  const category = report ? categoryFromDb[report.category as string] : undefined;
  if (!report || !location || !category) {
    return failure({ kind: !report ? "report_missing" : !location ? "location_missing" : "category_invalid", status: null, retryable: false });
  }

  const civicLocation: CivicLocation = {
    displayName: location.display_name,
    state: location.state,
    district: location.district,
    constituency: location.constituency,
    area: location.area,
    landmark: location.landmark,
    latitude: location.latitude,
    longitude: location.longitude,
    source: location.location_source,
  };
  const image = await loadEvidenceImage(admin, reportId);

  // 3. Exactly one Gemini request for this claim, bounded by the policy cap
  //    AND the worker-supplied budget (derived from the database-returned
  //    remaining global-lease duration minus a safety margin — never from
  //    wall-clock subtraction here).
  const startedAt = now();
  const timeoutMs = clampGeminiTimeoutMs(deps.geminiTimeoutMs, AI_JOB_POLICY.attemptTimeoutMs);
  if (timeoutMs < MIN_GEMINI_ATTEMPT_MS) {
    // CP2.3 (M-1): not enough lease left to make a request that could
    // finish safely — no Gemini call, so this must NOT consume the claimed
    // attempt. deferForLeaseBudget gives it back and tracks a separate,
    // bounded deferral counter instead (never permanently fails a job on
    // a worker-scheduling shortfall alone).
    return deferForLeaseBudget(admin, "ai_analysis_jobs", reportId, attempt, job.lease_budget_deferrals ?? 0, now());
  }
  let analysis: AnalysisResult;
  try {
    analysis = await analyze(
      {
        description: report.description as string,
        category,
        location: civicLocation,
        ...(image ?? {}),
        departmentNames: ((departments ?? []) as Array<{ name: string }>).map((d) => d.name),
      },
      { timeoutMs }
    );
  } catch (err) {
    const error = classifyAiJobError(err);
    console.warn(
      `[ai-jobs] gemini attempt failed report=${reportId} attempt=${attempt}/${job.max_attempts} model=${model} kind=${error.kind}${
        error.status !== null ? ` status=${error.status}` : ""
      } retryable=${error.retryable} durationMs=${now() - startedAt}`
    );
    return failure(error);
  }

  // 4. Persist (UNIQUE(report_id) backstop), then ensure notifications.
  const persisted = await persistAnalysis(admin, reportId, analysis);
  if (persisted === "failed") return failure({ kind: "persist_failed", status: null, retryable: true });
  return completed(persisted === "persisted" ? "analysis" : "already_present");
}
