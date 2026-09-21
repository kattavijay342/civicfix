-- CivicFix Phase 4 Step 9 — API-level idempotency
-- Additive only. Creates one new table. Touches no existing table's data.
--
-- Distinct from report_duplicate_flags (Phase 3's "is this probably the
-- same civic issue?" heuristic, kept as-is): this table answers "did the
-- same API operation get submitted more than once?" — a form double-submit,
-- a client retry after a dropped response, etc. A repeated request that
-- carries the same (user, action, client-generated key) never performs the
-- underlying insert twice; it returns the first attempt's recorded outcome.

create table if not exists public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  action text not null,
  client_key text not null,
  -- Small JSON result of the first successful/failed attempt, filled in
  -- once that attempt finishes. Null while the first attempt is still
  -- in-flight (see src/lib/idempotency.ts for how callers handle that).
  result jsonb,
  created_at timestamptz not null default now(),
  -- Time-bounded (Step 9: "time-bounded if necessary") — a client-generated
  -- key is only ever reused within a single form session, never across
  -- days, so a stale row is never legitimately replayed.
  expires_at timestamptz not null default (now() + interval '24 hours'),
  unique (user_id, action, client_key)
);

comment on table public.idempotency_keys is
  'One row per (user, action, client-generated key). The unique constraint '
  'is the actual dedupe mechanism — a concurrent or retried request with '
  'the same key hits a conflict on insert instead of creating a second row.';

create index if not exists idempotency_keys_expires_at_idx on public.idempotency_keys (expires_at);

-- ============================================================
-- RLS — same pattern as rate_limit_buckets: only ever touched by server
-- code via the service-role client, never directly by client requests.
-- ============================================================

alter table public.idempotency_keys enable row level security;
revoke all on public.idempotency_keys from anon, authenticated;

create or replace function public.cleanup_expired_idempotency_keys()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.idempotency_keys where expires_at < now();
$$;

revoke all on function public.cleanup_expired_idempotency_keys() from public;
grant execute on function public.cleanup_expired_idempotency_keys() to service_role;
