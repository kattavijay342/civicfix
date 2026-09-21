-- CivicFix Phase 5 — Duplicate reminder guard
-- Additive only. Safe to run on the existing live project — adds one
-- partial unique index, touches no existing data.
--
-- Phase 5 Step 10 requires "duplicate reminders are prevented". Before this,
-- nothing stopped a government user from scheduling the same instruction
-- (same report, same recipient, same due time) twice — e.g. a double-click
-- with a stale idempotency key from a previous successful submission, or
-- opening the reminder form in two tabs. Scoped to status = 'scheduled' so a
-- cancelled/sent reminder never blocks re-scheduling a genuinely new one for
-- the same slot.

create unique index if not exists reminders_dedupe_idx
  on public.reminders (report_id, recipient_id, scheduled_at)
  where status = 'scheduled';
