-- CivicFix Phase 2 — initial schema
-- Additive only. Safe to run on a brand-new Supabase project.
-- Do not edit after it has been applied to a live project — add a new
-- numbered migration instead (see supabase/migrations/README.md).

create extension if not exists "pgcrypto";

-- ============================================================
-- ENUMS (as CHECK constraints on text, not Postgres ENUM types,
-- so adding a new allowed value later is a plain migration and
-- never requires ALTER TYPE / transaction gymnastics).
-- ============================================================

-- user_role:            citizen | government | department_incharge | admin
-- problem_category:     road | garbage | drainage | water_leakage | streetlight
--                        | sewage | dumping | infrastructure | other
-- report_status:        reported | ai_analyzed | routed | acknowledged
--                        | in_progress | resolved
-- priority_level:       low | medium | high | critical
-- severity_level:       low | medium | high | critical
-- location_source:      demo | search | manual | gps
-- media_kind:           evidence | before | after
-- follow_up_status:     pending | done

-- ============================================================
-- PROFILES — one row per authenticated user (extends auth.users)
-- ============================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'citizen'
    check (role in ('citizen', 'government', 'department_incharge', 'admin')),
  full_name text,
  mobile_number text,
  -- Jurisdiction scope, used by RLS for government users. All null = no
  -- jurisdiction assigned yet (sees nothing until an admin configures it).
  gov_state text,
  gov_district text,
  gov_constituency text,
  gov_area text,
  -- Set for department_incharge users; which department they act for.
  department_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'Extends auth.users with CivicFix role + jurisdiction/department scope.';
comment on column public.profiles.role is 'Government accounts are "Authorized Government User" only — never a claimed real official identity.';

-- ============================================================
-- DEPARTMENTS — configured by admins, not invented by AI
-- ============================================================

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  created_at timestamptz not null default now()
);

alter table public.profiles
  add constraint profiles_department_id_fkey
  foreign key (department_id) references public.departments (id) on delete set null;

-- ============================================================
-- DEPARTMENT IN-CHARGES — explicit assignment table (a department can
-- have several in-charges, e.g. per jurisdiction; a profile could in
-- principle be in-charge for more than one department over time).
-- ============================================================

create table if not exists public.department_incharges (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  -- Optional jurisdiction narrowing (e.g. this in-charge only covers one district).
  gov_state text,
  gov_district text,
  gov_constituency text,
  gov_area text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (department_id, profile_id)
);

