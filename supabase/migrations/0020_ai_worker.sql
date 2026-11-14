-- CivicFix — AI-2 background worker (CP2: file only, NOT applied anywhere)
--
-- Additive only. Depends on 0019_ai_analysis_jobs.sql (applied together, in
-- order). Creates:
--   1. ai_analysis_jobs.notified_at        (new column on 0019's own table)
--   2. incident_confirmation_jobs          (deferred Gemini incident checks)
--   3. ai_worker_lease                     (one global worker at a time)
--   4. claim_due_ai_jobs(...)              (batch claim, SKIP LOCKED, DB clock)
--   5. claim_due_incident_jobs(...)        (same, for incident jobs)
--   6. find_reports_missing_ai_job(...)    (recent reports with no AI job)
--   7. acquire_ai_worker_lease(...)        (atomic, DB clock, takeover on expiry)
--   8. release_ai_worker_lease(...)        (only by the current holder)
--
-- It does NOT touch reports, report_assignments, notifications, incident
-- tables, any existing policy or any existing function, and it inserts no
-- rows: nothing is backfilled. Scheduling (pg_cron/pg_net/Vault) is NOT a
-- migration — see supabase/snippets/ai-worker-schedule.sql.
--
-- Access model (same as 0005/0006/0019): RLS on with NO policies and no
-- table privileges for anon/authenticated. Every function is SECURITY
-- INVOKER with search_path pinned; EXECUTE is revoked from PUBLIC (Postgres
-- grants it to PUBLIC by default), anon and authenticated, and granted only
-- to service_role, which the worker uses and which bypasses RLS.
-- Every due-time and lease comparison uses the DATABASE clock (now()), so
-- app-server clock skew can never make two workers think a lease is free.

-- ============================================================
-- 1. ai_analysis_jobs.notified_at
-- ============================================================

alter table public.ai_analysis_jobs
  add column if not exists notified_at timestamptz;

comment on column public.ai_analysis_jobs.notified_at is
  'Set once the AI-analysis notifications for this report are known to exist (sent or found). NULL on a completed job means a crash may have lost them — the worker re-checks and sends only the missing ones.';

-- ============================================================
-- 2. incident_confirmation_jobs
-- ============================================================

create table if not exists public.incident_confirmation_jobs (
  report_id uuid primary key references public.reports (id) on delete cascade,
  candidate_report_id uuid not null references public.reports (id) on delete cascade,
  match_score numeric(4, 3) not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error_kind text,
  last_error_status integer,
  last_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint incident_confirmation_jobs_distinct_reports
    check (candidate_report_id <> report_id),
  constraint incident_confirmation_jobs_score_range
    check (match_score >= 0 and match_score <= 1),
  constraint incident_confirmation_jobs_attempts_range
    check (attempts >= 0 and attempts <= max_attempts),
  constraint incident_confirmation_jobs_max_attempts_range
    check (max_attempts between 1 and 10),
  constraint incident_confirmation_jobs_processing_has_lease
    check (status <> 'processing' or locked_until is not null),
  constraint incident_confirmation_jobs_error_kind_shape
    check (last_error_kind is null or last_error_kind ~ '^[a-z0-9_]{1,40}$'),
  constraint incident_confirmation_jobs_error_status_range
    check (last_error_status is null or last_error_status between 100 and 599),
  constraint incident_confirmation_jobs_model_shape
    check (last_model is null or char_length(last_model) <= 80)
);

comment on table public.incident_confirmation_jobs is
  'One deferred Gemini "same incident?" check per new report (PK report_id), against its single best ambiguous candidate. Service-role only; sanitized error metadata only.';

create index if not exists incident_confirmation_jobs_due_idx
  on public.incident_confirmation_jobs (next_attempt_at)
  where status = 'pending';

create index if not exists incident_confirmation_jobs_lease_idx
  on public.incident_confirmation_jobs (locked_until)
  where status = 'processing';

-- Supports the ON DELETE CASCADE from the candidate side.
create index if not exists incident_confirmation_jobs_candidate_idx
  on public.incident_confirmation_jobs (candidate_report_id);

drop trigger if exists set_updated_at on public.incident_confirmation_jobs;
create trigger set_updated_at before update on public.incident_confirmation_jobs
  for each row execute function public.set_updated_at();

alter table public.incident_confirmation_jobs enable row level security;
revoke all on public.incident_confirmation_jobs from anon, authenticated;

-- ============================================================
-- 3. ai_worker_lease — at most one worker run at a time
-- ============================================================

create table if not exists public.ai_worker_lease (
  name text primary key
    check (name ~ '^[a-z0-9_]{1,40}$'),
  holder uuid,
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  constraint ai_worker_lease_holder_pairs_with_expiry
    check ((holder is null) = (locked_until is null))
);

comment on table public.ai_worker_lease is
  'Global worker lease (one row per worker kind, e.g. ''ai''). Taken atomically by acquire_ai_worker_lease() only when free or expired; cleared only by its holder. A crashed run simply lets it expire.';

alter table public.ai_worker_lease enable row level security;
revoke all on public.ai_worker_lease from anon, authenticated;

-- ============================================================
-- 4. claim_due_ai_jobs
-- ============================================================

create or replace function public.claim_due_ai_jobs(p_limit integer, p_lease_seconds integer, p_model text)
returns setof public.ai_analysis_jobs
language plpgsql
volatile
security invoker
set search_path = public
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 10 then
    raise exception 'claim_due_ai_jobs: p_limit must be between 1 and 10';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'claim_due_ai_jobs: p_lease_seconds must be between 30 and 900';
  end if;
  if p_model is not null and char_length(p_model) > 80 then
    raise exception 'claim_due_ai_jobs: p_model too long';
  end if;

  return query
  with due as (
    select j.report_id
    from public.ai_analysis_jobs j
    where j.attempts < j.max_attempts
      and (
        (j.status = 'pending' and j.next_attempt_at <= now())
        or (j.status = 'processing' and j.locked_until < now())
      )
    order by j.next_attempt_at, j.report_id
    limit p_limit
    for update of j skip locked
  )
  update public.ai_analysis_jobs a
     set status = 'processing',
         attempts = a.attempts + 1,
         locked_until = now() + make_interval(secs => p_lease_seconds),
         last_model = p_model
    from due
   where a.report_id = due.report_id
  returning a.*;
end;
$$;

comment on function public.claim_due_ai_jobs(integer, integer, text) is
  'Claims up to p_limit due AI jobs (pending and due, or processing with an expired lease, attempts < max_attempts) with FOR UPDATE SKIP LOCKED: concurrent callers never get the same job. Uses now(). Service-role only.';

-- ============================================================
-- 5. claim_due_incident_jobs
-- ============================================================

create or replace function public.claim_due_incident_jobs(p_limit integer, p_lease_seconds integer, p_model text)
returns setof public.incident_confirmation_jobs
language plpgsql
volatile
security invoker
set search_path = public
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 10 then
    raise exception 'claim_due_incident_jobs: p_limit must be between 1 and 10';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'claim_due_incident_jobs: p_lease_seconds must be between 30 and 900';
  end if;
  if p_model is not null and char_length(p_model) > 80 then
    raise exception 'claim_due_incident_jobs: p_model too long';
  end if;

  return query
  with due as (
    select j.report_id
    from public.incident_confirmation_jobs j
    where j.attempts < j.max_attempts
      and (
        (j.status = 'pending' and j.next_attempt_at <= now())
        or (j.status = 'processing' and j.locked_until < now())
      )
    order by j.next_attempt_at, j.report_id
    limit p_limit
    for update of j skip locked
  )
  update public.incident_confirmation_jobs a
     set status = 'processing',
         attempts = a.attempts + 1,
         locked_until = now() + make_interval(secs => p_lease_seconds),
         last_model = p_model
    from due
   where a.report_id = due.report_id
  returning a.*;
end;
$$;

comment on function public.claim_due_incident_jobs(integer, integer, text) is
  'Same claim semantics as claim_due_ai_jobs, for incident_confirmation_jobs. Service-role only.';

-- ============================================================
-- 6. find_reports_missing_ai_job
-- ============================================================

create or replace function public.find_reports_missing_ai_job(p_since timestamptz, p_limit integer)
returns table (report_id uuid, reporter_id uuid, created_at timestamptz)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if p_since is null then
    raise exception 'find_reports_missing_ai_job: p_since is required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'find_reports_missing_ai_job: p_limit must be between 1 and 100';
  end if;

  -- The 48-hour ceiling is enforced HERE as well as in the app: whatever
  -- p_since a caller passes, nothing older than 48 hours is ever returned,
  -- so this function can never become an automatic historical backfill.
  return query
  select r.id, r.reporter_id, r.created_at
  from public.reports r
  where r.created_at >= greatest(p_since, now() - interval '48 hours')
    and not exists (select 1 from public.ai_analyses a where a.report_id = r.id)
    and not exists (select 1 from public.ai_analysis_jobs j where j.report_id = r.id)
    and not exists (
      select 1 from public.report_locations rl
      where rl.report_id = r.id and rl.area like 'E2E-%'
    )
  order by r.created_at, r.id
  limit p_limit;
end;
$$;

comment on function public.find_reports_missing_ai_job(timestamptz, integer) is
  'Recent reports (>= greatest(p_since, now() - 48h)) with no ai_analyses row and no AI job, excluding E2E fixture locations. Read-only. Test-account exclusion is applied by the caller. Service-role only.';

-- ============================================================
-- 7. acquire_ai_worker_lease
-- ============================================================

create or replace function public.acquire_ai_worker_lease(p_name text, p_holder uuid, p_seconds integer)
returns boolean
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_acquired boolean;
begin
  if p_name is null or p_name !~ '^[a-z0-9_]{1,40}$' then
    raise exception 'acquire_ai_worker_lease: invalid lease name';
  end if;
  if p_holder is null then
    raise exception 'acquire_ai_worker_lease: p_holder is required';
  end if;
  if p_seconds is null or p_seconds < 30 or p_seconds > 900 then
    raise exception 'acquire_ai_worker_lease: p_seconds must be between 30 and 900';
  end if;

  -- One statement: a missing row is inserted; an existing row is taken over
  -- ONLY when it is free or expired (database clock). A concurrent caller
  -- blocks on the row lock, then re-evaluates the WHERE against the
  -- committed row and gets nothing back.
  insert into public.ai_worker_lease as l (name, holder, locked_until, updated_at)
  values (p_name, p_holder, now() + make_interval(secs => p_seconds), now())
  on conflict (name) do update
     set holder = excluded.holder,
         locked_until = excluded.locked_until,
         updated_at = now()
   where l.locked_until is null or l.locked_until < now()
  returning true into v_acquired;

  return coalesce(v_acquired, false);
end;
$$;

comment on function public.acquire_ai_worker_lease(text, uuid, integer) is
  'Atomically takes the named worker lease for p_seconds if it is free or expired (now()); returns false while another holder''s lease is valid. Service-role only.';

-- ============================================================
-- 8. release_ai_worker_lease
-- ============================================================

create or replace function public.release_ai_worker_lease(p_name text, p_holder uuid)
returns boolean
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.ai_worker_lease
     set holder = null, locked_until = null, updated_at = now()
   where name = p_name and holder = p_holder;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

comment on function public.release_ai_worker_lease(text, uuid) is
  'Clears the named lease only if p_holder still holds it; a stale or foreign holder changes nothing. Service-role only.';

-- ============================================================
-- Function privileges — service_role only
-- ============================================================

revoke all on function public.claim_due_ai_jobs(integer, integer, text) from public, anon, authenticated;
revoke all on function public.claim_due_incident_jobs(integer, integer, text) from public, anon, authenticated;
revoke all on function public.find_reports_missing_ai_job(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.acquire_ai_worker_lease(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_ai_worker_lease(text, uuid) from public, anon, authenticated;

grant execute on function public.claim_due_ai_jobs(integer, integer, text) to service_role;
grant execute on function public.claim_due_incident_jobs(integer, integer, text) to service_role;
grant execute on function public.find_reports_missing_ai_job(timestamptz, integer) to service_role;
grant execute on function public.acquire_ai_worker_lease(text, uuid, integer) to service_role;
grant execute on function public.release_ai_worker_lease(text, uuid) to service_role;
