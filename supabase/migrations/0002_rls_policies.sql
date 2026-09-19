-- CivicFix Phase 2 — Row Level Security
--
-- Architecture: every mutation in this app goes through a Next.js Server
-- Action that (1) reads the caller's identity from their session cookie via
-- the anon/authenticated Supabase client, (2) checks role/ownership/
-- jurisdiction in application code, and only then (3) performs the write
-- using the service-role client (which bypasses RLS by design).
--
-- That means these policies do NOT grant INSERT/UPDATE/DELETE to the
-- `authenticated` role anywhere — a compromised or buggy client can at most
-- read what it's allowed to read; it can never write directly. RLS here is
-- the read-side authorization boundary (jurisdiction filtering, ownership),
-- which is the one Supabase can enforce independently of application code.
--
-- All helper functions are SECURITY DEFINER so they can read `profiles`
-- (and related tables) without recursing back through this same RLS.

alter table public.profiles enable row level security;
alter table public.departments enable row level security;
alter table public.department_incharges enable row level security;
alter table public.reports enable row level security;
alter table public.report_locations enable row level security;
alter table public.report_media enable row level security;
alter table public.ai_analyses enable row level security;
alter table public.report_assignments enable row level security;
alter table public.follow_ups enable row level security;
alter table public.status_history enable row level security;
alter table public.resolution_evidence enable row level security;
alter table public.notifications enable row level security;
alter table public.report_duplicate_flags enable row level security;

-- ============================================================
-- Helper functions
-- ============================================================

create or replace function public.my_role()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.report_in_my_jurisdiction(r_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.report_locations rl
    join public.profiles p on p.id = auth.uid()
    where rl.report_id = r_id
      and p.role = 'government'
      and (p.gov_state is null or rl.state = p.gov_state)
      and (p.gov_district is null or rl.district = p.gov_district)
      and (p.gov_constituency is null or rl.constituency = p.gov_constituency)
      and (p.gov_area is null or rl.area = p.gov_area)
      and (
        p.gov_state is not null or p.gov_district is not null
        or p.gov_constituency is not null or p.gov_area is not null
      )
  );
$$;

comment on function public.report_in_my_jurisdiction is
  'A government user with NO jurisdiction configured (all gov_* null) matches nothing — '
  'they see zero reports until an admin assigns a scope, never everything by default.';

create or replace function public.report_assigned_to_me(r_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.report_assignments ra
    where ra.report_id = r_id and ra.incharge_id = auth.uid()
  );
$$;

create or replace function public.can_view_report(r_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.reports r
    where r.id = r_id
      and (
        r.reporter_id = auth.uid()
        or public.my_role() = 'admin'
        or (public.my_role() = 'government' and public.report_in_my_jurisdiction(r.id))
        or (public.my_role() = 'department_incharge' and public.report_assigned_to_me(r.id))
      )
  );
$$;

-- ============================================================
-- profiles
-- ============================================================

create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.my_role() = 'admin');

-- Self-updates are allowed (e.g. full_name, mobile_number) but role,
-- department_id and jurisdiction fields are protected by the trigger below
-- so a citizen can never grant themselves elevated access from the client.
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.my_role() = 'admin')
  with check (id = auth.uid() or public.my_role() = 'admin');

create or replace function public.protect_profile_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and coalesce(public.my_role(), '') <> 'admin' then
    new.role := old.role;
    new.department_id := old.department_id;
    new.gov_state := old.gov_state;
    new.gov_district := old.gov_district;
    new.gov_constituency := old.gov_constituency;
    new.gov_area := old.gov_area;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_fields on public.profiles;
create trigger protect_profile_fields before update on public.profiles
  for each row execute function public.protect_profile_fields();

-- ============================================================
-- departments — non-sensitive reference data
-- ============================================================

create policy departments_select on public.departments
  for select to authenticated
  using (true);

-- ============================================================
-- department_incharges
-- ============================================================

create policy department_incharges_select on public.department_incharges
  for select to authenticated
  using (profile_id = auth.uid() or public.my_role() in ('admin', 'government'));

-- ============================================================
-- reports
-- ============================================================

create policy reports_select on public.reports
  for select to authenticated
  using (
    reporter_id = auth.uid()
    or public.my_role() = 'admin'
    or (public.my_role() = 'government' and public.report_in_my_jurisdiction(id))
    or (public.my_role() = 'department_incharge' and public.report_assigned_to_me(id))
  );

-- ============================================================
-- Everything keyed by report_id shares the same visibility rule
-- ============================================================

create policy report_locations_select on public.report_locations
  for select to authenticated
  using (public.can_view_report(report_id));

create policy report_media_select on public.report_media
  for select to authenticated
  using (public.can_view_report(report_id));

create policy ai_analyses_select on public.ai_analyses
  for select to authenticated
  using (public.can_view_report(report_id));

create policy report_assignments_select on public.report_assignments
  for select to authenticated
  using (public.can_view_report(report_id));

create policy follow_ups_select on public.follow_ups
  for select to authenticated
  using (public.can_view_report(report_id));

create policy status_history_select on public.status_history
  for select to authenticated
  using (public.can_view_report(report_id));

create policy resolution_evidence_select on public.resolution_evidence
  for select to authenticated
  using (public.can_view_report(report_id));

create policy report_duplicate_flags_select on public.report_duplicate_flags
  for select to authenticated
  using (public.can_view_report(report_id));

-- ============================================================
-- notifications
-- ============================================================

create policy notifications_select on public.notifications
  for select to authenticated
  using (recipient_id = auth.uid());
