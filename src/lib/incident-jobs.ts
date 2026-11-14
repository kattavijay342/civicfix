import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  confirmSameIncident,
  INCIDENT_CONFIRM_MODEL,
  type IncidentConfirmation,
} from "@/lib/incident-ai-confirm";
import { AI_CONFIRMATION_MIN_CONFIDENCE, INCIDENT_WINDOW_DAYS, type IncidentMatch } from "@/lib/incident-detection";
import { applyIncidentMatch, type ApplyIncidentMatchResult, type EvaluateIncidentInput } from "@/lib/incident-linking";
import { backoffDelayMs, deferForLeaseBudget, settleJob, type JobErrorClass } from "@/lib/job-queue";
import { clampGeminiTimeoutMs, MIN_GEMINI_ATTEMPT_MS } from "@/lib/ai-jobs";
import { categoryFromDb } from "@/lib/db-enums";
import { haversineMeters } from "@/lib/geo";
import type { CivicLocation } from "@/lib/types";

/**
 * AI-2 deferred incident confirmation — table `incident_confirmation_jobs`
 * (supabase/migrations/0020_ai_worker.sql).
 *
 * Report submission never calls Gemini for incident matching any more
 * (evaluateIncidentForReport runs findIncidentMatch in "defer" mode): an
 * ambiguous match is recorded exactly as the "Gemini unavailable" outcome
 * ('candidate') and ONE job is queued for its single best candidate. The
 * background worker (src/lib/ai-worker.ts) claims it and calls
 * runClaimedIncidentJob, which:
 *   1. re-checks both reports still exist and the pair is still eligible
 *      (same category, candidate not resolved, candidate within the 30-day
 *      window) — the same rules findIncidentMatch applies;
 *   2. makes ONE confirmSameIncident request with the UNCHANGED model
 *      (gemini-3.6-flash) and a worker-controlled 90s timeout/abort;
 *   3. confirmed (same_incident with confidence >= 0.6) -> applyIncidentMatch
 *      with the exact 'supporting' / 'ai_confirmed' match the inline path
 *      produced: guarded candidate->supporting upgrade, or join/found the
 *      incident, recompute, notify once;
 *   4. not confirmed -> completed, nothing invented (the candidate stays).
 * Retries: 429/5xx, timeout, network (and unknown) back off 1 -> 5 -> 15 min,
 * max 3 attempts; 400/401/403/404 (and any other 4xx), invalid model output
 * and a missing API key fail permanently. Never routes, never touches
 * reports.status, reporter_id or report_assignments.
 */

const MINUTE = 60_000;

export const INCIDENT_JOB_POLICY = {
  retryDelaysMs: [1 * MINUTE, 5 * MINUTE, 15 * MINUTE],
  jitterRatio: 0.2,
  attemptTimeoutMs: 90_000,
  leaseMs: 3 * MINUTE,
  maxAttempts: 3,
} as const;

export interface IncidentJobRow {
  report_id: string;
  candidate_report_id: string;
  match_score: number | string;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  locked_until: string | null;
  last_error_kind: string | null;
  last_error_status: number | null;
  last_model: string | null;
  /** CP2.3 (M-1, migration 0022 — NOT applied yet): consecutive lease-
   * budget shortfalls. Absent on an older/partial select, treated as 0. */
  lease_budget_deferrals?: number;
}

export type IncidentJobResult =
  | { outcome: "confirmed"; applied: ApplyIncidentMatchResult }
  | { outcome: "not_confirmed" }
  | { outcome: "not_eligible"; reason: string }
  | { outcome: "already_linked" }
  | { outcome: "retry_scheduled"; attempts: number; nextAttemptAt: string; kind: string }
  | { outcome: "failed"; attempts: number; kind: string }
  | { outcome: "lost_lease" };

export interface IncidentJobDeps {
  now?: () => number;
  random?: () => number;
  /** The single Gemini request — injectable so tests never call Gemini.
   * `timeoutMs` is the bound this request must respect. */
  confirm?: (input: Parameters<typeof confirmSameIncident>[0], opts: { timeoutMs: number }) => Promise<IncidentConfirmation>;
  /** CP2.2 (M2-A): an already-computed Gemini request budget in ms, derived
   * by the worker from the DATABASE-returned remaining global-lease
   * duration minus the safety margin (see clampGeminiTimeoutMs in
   * ai-jobs.ts). Undefined means "no external bound" — the policy cap applies. */
  geminiTimeoutMs?: number;
}

