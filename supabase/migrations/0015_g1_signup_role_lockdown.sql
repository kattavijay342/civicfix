-- CivicFix G1 — lock public sign-up to the citizen role
--
-- WHY: 0001's handle_new_user() copied `raw_user_meta_data ->> 'role'` into
-- public.profiles.role. That metadata is fully client-controlled: anyone
-- holding the public anon key can call Supabase's /auth/v1/signup directly
-- with `data: { role: "admin" }` and receive an admin profile the moment
-- the row is inserted (verified against the live project during the G1
-- audit with a throwaway, unconfirmed, immediately-deleted probe user; no
-- existing account had been escalated this way).
--
-- FIX: every new auth user starts as 'citizen', full stop. Government /
-- department_incharge / admin roles are only ever assigned afterwards by
-- server code running as service_role after an explicit admin check
-- (src/lib/actions/admin.ts) — never from sign-up metadata.
--
-- Additive / non-destructive: replaces one function body only. No table,
-- column, policy, role value or existing row is changed; the existing
-- on_auth_user_created trigger keeps pointing at this same function name.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, mobile_number, role)
  values (
    new.id,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'mobile_number',
    'citizen'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

comment on function public.handle_new_user is
  'Always creates a citizen profile. Never reads a role from user metadata (client-controlled). '
  'Privileged roles are assigned only by admin-authorized server code.';
