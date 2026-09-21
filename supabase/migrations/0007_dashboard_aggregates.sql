-- CivicFix Phase 4 Step 8 — SQL-side dashboard aggregate metrics
-- Additive only. Creates three new functions, no new tables, no data
-- changes.
--
-- All three are `security invoker` (the default) and `stable`: called via
-- the CALLER's own Supabase client (see src/lib/data/government.ts), they
-- run under that caller's role, so the existing `reports_select` /
-- `report_assignments_select` RLS policies (supabase/migrations/0002) keep
-- applying automatically — a government user's jurisdiction scoping and a
-- department in-charge's assignment scoping are enforced by Postgres
-- itself, exactly as they already are for ordinary table reads. Nothing
-- here needs to duplicate that filtering logic.
--
-- Previously (src/lib/data/government.ts before this migration) these
-- metrics were computed by pulling every visible report row into the
-- Node process and reducing in JS — with no LIMIT at all, unlike the
-- issue-list queries. That doesn't scale and does the database's job in
-- the application tier. These functions push the counting/averaging into
-- Postgres, which only ever returns a handful of numbers.

-- ============================================================
-- get_area_overview — replaces getAreaOverview()'s in-memory reduction
-- ============================================================

create or replace function public.get_area_overview()
returns table (
  total_issues bigint,
  resolved bigint,
  pending bigint,
  critical bigint,
  resolution_rate numeric,
  on_time_resolution_rate numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with base as (
    select id, status, priority, created_at from public.reports
  ),
  agg as (
    select
      count(*) as total_issues,
      count(*) filter (where status = 'resolved') as resolved,
      count(*) filter (where priority = 'critical') as critical
    from base
  ),
  sla as (
    select
      case b.priority
        when 'critical' then 3 when 'high' then 7 when 'medium' then 14 else 21
      end as sla_days,
      re.resolved_at,
      b.created_at
    from base b
    join public.resolution_evidence re on re.report_id = b.id
    where b.status = 'resolved'
  ),
  ontime as (
    select
      count(*) as eligible,
      count(*) filter (
        where extract(epoch from (resolved_at - created_at)) / 86400 <= sla_days
      ) as on_time
    from sla
  )
  select
    agg.total_issues,
    agg.resolved,
    agg.total_issues - agg.resolved,
    agg.critical,
    case when agg.total_issues = 0 then 0
      else round(agg.resolved::numeric / agg.total_issues * 100) end,
    case when ontime.eligible = 0 then 0
      else round(ontime.on_time::numeric / ontime.eligible * 100) end
  from agg, ontime;
$$;

revoke all on function public.get_area_overview() from public;
grant execute on function public.get_area_overview() to authenticated;

-- ============================================================
-- get_department_performance — replaces getDepartmentPerformance()
-- ============================================================

create or replace function public.get_department_performance()
returns table (
  department_id uuid,
  name text,
  total_issues bigint,
  resolved_issues bigint,
  pending_issues bigint,
  resolution_rate numeric,
  on_time_rate numeric,
  avg_resolution_days numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with visible_reports as (
    select id, status, priority, created_at from public.reports
  ),
  dept_reports as (
    select
      d.id as department_id,
      d.name,
      ra.report_id,
      vr.status,
      vr.priority,
      vr.created_at
    from public.departments d
    left join public.report_assignments ra on ra.department_id = d.id
    left join visible_reports vr on vr.id = ra.report_id
  ),
  agg as (
    select
      department_id,
      name,
      count(report_id) as total_issues,
      count(report_id) filter (where status = 'resolved') as resolved_issues
    from dept_reports
    group by department_id, name
  ),
  sla as (
    select
      dr.department_id,
      case dr.priority
        when 'critical' then 3 when 'high' then 7 when 'medium' then 14 else 21
      end as sla_days,
      re.resolved_at,
      dr.created_at
    from dept_reports dr
    join public.resolution_evidence re on re.report_id = dr.report_id
    where dr.status = 'resolved'
  ),
  sla_agg as (
    select
      department_id,
      count(*) as eligible,
      count(*) filter (
        where extract(epoch from (resolved_at - created_at)) / 86400 <= sla_days
      ) as on_time,
      avg(extract(epoch from (resolved_at - created_at)) / 86400) as avg_days
    from sla
    group by department_id
  )
  select
    agg.department_id,
    agg.name,
    agg.total_issues,
    agg.resolved_issues,
    agg.total_issues - agg.resolved_issues,
    case when agg.total_issues = 0 then 0
      else round(agg.resolved_issues::numeric / agg.total_issues * 100) end,
    case when coalesce(sla_agg.eligible, 0) = 0 then 0
      else round(sla_agg.on_time::numeric / sla_agg.eligible * 100) end,
    case when sla_agg.avg_days is null then 0 else round(sla_agg.avg_days::numeric, 1) end
  from agg
  left join sla_agg on sla_agg.department_id = agg.department_id
  order by agg.name;
$$;

revoke all on function public.get_department_performance() from public;
grant execute on function public.get_department_performance() to authenticated;

-- ============================================================
-- get_insight_metrics — replaces the raw counting getAIInsights() used to
-- do over every visible report row. The human-readable copy/tone logic
-- stays in TypeScript (src/lib/data/government.ts) — that's presentation,
-- not a scan — this function only returns the numbers it needs.
-- ============================================================

create or replace function public.get_insight_metrics()
returns table (
  top_category text,
  top_category_count bigint,
  total_reports bigint,
  critical_unresolved bigint,
  aging_count bigint,
  last_7_days bigint,
  prior_7_days bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with base as (
    select category, status, priority, created_at from public.reports
  ),
  category_counts as (
    select category, count(*) as cnt from base group by category
  ),
  top as (
    select category, cnt from category_counts order by cnt desc, category asc limit 1
  )
  select
    (select category from top),
    coalesce((select cnt from top), 0),
    (select count(*) from base),
    (select count(*) from base where priority = 'critical' and status <> 'resolved'),
    (select count(*) from base where status <> 'resolved' and created_at < now() - interval '15 days'),
    (select count(*) from base where created_at >= now() - interval '7 days'),
    (select count(*) from base
       where created_at < now() - interval '7 days' and created_at >= now() - interval '14 days');
$$;

revoke all on function public.get_insight_metrics() from public;
grant execute on function public.get_insight_metrics() to authenticated;
