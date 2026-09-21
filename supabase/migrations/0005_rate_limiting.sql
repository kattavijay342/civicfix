-- CivicFix Phase 4 Step 3 — Server-side rate limiting
-- Additive only. Creates one new table + one new function. Touches no
-- existing table's data.
--
-- No Redis/Upstash is configured for this project (see .env.local.example),
-- so this uses a Postgres-backed shared counter instead of an in-memory
-- one. Unlike an in-memory counter, this IS correctly shared across every
-- serverless function instance (Vercel functions are stateless/ephemeral;
-- an in-memory counter would silently under-count and defeat the limiter).
-- It is slower than Redis under very high request volume — see the Phase 4
-- report for when that upgrade actually matters.

create table if not exists public.rate_limit_buckets (
  key text primary key,
  window_start timestamptz not null default now(),
  count int not null default 0,
  updated_at timestamptz not null default now()
);

comment on table public.rate_limit_buckets is
  'Fixed-window request counters keyed by "<action>:<subject>" (e.g. '
  '"auth_signin:203.0.113.4"). Only ever written by server code using the '
  'service-role client (see src/lib/rate-limit.ts) — never exposed to '
  'client requests directly.';

-- Only ever accessed through check_rate_limit() below, so no per-row
-- lookups are needed beyond the primary key itself.

-- ============================================================
-- RLS — same read-boundary-only architecture as every other table
-- (supabase/migrations/0002_rls_policies.sql). No policy at all here: this
-- table is never queried directly by client code, only via the
-- SECURITY DEFINER function below, and only ever reached through the
-- service-role client from Server Actions/route handlers, which bypasses
-- RLS anyway. RLS is still enabled so a future accidental client-side query
-- fails closed instead of leaking bucket keys.
-- ============================================================

alter table public.rate_limit_buckets enable row level security;

-- ============================================================
-- check_rate_limit — atomically increments the bucket for `p_key` and
-- reports whether the caller is still within `p_limit` requests per
-- `p_window_seconds`. A single INSERT ... ON CONFLICT DO UPDATE takes a row
-- lock on the conflicting row for the duration of the statement, so
-- concurrent calls for the same key serialize correctly — no lost updates,
-- no separate SELECT-then-UPDATE race window.
-- ============================================================

create or replace function public.check_rate_limit(p_key text, p_limit int, p_window_seconds int)
returns table (allowed boolean, retry_after_seconds int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
  v_window_start timestamptz;
begin
  insert into public.rate_limit_buckets as b (key, window_start, count, updated_at)
  values (p_key, now(), 1, now())
  on conflict (key) do update
    set
      window_start = case
        when b.window_start <= now() - make_interval(secs => p_window_seconds) then now()
        else b.window_start
      end,
      count = case
        when b.window_start <= now() - make_interval(secs => p_window_seconds) then 1
        else b.count + 1
      end,
      updated_at = now()
  returning b.count, b.window_start into v_count, v_window_start;

  return query select
    v_count <= p_limit,
    greatest(0, p_window_seconds - extract(epoch from (now() - v_window_start))::int);
end;
$$;

comment on function public.check_rate_limit is
  'Called only from server code via the service-role client. Deliberately '
  'NOT granted to anon/authenticated — a client that could call this '
  'directly could increment or inspect other users'' buckets.';

revoke all on function public.check_rate_limit(text, int, int) from public;
grant execute on function public.check_rate_limit(text, int, int) to service_role;

revoke all on public.rate_limit_buckets from anon, authenticated;

-- Cleanup: rows older than a day are never relevant again (the widest
-- window used anywhere in the app is 1 hour). Piggybacks on the existing
-- reminder cron run (src/app/api/cron/reminders) rather than a second
-- scheduled job.
create or replace function public.cleanup_stale_rate_limit_buckets()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.rate_limit_buckets where updated_at < now() - interval '1 day';
$$;

revoke all on function public.cleanup_stale_rate_limit_buckets() from public;
grant execute on function public.cleanup_stale_rate_limit_buckets() to service_role;
