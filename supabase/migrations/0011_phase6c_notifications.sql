-- CivicFix Phase 6C — Notifications & Communication Intelligence
-- Additive only: new nullable/defaulted columns on two existing tables.
-- No drops, no data loss, migrations 0001-0010 untouched.

-- ============================================================
-- notifications — priority, read_at, action_url, metadata, channel, and a
-- real CHECK constraint on `type` (previously unconstrained free text).
-- Existing rows only ever use 4 of the 8 listed types, so this is fully
-- backward compatible; `priority`/`channel` get safe defaults so no
-- existing row needs a value supplied.
-- ============================================================

alter table public.notifications
  add column if not exists priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'critical')),
  add column if not exists read_at timestamptz,
  add column if not exists action_url text,
  add column if not exists metadata jsonb,
  add column if not exists channel text not null default 'in_app'
    check (channel in ('in_app'));

alter table public.notifications
  add constraint notifications_type_check
  check (type in (
    'report_created', 'ai_analysis_completed', 'report_assigned', 'status_changed',
    'report_resolved', 'reminder_due', 'critical_issue', 'follow_up_recorded'
  ));

comment on column public.notifications.priority is
  'low/normal/high/critical — a separate scale from report severity/priority, though critical_issue notifications always use critical. Affects Notification Center emphasis/ordering only, never routing.';
comment on column public.notifications.read_at is
  'Set once, the first time a notification is marked read. is_read stays the fast boolean check; this is for "when."';
comment on column public.notifications.action_url is
  'Optional explicit deep link. When null, the UI falls back to related_report_id (/reports/[id]).';
comment on column public.notifications.metadata is
  'Optional structured context (e.g. which follow-up, which priority label) — never used for anything security-relevant.';
comment on column public.notifications.channel is
  'Delivery channel. Only in_app exists today (email/SMS/push are BLOCKED — no provider configured, see docs/PHASE_6C_REPORT.md); the CHECK constraint is extended in a future migration alongside whichever real provider gets added.';

-- No delivery_status column: per-channel delivery state (queued/sent/
-- delivered/failed) is only meaningful once an external channel exists,
-- which none does yet. Adding it now would be an always-empty column
-- carrying no information — the same reasoning migration 0010 used to
-- defer reverse-geocoding-only columns until a real provider exists.

-- ============================================================
-- profiles.notification_preferences — a small per-user opt-out map for the
-- 4 discretionary notification categories (see src/lib/notifications/
-- types.ts CATEGORY_BY_TYPE). A single JSONB column rather than a new
-- table: this is small, per-user, and every category defaults to "on" when
-- absent, so there's nothing to backfill for existing users.
-- ============================================================

alter table public.profiles
  add column if not exists notification_preferences jsonb;

comment on column public.profiles.notification_preferences is
  'Opt-out map, e.g. {"critical_issues": false}. Null or an absent key both mean "on" — preferences are opt-out, not opt-in, so every existing user keeps receiving every real event unless they explicitly turn a category off.';
