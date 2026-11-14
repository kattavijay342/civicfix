-- CivicFix — AI-2 lease-budget deferral tracking (CP2.3 M-1: file only, NOT applied anywhere)
--
-- Additive only. Adds ONE column to each of the two existing job tables
-- (0019's ai_analysis_jobs, 0020's incident_confirmation_jobs). Does NOT
-- modify 0019, 0020 or 0021.
--
-- Why: claim_due_ai_jobs()/claim_due_incident_jobs() (0020) increment
-- `attempts` at claim time, before the worker ever decides whether there is
-- enough remaining lease budget to safely start a Gemini request
-- (src/lib/ai-jobs.ts, src/lib/incident-jobs.ts). Previously, a claim that
-- hit this "lease_budget" shortfall on a job's FINAL attempt would
-- permanently fail it without Gemini ever having been called — consuming
-- a genuine attempt for a worker-scheduling reason, not a real failure.
--
-- Fix (app-side, read by src/lib/ai-jobs.ts and src/lib/incident-jobs.ts):
-- on a lease-budget shortfall, the app GIVES BACK the attempt it was just
-- charged (attempts = claimed_attempts - 1) — so `attempts` only ever
-- reflects genuine Gemini tries — and instead increments this new counter.
-- Once lease_budget_deferrals exceeds the app's own bounded cap
-- (MAX_LEASE_BUDGET_DEFERRALS, src/lib/job-queue.ts), the job is marked
-- `failed` / `lease_budget_exhausted` instead of deferring forever, so a
-- persistently misconfigured worker (e.g. too-short lease relative to its
-- safety margin) cannot defer the same job indefinitely. The counter is
-- reset to 0 whenever the job reaches any other outcome (a real Gemini
-- attempt, successful completion, or notification-only parking).
--
-- The CHECK bound here (50) is deliberately looser than the app's own cap
-- (20) — it is a database-side sanity backstop, not the authoritative
-- limit, so the app's policy constant can change without a migration.

alter table public.ai_analysis_jobs
  add column if not exists lease_budget_deferrals integer not null default 0;

alter table public.ai_analysis_jobs
  add constraint ai_analysis_jobs_lease_budget_deferrals_range
    check (lease_budget_deferrals >= 0 and lease_budget_deferrals <= 50);

comment on column public.ai_analysis_jobs.lease_budget_deferrals is
  'CP2.3: consecutive times this job was deferred (attempts given back) because the worker''s remaining lease budget was too short to safely start a Gemini request. Reset to 0 on any other outcome. Bounded app-side by MAX_LEASE_BUDGET_DEFERRALS.';

alter table public.incident_confirmation_jobs
  add column if not exists lease_budget_deferrals integer not null default 0;

alter table public.incident_confirmation_jobs
  add constraint incident_confirmation_jobs_lease_budget_deferrals_range
    check (lease_budget_deferrals >= 0 and lease_budget_deferrals <= 50);

comment on column public.incident_confirmation_jobs.lease_budget_deferrals is
  'CP2.3: same semantics as ai_analysis_jobs.lease_budget_deferrals, for incident confirmation jobs.';

-- No RLS/grant changes needed: both tables already have RLS enabled with
-- no policies and no anon/authenticated privileges (0019/0020); a new
-- column on an already-locked-down table inherits the same access model.
