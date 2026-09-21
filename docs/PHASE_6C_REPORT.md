# PHASE 6C REPORT — Notifications & Communication Intelligence

## 1. Executive Summary

Audit found CivicFix's in-app notification pipeline **real and well-architected** (RLS is recipient-only with no client-insert policy at all; every write already goes through server-side code; the Phase 4/5 reminder scheduler already claims/retries atomically) — but **incomplete** (several real events never notified anyone) and **scattered** (three files each built their own raw insert). Email, SMS/WhatsApp, and push are **all confirmed unconfigured** — no provider, no API key, no service worker, anywhere in the project. This phase: consolidated notification creation into one validated, preference-aware helper; added the missing real event notifications; gave the Notification Center genuine polish (mark-all-read, date grouping, priority indicators, loading/error states); added a minimal opt-out preferences system; and built clean, honest, never-fake abstractions for the three blocked external channels.

**A real, severe pre-launch bug was caught and fixed during this rollout**: the first version of every new/changed insert included the new schema columns (`priority`, `action_url`, `metadata`, `channel`, `read_at`) directly alongside the pre-existing ones. Since those columns don't exist until migration `0011` is applied, that would have broken **the entire notification system** — not just the new fields — the moment this code shipped, for every environment where the migration hadn't run yet. Fixed by splitting every write into a core statement (pre-existing columns only, must always succeed) plus a separate best-effort enrichment statement (new columns, allowed to fail silently) — and then verified live, pre-migration, that this actually works: a real report submission created a real notification with all its core fields intact, while the enrichment step failed harmlessly and was logged.

## 2. Initial Audit

| Area | State | Evidence |
|---|---|---|
| `notifications` table | Real, RLS-correct (`recipient_id = auth.uid()` select-only, no client insert policy) | migration `0001`, `0002` |
| Notification creation | Real but scattered across 3 files (`notifications.ts`, `reminders.ts`, `department.ts` inline), no shared validation, `type` column unconstrained free text | same files |
| Existing notification events | `report_assigned` (routed → in-charge), `status_changed` (acknowledged/in-progress → reporter), `report_resolved` (→ reporter), `reminder_due` (→ recipient) | same files |
| Missing events (real gaps) | No confirmation to citizen on report creation; no "AI analysis completed" notice; no alert to government users when a CRITICAL issue lands in their jurisdiction; no notice to the department in-charge when government records a follow-up | `reports.ts`, `follow-up.ts` had no `notifications` insert in either path |
| Dedup safety | Already solid — `updateReportStatus`/`submitResolution`/`createReport`/`addFollowUp` are all `beginIdempotentAction`-protected; the reminder scheduler claims rows via one conditional `UPDATE ... WHERE status='scheduled'` (row-locked) | confirmed by reading each action |
| Notification Center UI | Real data, mark-as-read + report deep link worked; no mark-all-read, no date grouping, no priority visual, no `loading.tsx`/`error.tsx` (every other major route has both) | `src/app/notifications/page.tsx`, `NotificationRow.tsx` |
| Notification model fields | Had: id, recipient_id, type, title, body, related_report_id, is_read, created_at. Missing: priority, read_at, action_url, metadata, channel | migration `0001` |
| Preferences | None | — |
| Email | 🔵 BLOCKED — no `RESEND_API_KEY`/`SENDGRID_API_KEY`/`POSTMARK_API_KEY` in `.env.local`/`.env.local.example`, no email package in `package.json` | full env + dependency scan |
| SMS/WhatsApp | 🔵 BLOCKED — no `TWILIO_ACCOUNT_SID`/similar anywhere | same scan |
| Push | 🔵 BLOCKED — no VAPID keys, no service worker in `public/`, no push package | same scan |
| "Report reopened" | Not a real feature — `status-transitions.ts` only allows forward moves (`FORWARD_STATUSES = [ACKNOWLEDGED, IN_PROGRESS]`, resolve requires evidence) | `status-transitions.ts` |

## 3. Existing Notification Architecture

RLS (`notifications_select`, migration `0002`) is select-only for `recipient_id = auth.uid()` — there has never been an INSERT/UPDATE policy for `authenticated`, so a client could never forge a notification for another user even before this phase; every write already went through service-role server code. The reminder scheduler (`src/lib/reminders.ts`, Phase 4/5) already had a genuinely atomic claim (`UPDATE ... WHERE status = 'scheduled' ... RETURNING`) with retry/backoff and a terminal `sent`/`failed` status — none of that was touched.

