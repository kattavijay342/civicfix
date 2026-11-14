-- CivicFix — AI-2 worker lease renewal (CP2.2: file only, NOT applied anywhere)
--
-- Additive only. Depends on 0020_ai_worker.sql's ai_worker_lease table.
-- Does NOT modify 0019 or 0020.
--
-- Why: the worker (src/lib/ai-worker.ts) previously renewed its global
-- lease with a direct UPDATE … SET locked_until = app_clock + 270s. If the
-- application server's clock ran behind the database's by more than the
-- 30-second safety margin, the worker could believe it still held the
-- lease past the point another worker's acquire_ai_worker_lease() (which
-- compares against the DATABASE's now()) considered it expired — letting
-- two runs' Gemini calls overlap. renew_ai_worker_lease() fixes this by
-- computing and comparing expiry entirely with Postgres's own now(), and
-- returning a plain DURATION (ms remaining) rather than a timestamp, so the
-- caller never has to subtract its own clock reading from a database value.

create or replace function public.renew_ai_worker_lease(p_name text, p_holder uuid, p_seconds integer)
returns bigint
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_new_locked_until timestamptz;
begin
  if p_name is null or p_name !~ '^[a-z0-9_]{1,40}$' then
    raise exception 'renew_ai_worker_lease: invalid lease name';
  end if;
  if p_holder is null then
    raise exception 'renew_ai_worker_lease: p_holder is required';
  end if;
  if p_seconds is null or p_seconds < 30 or p_seconds > 900 then
    raise exception 'renew_ai_worker_lease: p_seconds must be between 30 and 900';
  end if;

  -- Only the current holder's row is touched (compare-and-set on name AND
  -- holder). A stale or foreign holder, or a lease this caller no longer
  -- holds, updates nothing and returns NULL — the caller must then stop
  -- claiming new work at once.
  update public.ai_worker_lease
     set locked_until = now() + make_interval(secs => p_seconds),
         updated_at = now()
   where name = p_name and holder = p_holder
  returning locked_until into v_new_locked_until;

  if v_new_locked_until is null then
    return null;
  end if;

  -- A plain duration (ms), computed and returned from the SAME statement's
  -- transaction snapshot of now() — never requires the caller to subtract
  -- its own wall-clock reading from a database timestamp.
  return floor(extract(epoch from (v_new_locked_until - now())) * 1000);
end;
$$;

comment on function public.renew_ai_worker_lease(text, uuid, integer) is
  'CP2.2: database-clock renewal of the named worker lease, holder-checked. Returns the remaining lease duration in milliseconds (Postgres now()), or NULL if p_holder no longer owns it. Service-role only.';

revoke all on function public.renew_ai_worker_lease(text, uuid, integer) from public, anon, authenticated;
grant execute on function public.renew_ai_worker_lease(text, uuid, integer) to service_role;