-- ============================================================
-- REPORTS — the core civic issue record
-- ============================================================

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  description text not null,
  category text not null
    check (category in ('road', 'garbage', 'drainage', 'water_leakage', 'streetlight',
                         'sewage', 'dumping', 'infrastructure', 'other')),
  status text not null default 'reported'
    check (status in ('reported', 'ai_analyzed', 'routed', 'acknowledged',
                       'in_progress', 'resolved')),
  priority text
    check (priority in ('low', 'medium', 'high', 'critical')),
  severity text
    check (severity in ('low', 'medium', 'high', 'critical')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists reports_reporter_id_idx on public.reports (reporter_id);
create index if not exists reports_status_idx on public.reports (status);
create index if not exists reports_category_idx on public.reports (category);
create index if not exists reports_created_at_idx on public.reports (created_at desc);

-- ============================================================
-- REPORT LOCATIONS — one-to-one with reports. Every field except
-- displayName/source is intentionally optional (see src/lib/types.ts
-- CivicLocation) because jurisdiction hierarchies genuinely differ.
-- ============================================================

create table if not exists public.report_locations (
  report_id uuid primary key references public.reports (id) on delete cascade,
  display_name text not null,
  state text,
  district text,
  constituency text,
  area text,
  village text,
  ward text,
  municipality text,
  landmark text,
  address text,
  latitude double precision,
  longitude double precision,
  location_source text not null default 'manual'
    check (location_source in ('demo', 'search', 'manual', 'gps')),
  created_at timestamptz not null default now()
);

create index if not exists report_locations_jurisdiction_idx
  on public.report_locations (state, district, constituency, area);

-- ============================================================
-- REPORT MEDIA — evidence uploads (Supabase Storage paths, not public URLs)
-- ============================================================

create table if not exists public.report_media (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports (id) on delete cascade,
  uploaded_by uuid not null references public.profiles (id) on delete cascade,
  kind text not null default 'evidence'
    check (kind in ('evidence', 'before', 'after')),
  file_path text not null,
  file_type text,
  mime_type text,
  created_at timestamptz not null default now()
);

create index if not exists report_media_report_id_idx on public.report_media (report_id);

-- ============================================================
-- AI ANALYSES — one-to-one with reports, structured Gemini output
-- ============================================================

create table if not exists public.ai_analyses (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null unique references public.reports (id) on delete cascade,
  problem_summary text not null,
  category text not null
    check (category in ('road', 'garbage', 'drainage', 'water_leakage', 'streetlight',
                         'sewage', 'dumping', 'infrastructure', 'other')),
  severity text not null
    check (severity in ('low', 'medium', 'high', 'critical')),
  priority text not null
    check (priority in ('low', 'medium', 'high', 'critical')),
  reasoning text not null,
  recommended_department text not null,
  recommended_action text not null,
  confidence numeric(4, 3) not null check (confidence >= 0 and confidence <= 1),
  model text not null,
  raw_response jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================
-- REPORT ASSIGNMENTS — application-configured routing outcome.
-- The AI only *recommends*; this table is the source of truth for who
-- is actually responsible, and is populated by the app's routing logic.
-- ============================================================

create table if not exists public.report_assignments (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null unique references public.reports (id) on delete cascade,
  department_id uuid not null references public.departments (id),
  incharge_id uuid references public.profiles (id),
  assignment_method text not null default 'auto'
    check (assignment_method in ('auto', 'manual')),
  assigned_at timestamptz not null default now()
);

create index if not exists report_assignments_department_idx on public.report_assignments (department_id);
create index if not exists report_assignments_incharge_idx on public.report_assignments (incharge_id);

-- ============================================================
-- FOLLOW-UPS — government-user monitoring, never reassignment
-- ============================================================

create table if not exists public.follow_ups (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports (id) on delete cascade,
  government_user_id uuid not null references public.profiles (id),
  notes text not null,
  follow_up_date timestamptz not null default now(),
  next_follow_up_date date,
  status text not null default 'pending'
    check (status in ('pending', 'done')),
  created_at timestamptz not null default now()
);

create index if not exists follow_ups_report_id_idx on public.follow_ups (report_id);

-- ============================================================
-- STATUS HISTORY — append-only audit trail
-- ============================================================

create table if not exists public.status_history (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports (id) on delete cascade,
  old_status text,
  new_status text not null,
  changed_by uuid references public.profiles (id),
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists status_history_report_id_idx on public.status_history (report_id);

-- ============================================================
-- RESOLUTION EVIDENCE — before/after + notes, one-to-one with reports
-- ============================================================

create table if not exists public.resolution_evidence (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null unique references public.reports (id) on delete cascade,
  before_media_id uuid references public.report_media (id),
  after_media_id uuid references public.report_media (id),
  resolution_notes text not null,
  resolved_by uuid not null references public.profiles (id),
  resolved_at timestamptz not null default now()
);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  related_report_id uuid references public.reports (id) on delete cascade,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_recipient_idx on public.notifications (recipient_id, is_read);

-- ============================================================
-- DUPLICATE FLAGS — surfaced at submission time, never auto-merged
-- ============================================================

create table if not exists public.report_duplicate_flags (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports (id) on delete cascade,
  possible_duplicate_of uuid not null references public.reports (id) on delete cascade,
  similarity_score numeric(4, 3) not null,
  reviewed boolean not null default false,
  created_at timestamptz not null default now(),
  check (report_id <> possible_duplicate_of)
);

create index if not exists report_duplicate_flags_report_idx on public.report_duplicate_flags (report_id);

-- ============================================================
-- updated_at maintenance
-- ============================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at on public.profiles;
create trigger set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.reports;
create trigger set_updated_at before update on public.reports
  for each row execute function public.set_updated_at();

-- ============================================================
-- auth.users -> public.profiles bootstrap
-- ============================================================

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
    coalesce(new.raw_user_meta_data ->> 'role', 'citizen')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- status_history bootstrap: every new report gets an initial row
-- ============================================================

create or replace function public.handle_new_report()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.status_history (report_id, old_status, new_status, changed_by, notes)
  values (new.id, null, new.status, new.reporter_id, 'Report submitted');
  return new;
end;
$$;

drop trigger if exists on_report_created on public.reports;
create trigger on_report_created
  after insert on public.reports
  for each row execute function public.handle_new_report();

-- Log every status transition automatically, in addition to whatever a
-- server action writes explicitly with human context (notes / changed_by).
create or replace function public.handle_report_status_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if old.status is distinct from new.status then
    insert into public.status_history (report_id, old_status, new_status, changed_by, notes)
    values (new.id, old.status, new.status, null, null);
  end if;
  return new;
end;
$$;

drop trigger if exists on_report_status_change on public.reports;
create trigger on_report_status_change
  after update on public.reports
  for each row execute function public.handle_report_status_change();