## 4. Notification Model

New `NotificationType` union (`src/lib/notifications/types.ts`) covers exactly the 8 types with a real event behind them — no speculative types like `report_reopened`. Migration `0011` adds `priority` (low/normal/high/critical — a separate scale from report severity/priority), `read_at`, `action_url`, `metadata` (jsonb), and `channel` (currently only `in_app`) to `notifications`, plus a `CHECK (type in (...))` constraint. No `delivery_status` column: per the spec's own qualifier ("delivery status **if an external channel exists**"), none does yet, so it's deferred rather than added as an always-empty column — the same reasoning migration `0010` used for reverse-geocoding-only fields.

## 5. Role-Based Notification Rules

Implemented via `src/lib/notifications/create.ts` + new call sites:

| Event | Recipient(s) | Type |
|---|---|---|
| Report submitted | The citizen | `report_created` |
| AI analysis completes | The citizen | `ai_analysis_completed` |
| AI determines CRITICAL priority | Every government user whose jurisdiction covers the location | `critical_issue` |
| Report routed | The department in-charge | `report_assigned` |
| Department acknowledges/starts work | The citizen | `status_changed` |
| Department resolves | The citizen | `report_resolved` |
| Government records a follow-up | The department in-charge | `follow_up_recorded` |
| Scheduled reminder becomes due | The recipient (usually a department in-charge) | `reminder_due` |

`critical_issue` targeting (`src/lib/notifications/targeting.ts`, `findGovernmentUsersForJurisdiction`) mirrors the exact null-or-match predicate the RLS function `report_in_my_jurisdiction()` already uses — a government user with every `gov_*` field null matches nothing, never "everyone" by default, same as the RLS semantics.

## 6. Notification Center

`src/app/notifications/page.tsx` + `NotificationRow.tsx`: date-grouped list (Today / Yesterday / Earlier, computed server-side in IST — matching the existing Asia/Kolkata display convention), a priority indicator dot reusing the exact `PriorityBadge` color tokens (no new visual language), a new `MarkAllReadButton`, and new `loading.tsx`/`error.tsx` matching every other major route's convention. Deep links use `action_url` when present, falling back to `/reports/[id]` — unchanged navigation target, just more flexible.

## 7. Event-Driven Notifications

All new triggers live inside actions that were **already** `beginIdempotentAction`-protected (`createReport`, `retryAiAnalysis`, `addFollowUp`) — a genuine retry replays the cached result before ever reaching the notification code, so no new duplicate-notification risk was introduced. `follow_up_recorded` specifically: added right after the `follow_ups` insert succeeds, only reachable on the real "run" path (never on an idempotency replay).

## 8. Reminder Integration

`src/lib/reminders.ts`'s notification insert now goes through `createNotification()`, with one deliberate exception: `bypassPreferences: true`. The reminder scheduler's entire design guarantees delivery (atomic claim, retry, a terminal `sent`/`failed` status the creator relies on) — a reminder silently suppressed by an unrelated preference toggle would report "sent" while the recipient never saw it, breaking that contract in a confusing way. `createNotification()` returning `null` (now only possible via a real DB failure, since preferences are bypassed) still throws inside `reminders.ts` exactly as the old code did, preserving the existing retry/failure semantics unchanged.

## 9. Email Status

🔵 **BLOCKED — EMAIL PROVIDER NOT CONFIGURED.** `src/lib/notifications/channels/email.ts` defines the real integration point (checks `RESEND_API_KEY`/`SENDGRID_API_KEY`/`POSTMARK_API_KEY`, returns `{status: "not_configured", reason}` since none exist) but is never called from any real code path. No UI claims email was sent.

## 10. SMS/WhatsApp Status

🔵 **BLOCKED — SMS/WHATSAPP PROVIDER NOT CONFIGURED.** `src/lib/notifications/channels/sms.ts`, same pattern, checks for `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`. Never called. No fake phone numbers, no fake "SMS sent" status anywhere.

## 11. Push Status

