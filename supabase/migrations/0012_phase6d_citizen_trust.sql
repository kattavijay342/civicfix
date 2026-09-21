-- Phase 6D — Citizen Experience, Trust & Resolution Intelligence
--
-- Additive only. Does not touch migrations 0001-0011. Two changes:
--   1. Widen reports.status to also accept 'reopened' (a citizen saying a
--      resolved issue isn't actually fixed re-enters the workflow).
--   2. A new resolution_feedback table + reports.reopened_at.
--
-- No reopen_reason column: the reason a citizen gives is already captured
-- by resolution_feedback.comment below and by the existing append-only
-- status_history.notes (every transition already logs notes) — a third
-- copy would be redundant denormalization.

-- ============================================================
-- 1. Widen the reports.status CHECK constraint.
--
-- The original constraint in 0001_init_schema.sql is an inline, unnamed
-- `check (status in (...))`, so Postgres auto-named it using its standard
-- <table>_<column>_check convention. Rather than assume that name (the
-- Phase 6A migration broke once already on a wrong assumption about
-- CREATE OR REPLACE FUNCTION semantics — see docs/PHASE_6A_REPORT.md), this
-- looks the real name up from pg_constraint and drops/recreates by that
-- discovered name.
-- ============================================================

do $$
declare
  constraint_name text;
begin
  select con.conname into constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'reports'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%status%'
    and pg_get_constraintdef(con.oid) ilike '%resolved%';

  if constraint_name is not null then
    execute format('alter table public.reports drop constraint %I', constraint_name);
  end if;

  alter table public.reports
    add constraint reports_status_check
    check (status in ('reported', 'ai_analyzed', 'routed', 'acknowledged',
                       'in_progress', 'resolved', 'reopened'));
end $$;

-- ============================================================
-- 1b. Widen notifications.type (notifications_type_check, added by name in
--     0011_phase6c_notifications.sql) to accept the two new Phase 6D
--     notification types. This constraint WAS explicitly named, so no
--     lookup is needed here.
-- ============================================================

alter table public.notifications
  drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check
  check (type in (
    'report_created', 'ai_analysis_completed', 'report_assigned', 'status_changed',
    'report_resolved', 'reminder_due', 'critical_issue', 'follow_up_recorded',
    'resolution_feedback_recorded', 'issue_reopened'
  ));

-- ============================================================
-- 2. reports.reopened_at — set once when a citizen's "still unresolved"
--    feedback reopens the report; cheap to query for dashboard counts
--    without joining status_history.
-- ============================================================

alter table public.reports
  add column if not exists reopened_at timestamptz;

-- ============================================================
-- 3. RESOLUTION_FEEDBACK — the original reporter's confirmation signal on
--    a resolution. One row per report, upserted (not insert-only) so a
--    citizen can re-submit feedback for a fresh resolution after a reopen
--    cycle; the application distinguishes "feedback for which resolution"
--    by comparing updated_at against resolution_evidence.resolved_at
--    rather than adding a resolution-cycle id column.
--
--    This is a citizen-reported confirmation signal only — it is never
--    converted into an official government resolution or a "verified"
--    badge (see src/lib/citizen-summary.ts).
-- ============================================================

create table if not exists public.resolution_feedback (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null unique references public.reports (id) on delete cascade,
  citizen_id uuid not null references public.profiles (id),
  confirmed boolean not null,
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists resolution_feedback_report_id_idx on public.resolution_feedback (report_id);

drop trigger if exists set_updated_at on public.resolution_feedback;
create trigger set_updated_at before update on public.resolution_feedback
  for each row execute function public.set_updated_at();

-- ============================================================
-- 4. RLS — same read-side authorization boundary as every other
--    report-keyed table (src/supabase/migrations/0002_rls_policies.sql):
--    reuses the existing can_view_report() helper unchanged. No INSERT/
--    UPDATE policy for `authenticated` — writes only ever happen through
--    src/lib/actions/resolution-feedback.ts's service-role client, after
--    an application-level check that the caller is the original reporter.
-- ============================================================

alter table public.resolution_feedback enable row level security;

create policy resolution_feedback_select on public.resolution_feedback
  for select to authenticated
  using (public.can_view_report(report_id));