export function incidentJobRetryDelayMs(failedAttempt: number, random: () => number = Math.random): number {
  return backoffDelayMs(INCIDENT_JOB_POLICY.retryDelaysMs, failedAttempt, INCIDENT_JOB_POLICY.jitterRatio, random);
}

/**
 * Sanitized classification of a confirmSameIncident failure
 * (IncidentAIUnavailableError.kind/status, duck-typed).
 */
export function classifyIncidentJobError(err: unknown): JobErrorClass {
  const e = (err ?? {}) as { kind?: unknown; status?: unknown };
  if (typeof e.status === "number" && e.status >= 100 && e.status <= 599) {
    const retryable = e.status === 429 || e.status >= 500;
    return { kind: `http_${e.status}`, status: e.status, retryable };
  }
  switch (e.kind) {
    case "timeout":
      return { kind: "timeout", status: null, retryable: true };
    case "network":
      return { kind: "network", status: null, retryable: true };
    case "invalid_output":
      return { kind: "invalid_output", status: null, retryable: false };
    case "not_configured":
      return { kind: "not_configured", status: null, retryable: false };
    default:
      return { kind: "unknown", status: null, retryable: true };
  }
}

const REPORT_COLUMNS = "id, category, status, created_at, description, severity";
const LOCATION_COLUMNS = "report_id, display_name, state, district, constituency, area, landmark, latitude, longitude, location_source";

function toCivicLocation(l: Record<string, unknown>): CivicLocation {
  return {
    displayName: l.display_name as string,
    state: (l.state as string | null) ?? undefined,
    district: (l.district as string | null) ?? undefined,
    constituency: (l.constituency as string | null) ?? undefined,
    area: (l.area as string | null) ?? undefined,
    landmark: (l.landmark as string | null) ?? undefined,
    latitude: (l.latitude as number | null) ?? null,
    longitude: (l.longitude as number | null) ?? null,
    source: (l.location_source as CivicLocation["source"]) ?? "manual",
  };
}

/**
 * Runs ONE incident confirmation job the caller already claimed
 * (status=processing, attempts incremented). At most one Gemini request.
 */