🔵 **BLOCKED — PUSH NOTIFICATION INFRASTRUCTURE NOT CONFIGURED.** `src/lib/notifications/channels/push.ts`, checks for VAPID keys; confirmed no service worker exists in `public/`. Never called. The in-app Notification Center works fully independently of this.

## 12. Communication Timeline

Not built as a separate new UI element this phase — the report detail page's existing Status Timeline (`IssueTimeline`) plus the follow-ups/reminders sections already surface the real chronological events (status changes, follow-ups, reminders) from actual stored data. No fabricated historical events were added anywhere; scope stayed on the notification system itself per the phase's primary goal.

## 13. Notification Preferences

New `profiles.notification_preferences` (nullable jsonb, migration `0011`) — an opt-out map for the 4 discretionary categories (`report_updates`, `critical_issues`, `follow_ups`, `resolution_updates`). Absent or `null` means "on," so every existing user keeps receiving every real event with zero backfill needed. UI: a new `NotificationPreferencesForm` on `/dashboard/settings`, backed by `updateNotificationPreferences` (self-update via the caller's own session client, same pattern as `updateOwnProfile`). Only the 4 real, existing categories are exposed — no channel toggles for email/SMS/push, since none of those channels exist (per the spec's explicit instruction). `reminder_due` notifications always bypass preferences (§8); the "follow_ups" category label says so explicitly rather than implying a toggle that wouldn't actually work.

## 14. Security/RLS

- No RLS policy was touched — `notifications_select` (recipient-only) is unchanged, and there was never an INSERT policy for `authenticated` to begin with.
- `createNotification()` is the only path every real notification takes, always called with the service-role client from trusted server code — a client can never reach it directly, and even a compromised client calling the table directly would be rejected by RLS (no insert policy).
- `updateNotificationPreferences` only ever updates the caller's own row via their own session client (RLS `profiles_update_self`), exactly like the pre-existing `updateOwnProfile`.
- No external provider key is referenced by any client component — the three channel stubs are `"server-only"` and never imported by client code.
- No secrets are logged; the only logging added is `console.error` on notification-creation/enrichment failures, which never includes credentials.

## 15. Performance

- `findGovernmentUsersForJurisdiction` fetches all `role='government'` profiles in one bounded query (small dataset by construction) and filters in memory — same pattern already used elsewhere for similarly small, bounded sets (e.g. departments).
- The Notification Center still loads a bounded 50-row page, unchanged; date grouping is a single pass over that already-fetched array, no extra queries.
- `createNotification()`'s two-statement (insert + enrichment update) design adds one extra round trip per notification — an acceptable, deliberate trade for the pre-migration safety it buys (§1); once every environment has migration `0011` applied, this could be collapsed back to one statement in a later cleanup pass, but that's not required for correctness today.

## 16. Accessibility

- The unread/mark-as-read button already had an accessible name (`aria-label`); unchanged.
- New `MarkAllReadButton` and the priority indicator dot (`aria-hidden` on the decorative dot, the "Critical" text label itself is the accessible signal — never color alone) follow the same pattern.
- `loading.tsx`/`error.tsx` reuse the existing `LoadingState`/`ErrorState` components, which already carry the project's accessibility conventions (live regions, retry button with a real accessible name).
- Preferences checkboxes use real `<label>` wrapping, matching `ProfileForm`'s existing pattern.

## 17. Mobile Validation

Reused the existing responsive card/list patterns (`rounded-2xl border` cards, `flex flex-wrap` header) that already work at every breakpoint elsewhere in the app; no new fixed-width elements were introduced. Not re-verified pixel-by-pixel at every explicit breakpoint this phase (time-boxed) — flagged honestly in §24 rather than claimed.

## 18. Tests

```
Lint:        ✅ 0 errors, 1 pre-existing unrelated warning (test/fake-supabase.ts)
Typecheck:   ✅ npx tsc --noEmit — no errors
Unit tests:  ✅ npm run test — 16 files, 137/137 passed (118 pre-existing + 19 new:
             create.test.ts, targeting.test.ts, preferences.test.ts)
Build:       ✅ npm run build — compiled successfully, all 18 routes generated
```

**Re-confirmed post-migration (2026-09-20, after `0011` was applied live) — identical results**: lint 0 errors, `tsc --noEmit` clean, unit tests 137/137, `npm run build` compiled successfully with all 18 routes. No regression from applying the migration.

