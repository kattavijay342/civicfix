-- Phase 6E — Government Operations & Civic Performance Intelligence
--
-- Additive only. Creates five new functions, no new tables, no column
-- changes, no data changes. Mirrors 0007_dashboard_aggregates.sql exactly:
-- every function is `security invoker` + `stable`, called via the CALLER's
-- own Supabase client (src/lib/data/government.ts), so it runs under that
-- caller's role — the existing `reports_select`/`report_assignments_select`
-- RLS policies (0002_rls_policies.sql) keep applying automatically. No
-- jurisdiction/assignment filtering logic is duplicated here.
--
-- Deliberately does NOT touch the SLA columns already in
-- get_area_overview()/get_department_performance() (0007) — those remain
-- exactly as they were computed (a hardcoded per-priority day threshold,
-- never a real government-configured due date). Phase 6E stops the
-- application layer from presenting that number as real SLA compliance
-- (src/lib/data/government.ts) rather than editing this already-shipped
-- function, per the "don't touch previous migrations" rule.

-- ============================================================
-- get_aging_buckets — how long currently-unresolved issues have been
-- pending, in real day buckets from the real created_at timestamp.
-- ============================================================

create or replace function public.get_aging_buckets()
returns table (
  bucket_0_1 bigint,
  bucket_2_3 bigint,
  bucket_4_7 bigint,
  bucket_8_14 bigint,
  bucket_15_30 bigint,
  bucket_30_plus bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with base as (
    select extract(epoch from (now() - created_at)) / 86400 as age_days
    from public.reports
    where status <> 'resolved'
  )
  select
    count(*) filter (where age_days < 2),
    count(*) filter (where age_days >= 2 and age_days < 4),
    count(*) filter (where age_days >= 4 and age_days < 8),
    count(*) filter (where age_days >= 8 and age_days < 15),
    count(*) filter (where age_days >= 15 and age_days < 31),
    count(*) filter (where age_days >= 31)
  from base;
$$;

revoke all on function public.get_aging_buckets() from public;
grant execute on function public.get_aging_buckets() to authenticated;

-- ============================================================
-- get_resolution_quality — Phase 6D's resolution_feedback/reopened_at,
-- aggregated. "confirmation_pending" mirrors the exact same "is this
-- feedback for the CURRENT resolution?" comparison the report detail page
-- uses (src/app/reports/[id]/page.tsx: feedback.updated_at vs
-- resolution_evidence.resolved_at) so the dashboard and the report page can
-- never disagree about what counts as pending.
-- ============================================================

create or replace function public.get_resolution_quality()
returns table (
  resolved bigint,
  citizen_confirmed bigint,
  confirmation_pending bigint,
  currently_reopened bigint,
  reopened_total_ever bigint,
  reopened_percentage numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with visible as (
    select id, status from public.reports
  ),
  resolved_now as (
    select v.id, re.resolved_at, rf.confirmed, rf.updated_at as feedback_at
    from visible v
    join public.resolution_evidence re on re.report_id = v.id
    left join public.resolution_feedback rf on rf.report_id = v.id
    where v.status = 'resolved'
  ),
  ever_resolved as (
    select distinct report_id from public.status_history
    where new_status = 'resolved' and report_id in (select id from visible)
  ),
  ever_reopened as (
    select distinct report_id from public.status_history
    where new_status = 'reopened' and report_id in (select id from visible)
  )
  select
    (select count(*) from resolved_now),
    (select count(*) from resolved_now where confirmed = true),
    (select count(*) from resolved_now
       where confirmed is distinct from true
         and (feedback_at is null or feedback_at < resolved_at)),
    (select count(*) from visible where status = 'reopened'),
    (select count(*) from ever_reopened),
    case when (select count(*) from ever_resolved) = 0 then 0
      else round((select count(*) from ever_reopened)::numeric
                  / (select count(*) from ever_resolved) * 100)
    end;
$$;

revoke all on function public.get_resolution_quality() from public;
grant execute on function public.get_resolution_quality() to authenticated;

-- ============================================================
-- get_department_workload — deterministic operational facts per
-- department, never a ranking (Phase 6E spec explicitly forbids
-- "Best/Worst/Top Performing Department" — this returns one neutral row
-- per department, application code never sorts it by a score).
-- ============================================================

create or replace function public.get_department_workload()
returns table (
  department_id uuid,
  name text,
  active_issues bigint,
  currently_reopened bigint,
  awaiting_acknowledgement bigint,
  in_progress_over_7_days bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with visible_reports as (
    select id, status, created_at from public.reports
  ),
  dept_reports as (
    select d.id as department_id, d.name, ra.report_id, vr.status, vr.created_at
    from public.departments d
    left join public.report_assignments ra on ra.department_id = d.id
    left join visible_reports vr on vr.id = ra.report_id
  ),
  in_progress_entries as (
    select distinct on (report_id) report_id, created_at as entered_at
    from public.status_history
    where new_status = 'in_progress'
    order by report_id, created_at desc
  )
  select
    dr.department_id,
    dr.name,
    count(dr.report_id) filter (where dr.status <> 'resolved'),
    count(dr.report_id) filter (where dr.status = 'reopened'),
    count(dr.report_id) filter (where dr.status = 'routed'),
    count(dr.report_id) filter (
      where dr.status = 'in_progress'
        and ipe.entered_at is not null
        and ipe.entered_at < now() - interval '7 days'
    )
  from dept_reports dr
  left join in_progress_entries ipe on ipe.report_id = dr.report_id
  group by dr.department_id, dr.name
  order by dr.name;
$$;

revoke all on function public.get_department_workload() from public;
grant execute on function public.get_department_workload() to authenticated;

-- ============================================================
-- get_department_trend — received/resolved/reopened/active per department
-- within a trailing p_days window. "received" = actually routed to that
-- department within the window (report_assignments.assigned_at), not the
-- report's original creation date, since a report can be created earlier
-- and routed later. "active" is a current snapshot (matches
-- get_department_workload's active_issues), not itself time-windowed.
-- ============================================================

create or replace function public.get_department_trend(p_days int)
returns table (
  department_id uuid,
  name text,
  received bigint,
  resolved bigint,
  reopened bigint,
  active bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with visible_reports as (
    select id, status from public.reports
  ),
  assignments as (
    select ra.report_id, ra.department_id, ra.assigned_at
    from public.report_assignments ra
    join visible_reports vr on vr.id = ra.report_id
  ),
  history as (
    select sh.report_id, a.department_id, sh.new_status, sh.created_at
    from public.status_history sh
    join assignments a on a.report_id = sh.report_id
  )
  select
    d.id,
    d.name,
    count(distinct a.report_id) filter (where a.assigned_at >= now() - (p_days || ' days')::interval),
    count(distinct h.report_id) filter (
      where h.new_status = 'resolved' and h.created_at >= now() - (p_days || ' days')::interval
    ),
    count(distinct h.report_id) filter (
      where h.new_status = 'reopened' and h.created_at >= now() - (p_days || ' days')::interval
    ),
    count(distinct a.report_id) filter (
      where exists (select 1 from visible_reports vr where vr.id = a.report_id and vr.status <> 'resolved')
    )
  from public.departments d
  left join assignments a on a.department_id = d.id
  left join history h on h.department_id = d.id
  group by d.id, d.name
  order by d.name;
$$;

revoke all on function public.get_department_trend(int) from public;
grant execute on function public.get_department_trend(int) to authenticated;

-- ============================================================
-- get_category_trends — per-category report counts within a trailing
-- p_days window, RLS-scoped exactly like every other function here.
-- ============================================================

create or replace function public.get_category_trends(p_days int)
returns table (
  category text,
  report_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select category, count(*)
  from public.reports
  where created_at >= now() - (p_days || ' days')::interval
  group by category
  order by count(*) desc, category asc;
$$;

revoke all on function public.get_category_trends(int) from public;
grant execute on function public.get_category_trends(int) to authenticated;