export async function runClaimedIncidentJob(
  admin: SupabaseClient,
  job: IncidentJobRow,
  deps: IncidentJobDeps = {}
): Promise<IncidentJobResult> {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const confirm =
    deps.confirm ??
    ((input, { timeoutMs }) => confirmSameIncident(input, { signal: AbortSignal.timeout(timeoutMs), timeoutMs }));
  const reportId = job.report_id;
  const attempt = job.attempts;
  const settle = (patch: Record<string, unknown>) => settleJob(admin, "incident_confirmation_jobs", reportId, attempt, patch);

  const complete = async (result: IncidentJobResult, kind: string | null): Promise<IncidentJobResult> => {
    const ok = await settle({ status: "completed", locked_until: null, last_error_kind: kind, last_error_status: null, lease_budget_deferrals: 0 });
    return ok ? result : { outcome: "lost_lease" };
  };

  const failure = async (error: JobErrorClass): Promise<IncidentJobResult> => {
    const exhausted = attempt >= job.max_attempts;
    if (error.retryable && !exhausted) {
      const nextAttemptAt = new Date(now() + incidentJobRetryDelayMs(attempt, random)).toISOString();
      const ok = await settle({
        status: "pending",
        locked_until: null,
        next_attempt_at: nextAttemptAt,
        last_error_kind: error.kind,
        last_error_status: error.status,
        lease_budget_deferrals: 0,
      });
      return ok ? { outcome: "retry_scheduled", attempts: attempt, nextAttemptAt, kind: error.kind } : { outcome: "lost_lease" };
    }
    const ok = await settle({
      status: "failed",
      locked_until: null,
      last_error_kind: error.kind,
      last_error_status: error.status,
      lease_budget_deferrals: 0,
    });
    return ok ? { outcome: "failed", attempts: attempt, kind: error.kind } : { outcome: "lost_lease" };
  };

  // 1. Both reports and locations — read only.
  const [{ data: reports }, { data: locations }] = await Promise.all([
    admin.from("reports").select(REPORT_COLUMNS).in("id", [reportId, job.candidate_report_id]),
    admin.from("report_locations").select(LOCATION_COLUMNS).in("report_id", [reportId, job.candidate_report_id]),
  ]);
  const report = (reports ?? []).find((r) => r.id === reportId);
  const candidate = (reports ?? []).find((r) => r.id === job.candidate_report_id);
  const reportLoc = (locations ?? []).find((l) => l.report_id === reportId);
  const candidateLoc = (locations ?? []).find((l) => l.report_id === job.candidate_report_id);
  if (!report || !candidate || !reportLoc || !candidateLoc) {
    return failure({ kind: "report_missing", status: null, retryable: false });
  }

  // 2. Same eligibility rules findIncidentMatch applied when it queued this.
  const windowStart = now() - INCIDENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const category = categoryFromDb[report.category as string];
  let ineligible: string | null = null;
  if (report.category !== candidate.category || !category) ineligible = "category_mismatch";
  else if (candidate.status === "resolved") ineligible = "candidate_resolved";
  else if (Date.parse(candidate.created_at as string) < windowStart) ineligible = "candidate_outside_window";
  if (ineligible) return complete({ outcome: "not_eligible", reason: ineligible }, "not_eligible");

  // 3. Already a non-candidate member of an incident (e.g. a crashed earlier
  //    run applied it) — nothing to confirm, no Gemini request.
  const { data: membership } = await admin
    .from("incident_reports")
    .select("incident_id")
    .eq("report_id", reportId)
    .neq("relationship_type", "candidate")
    .limit(1)
    .maybeSingle();
  if (membership?.incident_id) return complete({ outcome: "already_linked" }, null);

  // 4. Exactly one Gemini request (unchanged model).
  const location = toCivicLocation(reportLoc);
  const candidateLocation = toCivicLocation(candidateLoc);
  const daysApart = Math.abs(
    Math.floor((Date.parse(report.created_at as string) - Date.parse(candidate.created_at as string)) / (24 * 60 * 60 * 1000))
  );
  const distanceMeters =
    location.latitude != null && location.longitude != null && candidateLocation.latitude != null && candidateLocation.longitude != null
      ? haversineMeters(location.latitude, location.longitude, candidateLocation.latitude, candidateLocation.longitude)
      : null;

  const timeoutMs = clampGeminiTimeoutMs(deps.geminiTimeoutMs, INCIDENT_JOB_POLICY.attemptTimeoutMs);
  if (timeoutMs < MIN_GEMINI_ATTEMPT_MS) {
    // CP2.3 (M-1): not enough worker-lease time left for a request that
    // could finish — no Gemini call, so give the claimed attempt back
    // instead of letting it count toward max_attempts (see job-queue.ts).
    return deferForLeaseBudget(admin, "incident_confirmation_jobs", reportId, attempt, job.lease_budget_deferrals ?? 0, now());
  }

  let confirmation: IncidentConfirmation;
  try {
    confirmation = await confirm(
      {
        reportA: { category: report.category as string, description: report.description as string, areaLabel: location.displayName },
        reportB: { category: candidate.category as string, description: candidate.description as string, areaLabel: candidateLocation.displayName },
        distanceMeters,
        daysApart,
      },
      { timeoutMs }
    );
  } catch (err) {
    const error = classifyIncidentJobError(err);
    console.warn(
      `[incident-jobs] gemini attempt failed report=${reportId} attempt=${attempt}/${job.max_attempts} model=${INCIDENT_CONFIRM_MODEL} kind=${error.kind}${
        error.status !== null ? ` status=${error.status}` : ""
      } retryable=${error.retryable}`
    );
    return failure(error);
  }

  if (!(confirmation.same_incident && confirmation.confidence >= AI_CONFIRMATION_MIN_CONFIDENCE)) {
    return complete({ outcome: "not_confirmed" }, null);
  }

  // 5. Apply exactly the match the inline path would have produced.
  const [{ data: analysis }, { data: assignment }] = await Promise.all([
    admin.from("ai_analyses").select("extended").eq("report_id", reportId).maybeSingle(),
    admin.from("report_assignments").select("department_id").eq("report_id", reportId).maybeSingle(),
  ]);
  const input: EvaluateIncidentInput = {
    reportId,
    category,
    subcategory: ((analysis?.extended as Record<string, unknown> | null)?.subcategory as string | undefined) ?? null,
    description: report.description as string,
    location,
    createdAt: report.created_at as string,
    severity: (report.severity as string | null) ?? null,
    departmentId: (assignment?.department_id as string | undefined) ?? null,
  };
  const match: IncidentMatch = {
    reportId: job.candidate_report_id,
    score: Number(job.match_score),
    relationshipType: "supporting",
    detectionMethod: "ai_confirmed",
    reason: "AI-confirmed (background)",
  };
  const applied = await applyIncidentMatch(admin, input, match);
  return complete({ outcome: "confirmed", applied }, null);
}
