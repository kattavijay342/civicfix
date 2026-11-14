-- CivicFix G8 — Government Analytics: area breakdown + analytics EXECUTE grants
--
-- Additive only. One new function, grant changes, no table/column/policy/
-- data change, and no existing function body is touched.
--
-- ============================================================
-- A. get_area_breakdown()
-- ============================================================
--
-- Why a new function: the only area aggregate that exists,
-- get_area_concentration() (0009), returns a single "top area" row. G8
-- needs per-location totals (Area Concentration section) and correct
-- totals for the dashboard's state/district/constituency/area filter, which
-- until now summed the dashboard's 200-most-recent-issue feed and so
-- undercounted any larger jurisdiction. The alternatives were pulling every
-- report_locations row into Node (the app-tier reduction 0007 removed) or
-- PostgREST aggregates (disabled by default on Supabase).
--
-- Security model — identical to 0007/0009/0013:
--   * SECURITY INVOKER + STABLE, called through the CALLER's own session
--     client (src/lib/data/government.ts). Postgres applies the caller's
--     reports_select and report_locations_select RLS (0002; in-charge scope
--     per 0016) to both tables, so a government user counts only reports in
--     report_in_my_jurisdiction(), a citizen only their own, an in-charge
--     only their effective assignments, an admin everything.
--   * No parameters: a direct RPC call cannot pass a jurisdiction, report,
--     department or user id to steer it. There is nothing to bypass other
--     than RLS itself.
--   * No SECURITY DEFINER: nothing here needs to read beyond what the caller
--     can already read.
--
-- Semantics (so the totals reconcile exactly with existing aggregates for
-- the same caller):
--   total_issues    = count(*)                                  = get_area_overview().total_issues (summed)
--   resolved_issues = status = 'resolved'                       = get_area_overview().resolved
--   pending_issues  = status <> 'resolved' (reopened included)  = get_area_overview().pending
--   critical_open   = priority = 'critical' and status <> 'resolved'
--                                                               = get_insight_metrics().critical_unresolved
-- LEFT JOIN so a report without a stored location is still counted, in a
-- row whose location levels are all NULL (report_locations.report_id is
-- the primary key, so a report can never be counted twice).
-- Rows are ordered by place name, never by count — the dashboard presents
-- them descriptively, not as a ranking.

create or replace function public.get_area_breakdown()
returns table (
  state text,
  district text,
  constituency text,
  area text,
  total_issues bigint,
  pending_issues bigint,
  critical_open bigint,
  resolved_issues bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    rl.state,
    rl.district,
    rl.constituency,
    rl.area,
    count(*),
    count(*) filter (where r.status <> 'resolved'),
    count(*) filter (where r.priority = 'critical' and r.status <> 'resolved'),
    count(*) filter (where r.status = 'resolved')
  from public.reports r
  left join public.report_locations rl on rl.report_id = r.id
  group by rl.state, rl.district, rl.constituency, rl.area
  order by rl.state nulls last, rl.district nulls last, rl.constituency nulls last, rl.area nulls last;
$$;

comment on function public.get_area_breakdown() is
  'G8: per-location issue counts (total/pending/open critical/resolved) for the CALLER''s RLS-visible reports. Security invoker, no parameters.';

-- ============================================================
-- B. EXECUTE grants
-- ============================================================
--
-- Supabase's default privileges grant EXECUTE on every new public function
-- DIRECTLY to anon and authenticated (not via PUBLIC). 0007/0009/0013 only
-- ran `revoke all ... from public`, so — verified live on 2026-09-28 with
-- the anon key — anon can still EXECUTE every existing analytics function.
-- No data is exposed today: all of them are security invoker and every
-- underlying RLS policy is `to authenticated`, so anon got only zero counts
-- and empty lists. The grants are still wider than those migrations
-- intended, so G8 removes anon EXECUTE from the new function and from the
-- analytics functions the Government dashboard calls. No function body,
-- signature or authenticated grant changes, so no signed-in behavior
-- changes (every app call site runs under a signed-in session behind
-- requireRole()). A signed-out caller now gets "permission denied" instead
-- of zeros.

revoke all on function public.get_area_breakdown() from public;
revoke all on function public.get_area_breakdown() from anon;
grant execute on function public.get_area_breakdown() to authenticated;

revoke execute on function public.get_area_overview() from anon;
revoke execute on function public.get_department_performance() from anon;
revoke execute on function public.get_insight_metrics() from anon;
revoke execute on function public.get_area_concentration() from anon;
revoke execute on function public.get_aging_buckets() from anon;
revoke execute on function public.get_resolution_quality() from anon;
revoke execute on function public.get_department_workload() from anon;
revoke execute on function public.get_department_trend(int) from anon;
revoke execute on function public.get_category_trends(int) from anon;

-- Rollback:
--   drop function if exists public.get_area_breakdown();
--   grant execute on function public.<each function above> to anon;
