-- CivicFix — AI analysis job queue (Gemini Phase 1)
--
-- Additive only: one new table, its indexes, an updated_at trigger reusing
-- the existing public.set_updated_at() (0001), and access revocation. No
-- existing table, column, policy, function or row is touched, and nothing
-- is backfilled — enqueuing pre-existing reports is a separate, reviewed
-- recovery step.
--
-- Why: Gemini analysis used to run inside the citizen's report submission
-- with a 25s attempt timeout, while Google's capacity errors (503 "high
-- demand") currently arrive after ~60s — so every analysis timed out and
-- nothing recorded that it was owed. Report creation now inserts ONE row
-- here (status 'pending') and returns; a server-side worker
-- (src/lib/ai-jobs.ts processAiJob) claims, runs and settles it.
--
-- Lifecycle (enforced by the worker's compare-and-set updates):
--   pending    -> processing   claim: attempts + 1, lease until locked_until
--   processing -> completed    analysis persisted (or already present)
--   processing -> pending      transient failure: next_attempt_at = backoff
--   processing -> failed       permanent failure, or attempts = max_attempts
--   processing (lease expired) -> processing   crash recovery by a new claim
--
-- One job per report: report_id is the PRIMARY KEY, so enqueue is
-- INSERT ... ON CONFLICT DO NOTHING and can never create a second job.
-- ai_analyses.report_id UNIQUE (0001) stays the backstop against a second
-- analysis row.
--
-- Only sanitized metadata is stored: an error category, an HTTP status
-- code, and the model id. Never prompts, report content, API keys, request
-- headers or raw provider payloads.

create table if not exists public.ai_analysis_jobs (
  report_id uuid primary key references public.reports (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),
  attempts integer not null default 0,
  max_attempts integer not null default 6,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error_kind text,
  last_error_status integer,
  last_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ai_analysis_jobs_attempts_range
    check (attempts >= 0 and attempts <= max_attempts),
  constraint ai_analysis_jobs_max_attempts_range
    check (max_attempts between 1 and 20),
  -- A processing job always carries a lease, so a crashed worker's job can
  -- be recovered once the lease expires instead of being stuck forever.
  constraint ai_analysis_jobs_processing_has_lease
    check (status <> 'processing' or locked_until is not null),
  constraint ai_analysis_jobs_error_kind_shape
    check (last_error_kind is null or last_error_kind ~ '^[a-z0-9_]{1,40}$'),
  constraint ai_analysis_jobs_error_status_range
    check (last_error_status is null or last_error_status between 100 and 599),
  constraint ai_analysis_jobs_model_shape
    check (last_model is null or char_length(last_model) <= 80)
);

comment on table public.ai_analysis_jobs is
  'One Gemini analysis job per report (PK report_id). Service-role only. '
  'Holds lifecycle + sanitized error metadata, never report content or secrets.';
comment on column public.ai_analysis_jobs.locked_until is
  'Lease of the worker currently processing this job; an expired lease makes the job claimable again.';
comment on column public.ai_analysis_jobs.last_error_kind is
  'Sanitized error category (e.g. http_503, timeout, network, http_4xx, invalid_output) — never a raw message.';

-- Due pending jobs, oldest first (the worker's pick-up query in Phase 2).
create index if not exists ai_analysis_jobs_due_idx
  on public.ai_analysis_jobs (next_attempt_at)
  where status = 'pending';

-- Processing jobs whose lease may have expired (crash recovery).
create index if not exists ai_analysis_jobs_lease_idx
  on public.ai_analysis_jobs (locked_until)
  where status = 'processing';

drop trigger if exists set_updated_at on public.ai_analysis_jobs;
create trigger set_updated_at before update on public.ai_analysis_jobs
  for each row execute function public.set_updated_at();

-- ============================================================
-- Access — same pattern as idempotency_keys (0006) / rate_limit_buckets
-- (0005): RLS on with NO policies, and no table privileges for anon or
-- authenticated. Only server code using the service-role client (which
-- bypasses RLS) can read or write job rows.
-- ============================================================

alter table public.ai_analysis_jobs enable row level security;
revoke all on public.ai_analysis_jobs from anon, authenticated;
