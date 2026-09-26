-- CivicFix G4 — effective-assignment RLS for department in-charges
--
-- Replaces ONLY the body of public.report_assigned_to_me(uuid). Signature,
-- return type, LANGUAGE sql, STABLE, SECURITY DEFINER and search_path are
-- unchanged, so CREATE OR REPLACE keeps the function's owner, grants and
-- every dependent policy/function exactly as they are:
--   reports_select, can_view_report() (-> report_locations, report_media,
--   ai_analyses, report_assignments, follow_ups, status_history,
--   resolution_evidence, report_duplicate_flags, resolution_feedback,
--   incident_reports, civic_incidents, get_incident_list), reminders_select,
--   and the security-invoker dashboard aggregates.
-- No table, column, index, grant or data change.
--
-- Before: any report_assignments row naming auth.uid() granted access, so a
-- deactivated, moved (other department), demoted or re-scoped in-charge kept
-- reading old assignments through the Data API.
--
-- After: identical to src/lib/incharge-access.ts (evaluateInchargeAccess),
-- which the app already enforces, and to G3 routing's findIncharge rules:
--   1. the assignment names auth.uid();
--   2. auth.uid()'s profile is still role 'department_incharge';
--   3. that profile is still for the assignment's department;
--   4. an ACTIVE department_incharges row exists for (auth.uid(), that
--      department) — unique (department_id, profile_id), so at most one;
--   5. that row's scope covers the report's stored location: every non-null
--      scope level equals the location's value (a NULL location value never
--      equals, same as the app's strict comparison), and a row with no scope
--      at all covers nothing;
--   6. the report has a stored location (inner join: fail closed).
--
-- SECURITY DEFINER is required (as before) so the helper can read profiles/
-- department_incharges without recursing through their own RLS. Every
-- relation is schema-qualified, and search_path stays pinned to public.
--
-- Rollback: re-run the original body from 0002_rls_policies.sql.

create or replace function public.report_assigned_to_me(r_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.report_assignments ra
    join public.profiles p
      on p.id = ra.incharge_id
     and p.role = 'department_incharge'
     and p.department_id = ra.department_id
    join public.department_incharges di
      on di.profile_id = p.id
     and di.department_id = ra.department_id
     and di.is_active
    join public.report_locations rl
      on rl.report_id = ra.report_id
    where ra.report_id = r_id
      and ra.incharge_id = auth.uid()
      and (di.gov_state is null or di.gov_state = rl.state)
      and (di.gov_district is null or di.gov_district = rl.district)
      and (di.gov_constituency is null or di.gov_constituency = rl.constituency)
      and (di.gov_area is null or di.gov_area = rl.area)
      and (
        di.gov_state is not null or di.gov_district is not null
        or di.gov_constituency is not null or di.gov_area is not null
      )
  );
$$;

comment on function public.report_assigned_to_me(uuid) is
  'G4: true only while the caller is the assignment''s in-charge AND still an active department_incharge of that department whose scope covers the report location (mirrors src/lib/incharge-access.ts).';
