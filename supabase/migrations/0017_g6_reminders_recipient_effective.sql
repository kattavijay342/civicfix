-- CivicFix G6 — reminders_select: recipient access requires a CURRENT
-- effective assignment
--
-- Changes ONLY the USING expression of the existing reminders_select policy
-- (supabase/migrations/0004_reminders.sql). No table, column, index, grant,
-- function or data change. ALTER POLICY is atomic — there is no window in
-- which the table has no SELECT policy.
--
-- Problem (found by scripts/verify-g6-follow-up-live.mjs): the branch
--   recipient_id = auth.uid()
-- let a FORMER recipient — deactivated, moved to another department,
-- demoted, re-scoped out of the report's jurisdiction, or replaced by a new
-- in-charge — keep reading follow-up rows (title/message/report_id)
-- addressed to them through the Data API, although G4 (0016) already
-- denies them the report itself.
--
-- Fix: keep the recipient branch but require the G4 effective-assignment
-- rule on it, reusing public.report_assigned_to_me(report_id) (0016 body:
-- assignment names auth.uid() AND profile is still department_incharge of
-- that department AND an ACTIVE department_incharges row whose scope covers
-- the report location exists).
--
-- Why this preserves every legitimate reader: the only writer of reminders
-- is src/lib/actions/reminders.ts (createReminder, service role), which sets
-- recipient_id from report_assignments.incharge_id after checkInchargeAccess
-- passes — a recipient is always a department in-charge, and the only
-- legitimate recipient-reader is the CURRENT effective in-charge, which is
-- exactly report_assigned_to_me(report_id). The other branches are
-- unchanged:
--   created_by = auth.uid()                       creator (government/admin)
--   my_role() = 'admin'                           admin
--   government AND can_view_report(report_id)     jurisdiction government
--   department_incharge AND report_assigned_to_me effective in-charge
--
-- Writes are unaffected (reminders still has no INSERT/UPDATE/DELETE policy
-- for `authenticated`; the scheduler and server actions use the service
-- role, which bypasses RLS).
--
-- Rollback (restores the 0004 expression exactly):
--   alter policy reminders_select on public.reminders using (
--     created_by = auth.uid()
--     or recipient_id = auth.uid()
--     or public.my_role() = 'admin'
--     or (public.my_role() = 'government' and public.can_view_report(report_id))
--     or (public.my_role() = 'department_incharge' and public.report_assigned_to_me(report_id))
--   );

alter policy reminders_select on public.reminders
  using (
    created_by = auth.uid()
    or (recipient_id = auth.uid() and public.report_assigned_to_me(report_id))
    or public.my_role() = 'admin'
    or (public.my_role() = 'government' and public.can_view_report(report_id))
    or (public.my_role() = 'department_incharge' and public.report_assigned_to_me(report_id))
  );

comment on policy reminders_select on public.reminders is
  'G6: a recipient reads a reminder only while still the report''s EFFECTIVE in-charge (report_assigned_to_me, G4 rule); creator/admin/jurisdiction-government/effective-in-charge branches unchanged from 0004.';
