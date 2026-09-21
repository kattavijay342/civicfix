-- CivicFix Phase 4 — Scheduled Reminders & Follow-up Automation
-- Additive only. Safe to run on the existing live project — creates one new
-- table, its indexes, and its RLS policy. Touches no existing table's data.
--
-- Distinct from `follow_ups` (a free-form monitoring log a government user
-- writes for themselves) — a reminder is an instruction from a government
-- user TO a specific department in-charge, with a scheduled due time and a
-- real processing lifecycle driven by a scheduler, not just a note.

-- ============================================================
-- REMINDERS
-- ============================================================

create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports (id) on delete cascade,
  created_by uuid not null references public.profiles (id),
  -- department_id/recipient_id are always derived server-side from the
  -- report's current report_assignments row at creation time — never
  -- accepted as free client input (see src/lib/actions/reminders.ts).
  department_id uuid not null references public.departments (id),
  recipient_id uuid not null references public.profiles (id),
  title text not null,
  message text not null,
  scheduled_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'processing', 'sent', 'failed', 'cancelled')),
  notification_id uuid references public.notifications (id) on delete set null,
  attempt_count int not null default 0,
  processed_at timestamptz,
  sent_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.reminders is
  'A scheduled instruction from a government/admin user to the department in-charge '
  'currently assigned to a report. Processed by a real scheduler (see src/app/api/cron/reminders) '
  'which atomically claims due rows and creates an in-app notification for the recipient.';
comment on column public.reminders.status is
  'scheduled: waiting to be processed; processing: atomically claimed by a scheduler run (transient); '
  'sent: notification delivered (terminal success); failed: retries exhausted (terminal failure); '
  'cancelled: withdrawn by its creator/admin before it became due (terminal).';

-- Composite index for the scheduler's claim query (status + due time), plus
-- the per-report/per-recipient/per-creator lookups the UI needs.
create index if not exists reminders_due_idx on public.reminders (status, scheduled_at);
create index if not exists reminders_report_id_idx on public.reminders (report_id);
create index if not exists reminders_recipient_id_idx on public.reminders (recipient_id);
create index if not exists reminders_created_by_idx on public.reminders (created_by);
create index if not exists reminders_department_id_idx on public.reminders (department_id);

drop trigger if exists set_updated_at on public.reminders;
create trigger set_updated_at before update on public.reminders
  for each row execute function public.set_updated_at();

-- ============================================================
-- RLS — same read-boundary-only architecture as every other table here
-- (see supabase/migrations/0002_rls_policies.sql): no INSERT/UPDATE/DELETE
-- policy for `authenticated` at all. Every write goes through a Server
-- Action using the service-role client, after that action has already
-- verified role/ownership/jurisdiction/assignment in application code (or,
-- for the scheduler, through the CRON_SECRET-gated route handler).
-- ============================================================

alter table public.reminders enable row level security;

create policy reminders_select on public.reminders
  for select to authenticated
  using (
    created_by = auth.uid()
    or recipient_id = auth.uid()
    or public.my_role() = 'admin'
    or (public.my_role() = 'government' and public.can_view_report(report_id))
    or (public.my_role() = 'department_incharge' and public.report_assigned_to_me(report_id))
  );