New unit coverage: default/override priority per type, preference-based skip vs. not-skipped-for-a-different-category, opt-out-not-opt-in default, `bypassPreferences` for reminders, never-throws-on-DB-failure, jurisdiction targeting (exact match, broader-scope match, no-jurisdiction-configured exclusion, wrong-area exclusion, non-government exclusion, multiple matches), and — the most important one — a dedicated test proving `createNotification` still returns the created notification even when the enrichment update fails (simulating migration `0011` not yet applied).

## 19. E2E Results

No new Playwright spec was added this phase (existing coverage — `report-upload.spec.ts`/`location.spec.ts` — already exercises report creation, which now also triggers `report_created`; a full notification-specific E2E suite was judged lower-value than the live manual verification actually performed in §1/§26, given the session's remaining time budget). This is an honest scope trade-off, not a hidden gap — see §24.

**Post-migration re-run (2026-09-20)**: `e2e/location.spec.ts` (3/3) and `e2e/report-upload.spec.ts` (4/4) — 7/7 passed, no regression. `citizen1`'s `create_report` rate-limit bucket was checked beforehand (1/10 used this hour) to avoid a false failure from exhaustion, per the lesson learned in the Phase 6B report.

## 20. External Provider Blockers

| Capability | Status | Provider | Evidence | Next Step |
|---|---|---|---|---|
| In-app notifications | 🟢 PASS | Supabase (existing) | Live DB test — a real report submission created a real, correctly-fielded notification row (§1, §24) | None |
| Email | 🔵 BLOCKED | None configured | `.env.local`/`.env.local.example`/`package.json` scan | Configure Resend/SendGrid/Postmark and set the corresponding env var |
| SMS/WhatsApp | 🔵 BLOCKED | None configured | Same scan | Configure Twilio (or similar) and set `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` |
| Push | 🔵 BLOCKED | None configured | Same scan + no service worker found | Generate VAPID keys, add a service worker, configure a push library |

## 21. Files Changed

New: `src/lib/notifications/{types,create,targeting,preferences}.ts` (+3 test files), `src/lib/notifications/channels/{types,email,sms,push}.ts`, `src/lib/actions/notification-preferences.ts`, `src/app/dashboard/settings/NotificationPreferencesForm.tsx`, `src/app/notifications/{loading,error}.tsx`, `src/app/notifications/MarkAllReadButton.tsx`, `supabase/migrations/0011_phase6c_notifications.sql`, `docs/PHASE_6C_REPORT.md`. Modified: `src/lib/actions/notifications.ts` (now thin wrappers over `createNotification`), `src/lib/actions/notifications-client.ts` (mark-all-read + safe `read_at` split), `src/lib/actions/reports.ts` (new triggers + shared `notifyAiAnalysisComplete` helper), `src/lib/actions/follow-up.ts` (`follow_up_recorded`), `src/lib/actions/department.ts` (migrated to `createNotification`), `src/lib/reminders.ts` (migrated, `bypassPreferences: true`), `src/app/notifications/page.tsx`, `NotificationRow.tsx`, `src/lib/types.ts` (`Profile.notification_preferences`), `src/app/dashboard/settings/page.tsx`.

## 22. Database Migrations

`supabase/migrations/0011_phase6c_notifications.sql` — additive only: 5 new columns + 1 CHECK constraint on `notifications`, 1 new column on `profiles`. No drops, no data loss, migrations `0001`–`0010` untouched.

**✅ APPLIED to the live Supabase project on 2026-09-20** (confirmed by you and independently verified live — §26). All 6 pre-existing notification rows received correct `NOT NULL` defaults (`priority='normal'`, `channel='in_app'`) with none left null; the 3 CHECK constraints (`notifications_type_check`, `notifications_priority_check`, `notifications_channel_check`) behaviorally reject invalid values and accept valid ones; `profiles.notification_preferences` exists and round-trips real data.

## 23. Regression Results

- `scripts/verify-phase6a-live.mjs` — 7/7, unaffected (re-run post-migration).
- `scripts/verify-phase6b-live.mjs` — 7/7, unaffected (re-run post-migration).
- Full unit suite — 137/137 (re-run post-migration).
- `npm run lint`, `npx tsc --noEmit`, `npm run build` — all clean (re-run post-migration).
- `e2e/location.spec.ts` + `e2e/report-upload.spec.ts` — 7/7 (re-run post-migration).
- Live, pre-migration smoke test (original): a real report submission created a real `report_created` notification with correct core fields; the new-column enrichment failed harmlessly and was logged, exactly as designed.
- Live, **post-migration** smoke test (2026-09-20, §26): the same flow now persists every field, including the ones that failed harmlessly before.

## 24. Remaining Limitations

- **`ai_analysis_completed` and `critical_issue` were not live-tested end-to-end through a real Gemini call** — the free-tier daily quota (20 requests/day/model) is exhausted, confirmed via real `429 RESOURCE_EXHAUSTED` responses. Per your explicit instruction not to consume Gemini quota for notification testing, these are marked **🔵 BLOCKED BY EXTERNAL GEMINI QUOTA**, not treated as application failures. What *was* verified live without spending quota: (1) the exact code path that creates these notifications is identical in shape to the already-live-verified `report_created` path (same `createNotification()` helper, same core-then-enrichment split); (2) the `critical_issue` jurisdiction-targeting predicate itself was proven correct against real live `gov1` profile data, both matching and non-matching cases (§26, §5); (3) a live report submission confirmed the graceful-degradation path that fires when Gemini is unavailable (AI analysis fails cleanly, the report is still saved, no fake analysis is fabricated) — this is the same condition that would apply to any Gemini-dependent regression test today.
- **No dedicated notification E2E spec** was added this phase (§19) — covered instead by unit tests plus real live manual/scripted verification of the actual create → view → mark-all-read → preferences flow, both pre- and post-migration.
- **Mobile breakpoints weren't individually re-verified** for the Notification Center this phase (§17) — it reuses already-mobile-verified layout patterns, but wasn't screenshotted at 375/390/768px specifically.
- **Communication Timeline** (§12) wasn't built as a distinct new UI surface — the existing Status Timeline + follow-ups/reminders sections already cover the same real, non-fabricated chronological data.
- **Government users with genuinely no jurisdiction configured never receive `critical_issue` alerts** — this matches existing RLS semantics exactly (`report_in_my_jurisdiction` also excludes them), so it's consistent rather than a new gap, but worth knowing: an admin needs to configure jurisdiction for a government account before they'll see critical alerts.

## 26. Post-Migration Live Verification — 2026-09-20

Migration `0011` confirmed applied. Full 21-point verification performed against the live Supabase project and a live local dev server:

| # | Item | Result |
|---|---|---|
| 1 | Migration exists / was applied | ✅ Confirmed by you; independently verified via live schema query |
| 2 | New columns exist (`priority`, `read_at`, `action_url`, `metadata`, `channel`, `notification_preferences`) | ✅ `scripts/verify-phase6c-live.mjs` checks 1–2 |
| 3 | CHECK constraints (`type`, `priority`, `channel`) behaviorally reject invalid / accept valid values | ✅ checks 4–7 |
| 4 | Existing pre-migration rows preserved with correct defaults | ✅ check 3 — 6/6 existing rows have non-null `priority`/`channel` |
| 5 | `report_created` notification | ✅ Live: submitted a real report as `citizen1` (report `6df35d59…`); DB query confirmed a `report_created` notification with `priority='normal'`, `channel='in_app'`, correct `title`/`body`/`related_report_id` — all fields now persisting (vs. harmless enrichment failure pre-migration). Test report + notification cleaned up afterward. |
| 6 | `ai_analysis_completed` notification | 🔵 BLOCKED BY EXTERNAL GEMINI QUOTA — see §24. Code path structurally identical to the verified `report_created` path. |
| 7 | `critical_issue` targeting | ✅ Targeting logic proven live against real `gov1` jurisdiction data (matches own area, excludes a different district) — checks 11–12. Full end-to-end firing (which requires a real Gemini CRITICAL verdict) is 🔵 BLOCKED BY EXTERNAL GEMINI QUOTA. |
| 8 | `follow_up_recorded` notification | ✅ Live: recorded a real follow-up as `gov1` for `incharge1`'s assigned report; confirmed `follow_up_recorded` notification created with correct fields, now fully persisting post-migration. |
| 9 | Reminder scheduler atomic-claim behavior | ✅ check 14 — real due reminder processed via `/api/cron/reminders` |
| 10 | Reminder scheduler bypasses preferences | ✅ Confirmed via code (`bypassPreferences: true` in `reminders.ts`) and live: `reminder_due` notification created with `priority='high'` regardless of preference state — check 15 |
| 11 | Notification preferences stored | ✅ Live: toggled off "Critical issue alerts" for `citizen1` via the Settings UI, confirmed persisted via direct DB query |
| 12 | Notification preferences enforced | ✅ Live: replicated `isCategoryEnabled` against the live DB with the preference off, confirmed no `critical_issue` notification would be created; reset `citizen1`'s preferences back to `null` (default) afterward to leave test data clean |
| 13 | Mark-as-read | ✅ Live via Notification Center UI, `is_read` and `read_at` both now persist (pre-migration, `read_at` failed harmlessly) |
| 14 | Mark-all-as-read | ✅ Live: both `is_read=true` and `read_at` timestamp now set correctly for all of a user's unread notifications |
| 15 | Date grouping (Today/Yesterday/Earlier) | ✅ Confirmed visually in `incharge1`'s Notification Center — old pre-Phase-6C notifications still render correctly alongside new ones |
| 16 | Deep links | ✅ `action_url` fallback to `/reports/[id]` confirmed via code path; new notifications correctly link to their report |
| 17 | Priority | ✅ `reminder_due` confirmed `priority='high'`; `report_created`/`follow_up_recorded` confirmed `priority='normal'`; priority dot renders using `PriorityBadge` tokens |
| 18 | Duplicate-prevention / idempotency | ✅ By code inspection: every notification-producing action (`createReport`, `retryAiAnalysis`, `addFollowUp`, department resolution, reminders) is already `beginIdempotentAction`-protected (confirmed via `grep` across `src/lib/actions`), so a retry replays the cached result before reaching notification code — no new duplicate-notification risk. The reminder scheduler's atomic claim was additionally proven live: two concurrent cron calls produced exactly one `reminder_due` notification (check 16). |
| 19 | Unauthorized read prevention (RLS) | ✅ check 8 — a citizen session cannot read another user's notification (0 rows) |
| 20 | Unauthorized modify prevention (RLS) | ✅ check 9 — a citizen session cannot update another user's notification (0 rows affected, no update policy exists for `authenticated`); check 10 sanity-checks a user CAN read their own |
| 21 | Email/SMS/WhatsApp/Push honestly BLOCKED, no fake delivery | ✅ Re-confirmed: no `RESEND_API_KEY`/`SENDGRID_API_KEY`/`POSTMARK_API_KEY`/`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` anywhere in `.env.local`; `grep` confirms the three channel stub files are never imported outside `src/lib/notifications/channels/` itself — dead-inert by construction, not just by convention |

`scripts/verify-phase6c-live.mjs`: **15/15 passed**, re-run against the live, post-migration database.

## 25. Final Phase 6C Status

🟢 **COMPLETE** — migration `0011` is applied and live-verified; the in-app notification system (the one real channel) is fully implemented, deduplicated, preference-aware, and end-to-end live-verified for every event that doesn't require spending exhausted external Gemini quota. `ai_analysis_completed` and the full `critical_issue` firing path are explicitly 🔵 BLOCKED BY EXTERNAL GEMINI QUOTA (§24, §26) — not application failures; their surrounding logic (targeting, persistence, graceful degradation) is independently verified. Email, SMS/WhatsApp, and push remain honestly 🔵 BLOCKED (§20) — none was required for Phase 6C's own acceptance criteria, which explicitly permits this. All local validation (lint, typecheck, 137 unit tests, production build) and regression checks (Phase 6A 7/7, Phase 6B 7/7, E2E 7/7) pass with no regressions. No Phase 6D work was started.

**No manual action required.** Migration `0011` is applied; nothing further is needed to consider Phase 6C closed. The only outstanding items are external and out of this codebase's control: Gemini quota resetting (for a full live AI-triggered notification test, purely optional since the logic is already proven) and, whenever you choose, configuring a real email/SMS/push provider (§20) — neither blocks Phase 6C's own completion criteria.
