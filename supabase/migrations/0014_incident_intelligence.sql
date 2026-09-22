-- CivicFix — Advanced Intelligence Extension A1: Civic Incident Intelligence
-- Additive only. Does not touch migrations 0001-0013; no drop, no delete,
-- no destructive statement anywhere in this file, no existing data rewritten.
--
-- Adds INCIDENT-level intelligence on top of the existing REPORT-level
-- duplicate/related detection (migration 0009, src/lib/duplicate-detection.ts).
-- A civic_incident groups several citizen reports that likely describe the
-- same real-world civic problem (e.g. three separate reports of "pothole
-- near RTC Bus Stand"), so a department can resolve the physical issue once
-- instead of once per report — see src/lib/incident-detection.ts for the
-- conservative, multi-signal matching logic and docs/
-- ADVANCED_INCIDENT_INTELLIGENCE_REPORT.md for the full design writeup.
--
-- Conservative by design: a report is only ever linked into an incident on
-- multiple corroborating signals (geography + category + recency + text
-- overlap, optionally AI-confirmed in the ambiguous band) — never a single
-- signal. Low-confidence matches are recorded as relationship_type =
-- 'candidate' for human review and are excluded from every aggregate/count
-- below, never silently merged or presented as certain.

-- ============================================================
-- CIVIC_INCIDENTS
-- ============================================================

create sequence if not exists public.civic_incident_code_seq;

create table if not exists public.civic_incidents (
  id uuid primary key default gen_random_uuid(),
  incident_code text not null unique
    default ('INC-' || lpad(nextval('public.civic_incident_code_seq')::text, 4, '0')),
  title text not null,
  category text not null
    check (category in ('road', 'garbage', 'drainage', 'water_leakage', 'streetlight',
                         'sewage', 'dumping', 'infrastructure', 'other')),
  subcategory text,
  severity text not null default 'low'
    check (severity in ('low', 'medium', 'high', 'critical')),
  priority text not null default 'low'
    check (priority in ('low', 'medium', 'high', 'critical')),
  -- Deliberately only 3 real states are ever written here. An incident's
  -- "reopened" state is never stored as a fourth value — it's derived live
  -- from its linked reports' own current statuses
  -- (src/lib/incident-status.ts), so a department resolving report-by-report
  -- can never leave this column lying about the real-world state, and
  -- nothing here becomes a second, driftable source of truth alongside the
  -- reports' own status_history.
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'resolved')),
  department_id uuid references public.departments (id),
  latitude double precision,
  longitude double precision,
  -- Overall confidence this grouping is genuinely one real-world incident —
  -- a deterministic function of the linked reports' own link confidences
  -- (src/lib/incident-priority.ts), never an invented/hallucinated number.
  confidence numeric(4, 3) not null default 0 check (confidence >= 0 and confidence <= 1),
  detection_method text not null default 'rule_based'
    check (detection_method in ('rule_based', 'ai_confirmed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);

comment on table public.civic_incidents is
  'Groups multiple citizen reports that likely describe the same real-world civic problem. Created/updated only by src/lib/incident-linking.ts (report submission time) and src/lib/actions/incidents.ts (department/government actions) via the service-role client — RLS below is read-only, same architecture as every other table in this project.';
comment on column public.civic_incidents.status is
  'open | in_progress | resolved only. "Reopened" is never stored -- it is derived live from linked reports'' current status (see get_incident_list.any_reopened below and src/lib/incident-status.ts).';

create index if not exists civic_incidents_status_idx on public.civic_incidents (status);
create index if not exists civic_incidents_department_idx on public.civic_incidents (department_id);
create index if not exists civic_incidents_category_idx on public.civic_incidents (category);
create index if not exists civic_incidents_created_at_idx on public.civic_incidents (created_at desc);

drop trigger if exists set_updated_at on public.civic_incidents;
create trigger set_updated_at before update on public.civic_incidents
  for each row execute function public.set_updated_at();

-- ============================================================
-- INCIDENT_REPORTS — the report <-> incident relationship
-- ============================================================

create table if not exists public.incident_reports (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.civic_incidents (id) on delete cascade,
  report_id uuid not null references public.reports (id) on delete cascade,
  relationship_type text not null
    check (relationship_type in ('primary', 'duplicate', 'related', 'supporting', 'candidate')),
  -- Deterministic multi-signal score (0-1) that produced this link, never
  -- an AI-invented number -- see src/lib/incident-detection.ts.
  confidence numeric(4, 3) not null check (confidence >= 0 and confidence <= 1),
  created_at timestamptz not null default now(),
  unique (incident_id, report_id)
);

comment on column public.incident_reports.relationship_type is
  '"candidate" = low-confidence, not yet reviewed by a human -- excluded from every incident aggregate/count (see get_incident_list) and never notified on, so an unreviewed guess is never presented as certain.';

create index if not exists incident_reports_incident_idx on public.incident_reports (incident_id);
create index if not exists incident_reports_report_idx on public.incident_reports (report_id);

-- Speeds up the incident-candidate search (same category, recent window) --
-- a composite index for the exact bounded query pattern
-- src/lib/incident-detection.ts and the existing src/lib/duplicate-detection.ts
-- both use (category + created_at), replacing two separate single-column
-- index scans with one.
create index if not exists reports_category_created_at_idx on public.reports (category, created_at desc);

-- ============================================================
-- RLS -- same read-side authorization boundary as every other report-keyed
-- table (supabase/migrations/0002_rls_policies.sql): no INSERT/UPDATE
-- policy for `authenticated` at all -- every write happens through
-- src/lib/incident-linking.ts / src/lib/actions/incidents.ts's service-role
-- client, after an application-level role/jurisdiction/assignment check.
-- ============================================================

alter table public.civic_incidents enable row level security;
alter table public.incident_reports enable row level security;

-- An incident-report link is visible exactly when the underlying report is
-- (reuses the existing can_view_report() boundary unchanged).
create policy incident_reports_select on public.incident_reports
  for select to authenticated
  using (public.can_view_report(report_id));

-- An incident itself is visible if the caller can view AT LEAST ONE of its
-- linked reports -- so a citizen sees an incident only when one of their
-- own reports belongs to it, a department in-charge only when one of their
-- assigned reports belongs to it, and a government user only within their
-- configured jurisdiction. No new jurisdiction/role logic is introduced.
create policy civic_incidents_select on public.civic_incidents
  for select to authenticated
  using (
    exists (
      select 1 from public.incident_reports ir
      where ir.incident_id = civic_incidents.id
        and public.can_view_report(ir.report_id)
    )
  );

-- ============================================================
-- get_incident_list -- real, RLS-scoped aggregation (same `security
-- invoker` pattern as get_area_overview()/get_department_performance(),
-- migration 0007). Every count/date below is computed from ONLY the
-- reports the caller is already authorized to see -- never the incident's
-- true global totals -- so a department in-charge or jurisdiction-scoped
-- government user can never learn about linked reports outside their own
-- authorization. Passing p_incident_id narrows to a single incident (the
-- detail page); left null for the list page.
-- ============================================================

create or replace function public.get_incident_list(p_incident_id uuid default null)
returns table (
  id uuid,
  incident_code text,
  title text,
  category text,
  subcategory text,
  severity text,
  priority text,
  status text,
  department_id uuid,
  department_name text,
  latitude double precision,
  longitude double precision,
  confidence numeric,
  detection_method text,
  linked_report_count bigint,
  affected_citizen_count bigint,
  earliest_report_at timestamptz,
  latest_report_at timestamptz,
  any_reopened boolean,
  any_unresolved boolean,
  -- Highest rank(severity) among linked non-candidate reports, 0=low..
  -- 3=critical. Lets the application layer (src/lib/data/incidents.ts)
  -- recompute a live, never-stale incident priority (src/lib/
  -- incident-priority.ts) from real-time signals (any_reopened,
  -- linked_report_count, age) without a second round-trip query, instead
  -- of trusting the civic_incidents.priority snapshot directly.
  max_member_severity_rank integer,
  created_at timestamptz,
  updated_at timestamptz,
  resolved_at timestamptz
)
language sql
security invoker
stable
as $$
  select
    ci.id, ci.incident_code, ci.title, ci.category, ci.subcategory,
    ci.severity, ci.priority, ci.status, ci.department_id, d.name as department_name,
    ci.latitude, ci.longitude, ci.confidence, ci.detection_method,
    count(distinct ir.report_id) as linked_report_count,
    count(distinct r.reporter_id) as affected_citizen_count,
    min(r.created_at) as earliest_report_at,
    max(r.created_at) as latest_report_at,
    bool_or(r.status = 'reopened') as any_reopened,
    bool_or(r.status <> 'resolved') as any_unresolved,
    max(case coalesce(r.severity, 'low')
          when 'critical' then 3 when 'high' then 2 when 'medium' then 1 else 0 end) as max_member_severity_rank,
    ci.created_at, ci.updated_at, ci.resolved_at
  from public.civic_incidents ci
  left join public.departments d on d.id = ci.department_id
  join public.incident_reports ir on ir.incident_id = ci.id and ir.relationship_type <> 'candidate'
  join public.reports r on r.id = ir.report_id
  where public.can_view_report(r.id)
    and (p_incident_id is null or ci.id = p_incident_id)
  group by ci.id, d.name
  order by ci.created_at desc;
$$;

comment on function public.get_incident_list is
  'RLS-scoped incident summaries. Excludes candidate (low-confidence, unreviewed) links from every count/date so a "7 linked reports" figure never includes an unconfirmed guess. Every count is bounded to what the caller can already see -- never the incident''s true global totals.';

-- ============================================================
-- get_citizen_incident_note -- the ONLY incident-related function a
-- citizen needs (spec section 13: safe aggregate only, never another
-- citizen's identity). Deliberately `security definer` (unlike every
-- function above) because it must count reports belonging to OTHER
-- citizens, which the caller could never otherwise see -- but it first
-- verifies the caller owns p_report_id and returns nothing beyond a count
-- and the category.
-- ============================================================

create or replace function public.get_citizen_incident_note(p_report_id uuid)
returns table (other_report_count bigint, category text)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not exists (
    select 1 from public.reports r
    where r.id = p_report_id and r.reporter_id = auth.uid()
  ) then
    return;
  end if;

  return query
    select (count(distinct ir2.report_id) - 1) as other_report_count, ci.category
    from public.incident_reports ir
    join public.civic_incidents ci on ci.id = ir.incident_id
    join public.incident_reports ir2 on ir2.incident_id = ir.incident_id and ir2.relationship_type <> 'candidate'
    where ir.report_id = p_report_id and ir.relationship_type <> 'candidate'
    group by ci.category;
end;
$$;

comment on function public.get_citizen_incident_note is
  'Verifies the caller owns p_report_id BEFORE returning anything. Returns only a count and a category -- never another citizen''s id, title, name, or contact info.';

-- ============================================================
-- notifications.type -- widen for the two new incident notification types.
-- Same explicitly-named constraint migrations 0011/0012 already
-- drop-and-recreate by name (notifications_type_check), so no lookup is
-- needed here (unlike the reports.status widening in migration 0012, whose
-- constraint was never given an explicit name).
-- ============================================================

alter table public.notifications
  drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check
  check (type in (
    'report_created', 'ai_analysis_completed', 'report_assigned', 'status_changed',
    'report_resolved', 'reminder_due', 'critical_issue', 'follow_up_recorded',
    'resolution_feedback_recorded', 'issue_reopened',
    'incident_created', 'incident_updated'
  ));
