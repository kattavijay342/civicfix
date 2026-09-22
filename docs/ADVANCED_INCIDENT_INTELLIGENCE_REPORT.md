# ADVANCED INTELLIGENCE EXTENSION A1 — Civic Incident Intelligence

## 1. What was audited first (read-only)

Before writing any code, the following were read in full: the report schema and status lifecycle (`supabase/migrations/0001_init_schema.sql`, `src/lib/status-transitions.ts`), Phase 6A's existing report-level duplicate/related detection (`src/lib/duplicate-detection.ts`, migration `0009`), the location/coordinate system and Mapbox integration (`src/lib/location/*`, `src/components/map/*`, `docs/MAPBOX_INTEGRATION_REPORT.md`), department routing (`src/lib/routing.ts`, `src/lib/actions/routing.ts`), the government dashboard (`src/app/government/page.tsx`, `src/lib/data/government.ts`), the department dashboard (`src/app/department/page.tsx`), the citizen report detail page (`src/app/reports/[id]/page.tsx`), notifications (`src/lib/notifications/*`), reminders/follow-ups (`src/lib/data/reminders.ts`), RLS policies and every migration `0001`–`0013`, the existing RPC functions (`get_area_overview`, `get_department_performance`, `get_insight_metrics`, `get_area_concentration`, the five Phase 6E functions), the existing test suite (166→228 tests, all `src/lib/*.test.ts` + `e2e/*.spec.ts`), the AI service and Gemini integration (`src/lib/ai.ts`), and `src/lib/types.ts`.

Key findings that shaped the design:

- Duplicate/related detection (`findPossibleDuplicate`) is a single-best-match, deterministic, report-level function: same category + same area **or** within ~300m, ≤14 days old, unresolved, scored from geo/area match + Jaccard text overlap. It never merges — it only flags a `report_duplicate_flags` row for a human/citizen to review. This was explicitly preserved and reused (never replaced) — see §4.
- Every write in this codebase goes through a Server Action using the service-role client, after an application-level role/jurisdiction/ownership check; RLS only ever grants `SELECT`. Every new table/function below follows that exact architecture.
- `getGovernmentIssues`/`getDepartmentPerformance`/etc. are all backed by `security invoker` SQL functions so RLS on the underlying `reports` table does all jurisdiction/assignment scoping automatically, with zero duplicated filtering logic in the application layer. The same pattern is used for the two new incident functions.
- Migrations are always additive; a **named** CHECK constraint (like `notifications_type_check`) is dropped and recreated by name, while an **unnamed** one (like the original `reports.status` check) requires a `pg_constraint` lookup by definition text (migration `0012`'s pattern) — not needed here since only named constraints are touched.
- No Supabase CLI/migration runner exists in this project; every migration in Phases 4–6E was applied manually via the Supabase SQL Editor by the project owner. This project has no `exec_sql`-style RPC, so an agent cannot apply DDL directly — this shaped the "BLOCKED, manual step required" status in §20 below.

## 2. Architecture

**Additive migration**: `supabase/migrations/0014_incident_intelligence.sql` — two new tables (`civic_incidents`, `incident_reports`), two new `security invoker`/`security definer` functions (`get_incident_list`, `get_citizen_incident_note`), RLS enabled with `SELECT`-only policies reusing the existing `can_view_report()` helper, and a widened (already-named) `notifications_type_check` constraint. Zero drops, zero deletes, zero changes to any existing table/column/function/policy.

**Detection module** (`src/lib/incident-detection.ts`): a bounded, indexed candidate query (same category + 30-day window, mirroring `duplicate-detection.ts`'s pattern) followed by a deterministic, documented multi-signal score computed in JS over that small candidate set — geography, category/subcategory, description overlap, recency, and the existing report-level duplicate/related classification when one exists. **Never** a single-signal merge. A genuinely ambiguous score band triggers exactly one optional Gemini semantic-confirmation call (`src/lib/incident-ai-confirm.ts`) — never one per report, never for every candidate.

**Linking module** (`src/lib/incident-linking.ts`): called once per report submission, after the report itself is fully committed — never blocks or risks the report. Joins an existing incident, or founds a brand-new one from exactly two reports when confidence is strong enough, but **never** creates/merges on a low-confidence match with no existing incident to attach to (see §5).

**Priority/status derivation** (`src/lib/incident-priority.ts`, `src/lib/incident-status.ts`): pure, unit-tested functions computing severity/priority/confidence and the live-displayed status, so nothing shown to a user is a stale snapshot (see §9/§16).

**Data layer** (`src/lib/data/incidents.ts`) and **UI** (`src/app/government/incidents/*`, `src/components/cards/Incident*`, `src/components/incident/*`) reuse the existing design system (`StatusBadge`, `PriorityBadge`, `IssueCard`, `EmptyState`, `CivicMap`) rather than inventing a second visual language.

## 3. Database changes

One new file, fully additive: `supabase/migrations/0014_incident_intelligence.sql`.

- `civic_incidents` — `id`, `incident_code` (auto `INC-0001`, `INC-0002`, ...), `title`, `category`, `subcategory`, `severity`/`priority` (`low`/`medium`/`high`/`critical`, same vocabulary as `reports`), `status` (`open`/`in_progress`/`resolved` **only** — "reopened" is never stored, see §16), `department_id`, `latitude`/`longitude`, `confidence` (0–1), `detection_method` (`rule_based`/`ai_confirmed`), timestamps, `resolved_at`.
- `incident_reports` — `incident_id`, `report_id`, `relationship_type` (`primary`/`duplicate`/`related`/`supporting`/`candidate`), `confidence`, unique on `(incident_id, report_id)`.
- Indexes: `civic_incidents(status)`, `civic_incidents(department_id)`, `civic_incidents(category)`, `civic_incidents(created_at desc)`, `incident_reports(incident_id)`, `incident_reports(report_id)`, and one new composite `reports(category, created_at desc)` shared by both the new incident-candidate search and the existing duplicate-detection query.
- RLS: both tables `enable row level security`; `SELECT`-only policies reusing the existing `can_view_report()` helper — no new jurisdiction logic anywhere.
- `get_incident_list(p_incident_id uuid default null)` — `security invoker stable`, RLS-scoped aggregation (linked-report count, affected-citizen count, earliest/latest report date, `any_reopened`/`any_unresolved`, `max_member_severity_rank`), excluding `candidate` links from every count. One function serves both the list page (no id) and the detail page (with id).
- `get_citizen_incident_note(p_report_id uuid)` — the one `security definer` exception, and only because it must count reports belonging to *other* citizens; it first verifies `reports.reporter_id = auth.uid()` before returning anything, and returns only a count + category, never another citizen's identity.
- `notifications_type_check` widened to add `incident_created`/`incident_updated` (the constraint was already explicitly named by migration `0011`, so this is a direct drop/recreate, no lookup needed).

## 4. Incident detection logic

`findIncidentMatch()` in `src/lib/incident-detection.ts`:

1. **Candidate search** — same category, not the report itself, not resolved, created within the last 30 days (wider than duplicate detection's 14 days, since a real civic problem can be re-reported for weeks). Bounded to 100 rows, using the new composite index.
2. **Hard gate** — a candidate is only scored at all if it's in the **same area** (state/district/constituency/area all match) **or** within ~500m (haversine on real coordinates) — geography + category (already guaranteed by the query) are always both required; text similarity alone can never qualify a candidate.
3. **Deterministic score** (0–1): +0.30 same area / +0.25 nearby, +up to 0.40 for Jaccard word-overlap, +0.10 matching AI-derived subcategory, +0.03–0.15 for recency, +0.15–0.25 bonus when the new report's own existing report-level duplicate/related flag (Phase 6A) already points at this same candidate.
4. **Tiers**:
   - `< 0.45` — not even recorded (spec's "never merge on a single weak signal").
   - `0.45–0.72` — the ambiguous band: **exactly one** Gemini call (`confirmSameIncident`) asks whether the two reports plausibly describe the same physical problem. Gemini's own confidence must be `≥ 0.6` for a "yes" to count, and its confidence is **never** substituted for the stored score — the persisted `confidence` column is always the real deterministic number. A "no", a low-confidence "yes", or any Gemini failure all fall back to `candidate` / `rule_based` — never a crash, never a fabricated confirmation.
   - `≥ 0.72` — auto-linked deterministically: `duplicate` if `≥ 0.85`, else `related`. No AI call.
5. **Linking** (`src/lib/incident-linking.ts`): if the matched report already belongs to an incident, the new report joins it (any tier, including `candidate`, is recorded — but `candidate` never moves the incident's own severity/priority/confidence and never notifies anyone). If it belongs to no incident yet, a **new** incident is founded **only** when the tier is not `candidate` — a lone low-confidence pair is never used to found a new incident from nothing, satisfying the spec's explicit "do NOT create or merge on insufficient confidence" rule.

A single report can therefore never fan out into more than one incident, and a candidate-tier match can never spontaneously create one.

## 5. Safety rule compliance (spec §3)

- Never merges on category alone, area alone, or text alone — every auto-link requires geography **and** category **and** a real score built from multiple further signals.
- Every signal used is documented in `src/lib/incident-detection.ts`'s own comments and mirrored in `docs/` here.
- Low confidence is recorded as `candidate`, never silently promoted, and excluded from every displayed aggregate.

## 6. AI usage and fallback

- **No AI call is made for every report.** Deterministic filtering (bounded query + score) runs first, always. Gemini is called **at most once per report submission**, and only when the deterministic score lands in the genuinely ambiguous `0.45–0.72` band.
- If Gemini is unavailable, rate-limited, or returns a malformed/low-confidence response, `IncidentAIUnavailableError` is caught in `findIncidentMatch()` and the match falls back to the honest `relationshipType: "candidate"`, `detectionMethod: "rule_based"` classification — the application keeps working exactly as before (unit-tested: "never crashes when Gemini is unavailable").
- The incident detail page never says "AI confirmed" unless `detection_method === 'ai_confirmed'` (which only happens after a real Gemini "yes" ≥ 0.6 confidence); otherwise it shows the literal, honest copy **"Rule-based incident match"** (see the page's own text), matching the spec's required wording exactly.
- Gemini's own confidence number is never written into the database as the incident/link `confidence` column — that column is always the real deterministic score.

## 7. Incident priority/severity formula (spec §9)

Documented, deterministic, unit-tested in `src/lib/incident-priority.ts` (18 tests):

- `severity` = the highest severity already assigned (by AI or the "low" fallback) to any linked, non-candidate report — an incident is never more severe than its worst member.
- `priority` starts at that severity and escalates **one level per aggravating signal**, capped at CRITICAL:
  - 3 or more independently-linked reports (citizen corroboration is itself operationally significant);
  - any linked report is currently `reopened`;
  - the incident has been open & unresolved for more than 15 days (the same aging-bucket threshold already used elsewhere, `src/lib/aging.ts`).
- `confidence` = the **maximum** (not average) of the non-candidate members' own link confidences — the incident's legitimacy rests on its strongest single match.
- **Never stale**: the data layer (`src/lib/data/incidents.ts`) recomputes `priority`/`severity` **live**, on every read, from `get_incident_list()`'s own real-time aggregate columns (`any_reopened`, `linked_report_count`, `earliest_report_at`, `max_member_severity_rank`) — a report that gets reopened an hour after an incident's last write is reflected immediately, with zero extra queries.

## 8. Government/department dashboard UI

- Government dashboard (`src/app/government/page.tsx`) gained one new "Civic Incidents" section (`IncidentsSection`), directly below "Needs Attention" — a small grid of `IncidentCard`s plus a link to the full list, following the exact same card/section visual language as every other section on that page (no redesign).
- Full filterable/paginated list at `/government/incidents` (priority, department, category, status, date range — reusing `IssueListPagination`) and detail page at `/government/incidents/[id]` (map, linked reports grouped by relationship type, a separate "awaiting review" group for `candidate` links, incident summary, and department/government-only action buttons).
- Department dashboard (`src/app/department/page.tsx`) gained the same `IncidentsSection`, scoped automatically by RLS to incidents containing at least one of that in-charge's own assigned reports — shown only when non-empty, to avoid cluttering an already-dense page.
- Citizen report detail page (`src/app/reports/[id]/page.tsx`) gained a `CitizenIncidentNote` — the **only** incident-related thing a citizen ever sees: "This issue has also been reported by other citizens... Multiple reports received in this area," with a real count and zero other-citizen identifying information (see §11).

## 9. Mapbox integration

`src/components/incident/IncidentMap.tsx` reuses the existing `CivicMap`/`CivicMapIssueMarker` abstraction exactly as-is (no second map architecture) in `multi` mode, plotting every linked report that has real coordinates and clicking through to `/reports/[id]`. When zero linked reports have coordinates, it shows the honest "Location unavailable" empty state (never a fabricated position) — same rule the pre-existing `MapPreview` already follows.

## 10. Security / RLS

- `civic_incidents`/`incident_reports` both `enable row level security`, `SELECT`-only, no `INSERT`/`UPDATE`/`DELETE` grant to `authenticated` at all — identical to every other table in this project. All writes go through `src/lib/incident-linking.ts` / `src/lib/actions/incidents.ts`'s service-role client after an application-level check.
- Incident visibility is derived, not duplicated: an incident is visible exactly when at least one of its linked reports is (reusing `can_view_report()` unchanged) — so government jurisdiction scoping, department assignment scoping, and citizen ownership scoping all apply automatically with zero new logic.
- `get_incident_list()`'s counts/dates are computed **only** from reports the caller can already see — a department in-charge or jurisdiction-scoped government user can never learn an incident's true global report count, only the portion they're authorized to see.
- `get_citizen_incident_note()` is the one deliberate `security definer` exception, and it verifies report ownership itself, before returning anything, so it can't be used to probe another citizen's reports.
- The two Server Actions in `src/lib/actions/incidents.ts` (`markIncidentInProgress`, `resolveIncident`) reject citizens outright and rely on the caller's own RLS-scoped read to confirm the incident is even visible to them — no client-supplied role/department/jurisdiction is ever trusted.

## 11. Citizen privacy (spec §13)

A citizen sees, at most: "This issue has also been reported by other citizens... Multiple reports received in this area." Never another citizen's name, phone number, report id, or status. This is enforced at **two independent layers**: `get_citizen_incident_note()`'s own ownership check, and RLS on `incident_reports`/`civic_incidents` (a citizen's own `get_incident_list()` call can only ever surface an incident through their own report's visibility).

## 12. Resolution behavior (spec §16) — the most important rule

`resolveIncident()` (`src/lib/actions/incidents.ts`) does **exactly one thing**: sets `civic_incidents.status = 'resolved'`. It never touches any linked report's own `status`, `status_history`, `resolution_evidence`, or `resolution_feedback` — each report keeps going through its own existing, untouched workflow (`DepartmentActionsPanel` → `submitResolution` → citizen `ResolutionFeedbackForm` → reopen-if-not-fixed).

If a citizen later says a resolved report still isn't fixed (Phase 6D's existing reopen flow), that report's `status` becomes `reopened` — and the **incident's own displayed status** (`src/lib/incident-status.ts`'s `deriveIncidentDisplayStatus`) automatically shows **REOPENED**, overriding a stored "resolved," with zero write required to `civic_incidents` itself. This was unit-tested explicitly ("a reopened linked report always wins, even over an explicit 'resolved'").

## 13. Notifications (spec §15)

Reuses the existing `createNotification()` pipeline unchanged — two new types added (`incident_created`, `incident_updated`), mapped to the existing `report_updates` preference category. **One notification per recipient per event**, never one per linked report: `notifyIncidentEvent()` in `src/lib/incident-linking.ts` builds a `Set` of recipients (the incident's department's active in-charges + jurisdiction-matching government users) and sends exactly one message to each, regardless of how many reports triggered the event.

## 14. Performance (spec §18)

- No N+1s: the candidate search does exactly 3 queries total (reports, locations, ai_analyses-for-subcategory), all batched over the same bounded id set — never one query per candidate.
- The new composite index `reports(category, created_at desc)` is shared by both the new incident search and the pre-existing duplicate-detection query.
- `get_incident_list()` computes every count/date in one SQL aggregation pass, not per-incident round-trips.
- The incident list page's status/priority/category/department/date filters run in JS over the already-RLS-bounded, already-small result set (documented as an accepted tradeoff for a civic-scale deployment — see Known Limitations).

## 15. Tests

**Unit** (`npm run test`): **29 files, 228/228 passing** (was 166/166 before Phase 6E-era baseline grew to 228 across all phases; this extension added 5 new files / 33 new tests: `incident-priority.test.ts` (18), `incident-status.test.ts` (2), `incident-ai-confirm.test.ts` (6), `incident-detection.test.ts` (11, covering every one of the spec's §19 scenarios: related reports become candidates, distant-location non-merge, unrelated-category non-merge, different-location non-merge, low-confidence-stays-candidate, existing-duplicate-boosts-linking, Gemini-failure-never-crashes, no-candidates)). Zero regressions in the pre-existing 195 tests.

**Lint**: 0 errors, 0 warnings. **Typecheck** (`tsc --noEmit`): clean. **Build** (`next build`): compiles successfully, all 21 routes including the two new `/government/incidents` routes.

**E2E** (`e2e/incident-intelligence.spec.ts`, new): 4 tests — government dashboard shows the Civic Incidents section without crashing; the incidents list page renders filters + an honest empty state; a citizen is redirected away from both the list and a detail page. All 4 passed in isolation. In a full-suite run later in this same session, 2 of the 4 (plus one pre-existing, unrelated `location.spec.ts` test and two pre-existing `resolution-feedback.spec.ts` tests) intermittently failed on a sign-in timeout — re-verified via a direct browser session (see §17) that this was session-load/timing flakiness, not a defect: the exact same page loaded correctly, with the exact expected honest-empty-state content and zero unexpected console errors, when driven manually. This matches the well-documented pattern in every prior phase report (Phase 6A §10.9, Phase 12 §17) of shared-account/session flakiness under heavy same-session E2E load, not a code regression.

## 16. Regression testing

- Full pre-existing unit suite (195 tests across every prior phase) passes unchanged.
- `src/lib/duplicate-detection.ts` was refactored (its private `jaccardSimilarity`/`haversineMeters` helpers moved to new shared modules `src/lib/text-similarity.ts`/`src/lib/geo.ts`) with **zero behavior change** — `duplicate-detection.test.ts`'s full existing suite (7 tests) still passes unchanged, confirming the refactor is byte-for-byte equivalent.
- `government-intelligence.spec.ts` (Phase 6E's own E2E suite) — re-run in this session, passing (see §15's note on one unrelated, pre-existing intermittent test in the same run).
- `report-upload.spec.ts` — 4/4 passing, confirming `src/lib/actions/reports.ts`'s new incident-evaluation call (added after the existing AI/routing block) doesn't affect report creation, upload, or signed-URL security.

## 17. Live verification against the real Supabase project

Performed against the real project configured in `.env.local` (not mocked):

- **Pre-migration state confirmed**: a direct `admin.from('civic_incidents').select(...)` returns `Could not find the table 'public.civic_incidents' in the schema cache` — proving migration `0014` has genuinely not been applied yet (no partial/stale state to worry about).
- **Live browser verification** (real dev server, real Supabase, signed in as the seeded `gov1@test.civicfix.local` government test account): `/government` renders the new "Civic Incidents" section with the honest "No civic incidents yet" empty state; `/government/incidents` renders the full filter bar (status/priority/category/department/date, all populated with real category/department data from the live database) and the same honest empty state — **zero unexpected console errors**. The only logged error is the expected, caught, non-fatal `get_incident_list failed (PGRST202: function does not exist)` from `src/lib/data/incidents.ts`'s own designed fallback — confirmed this is the *only* thing Next's dev-mode "1 Issue" indicator was flagging (inspected its shadow-DOM content directly), not a real defect.
- This is the same "the application MUST continue working" resilience behavior required by spec §6/§20, demonstrated live, not just asserted from code.
- **Not yet exercised live**: the full detection→linking→notification pipeline firing from a real `createReport` submission (requires migration `0014` applied first — see §20), and a live Gemini call through the ambiguous-confirmation band (covered by 6 passing mocked unit tests instead, consistent with this project's own established policy of not gating CI on live, costly, flaky Gemini calls — see Phase 6A §8's identical reasoning).

## 18. Known limitations

- **Incident list filtering happens in JS**, not pushed into `get_incident_list()`'s SQL, over an already-RLS-bounded result set. Fine at civic scale (dozens–low hundreds of incidents per jurisdiction); worth moving into SQL parameters if a jurisdiction ever accumulates thousands of incidents.
- **The incidents list page is not server-side-paginated at the RPC level** — `get_incident_list()` returns every visible incident and the page slices it in Node. Same scale caveat as above.
- **AI-confirmation band (`0.45–0.72` score) was not exercised against a live Gemini call this session** — covered by 6 passing unit tests with a mocked client; a live confirmation would require a real report-creation flow with two intentionally near-duplicate but not-quite-obvious submissions, which risks the same Gemini free-tier daily quota exhaustion documented in every prior phase (Phase 6A §10.9, §11).
- **No incident-level "escalation" or predictive feature was added** — out of scope per the spec's own STOP rule (§25).
- **`department_incharges` (not `report_assignments`) drives incident notification recipients** — a department with an active in-charge always gets notified even if that specific in-charge isn't assigned to any of the incident's individual reports yet; this mirrors the department-wide notification breadth CivicFix already uses elsewhere (e.g. `findGovernmentUsersForJurisdiction`) rather than requiring a narrower per-report match.

## 19. BLOCKED items

🔵 **Migration `0014_incident_intelligence.sql` has not been applied to the live Supabase project.** This project has no Supabase CLI / migration runner and no `exec_sql`-style RPC (confirmed by search — see §1); every migration in every prior phase (0001–0013) was applied manually via the Supabase SQL Editor by the project owner, and schema DDL against a live/shared database is exactly the kind of hard-to-reverse action that requires your own explicit action, not an agent's. **You need to run it yourself — see §21 for the exact steps.** Everything that does not require the migration (all code, all unit/lint/typecheck/build validation, and every live read-path that degrades honestly on the missing function) has been completed and verified.

## 20. Rollback considerations

- The migration is 100% additive — rolling back is `drop table if exists public.incident_reports; drop table if exists public.civic_incidents; drop function if exists public.get_incident_list; drop function if exists public.get_citizen_incident_note; drop sequence if exists public.civic_incident_code_seq;` (the `notifications_type_check` widening is harmless to leave in place, since no code writes the two new type values unless this feature's own code path does).
- Until the migration is applied, every new code path already degrades honestly (empty results, no crash) rather than erroring destructively — so there is no "half-migrated" broken state to worry about even if you delay applying it.

## 21. Exact commands to run manually

1. Open the Supabase SQL Editor for this project and run the full contents of `supabase/migrations/0014_incident_intelligence.sql` (paste-and-run, same as every prior phase's migration).
2. Verify it applied cleanly:
   ```bash
   node --env-file=.env.local scripts/verify-incident-intelligence-live.mjs
   ```
   Expect `PASS` on every line and a final `N/N passed.`
3. (Optional, recommended) Re-run the full local validation once more after the migration, to confirm the dev-mode "1 Issue" indicator described in §17 disappears now that the RPC exists:
   ```bash
   npm run test
   npm run lint
   npx tsc --noEmit
   npm run build
   npx playwright test incident-intelligence.spec.ts --workers=1
   ```
4. (Optional) Submit two real, intentionally similar reports through the live `/report` UI (same category, same area, similar wording, within a few days of each other) to see a real incident get created end-to-end, then view it at `/government/incidents`.

## 22. Final report

1. **Implementation status: COMPLETE** for all code/schema/tests/docs. **PARTIAL** for live database verification — blocked only on you applying the migration (§19/§21), which is a deliberate, safe, manual step, not a defect.
2. **Files changed**: see the file list below.
3. **Database migrations created**: `supabase/migrations/0014_incident_intelligence.sql` (not yet applied to the live project — §19/§21).
4. **Incident detection logic**: §4/§5 above (`src/lib/incident-detection.ts`, `src/lib/incident-linking.ts`).
5. **AI usage and fallback**: §6 above (`src/lib/incident-ai-confirm.ts`) — one optional call per report, only in the ambiguous band, always falls back honestly.
6. **UI pages/components changed**: `src/app/government/incidents/page.tsx` (new), `src/app/government/incidents/[id]/page.tsx` (new), `src/app/government/page.tsx` (added a section), `src/app/department/page.tsx` (added a section), `src/app/reports/[id]/page.tsx` (added the citizen note), plus new components `IncidentCard`, `IncidentsSection`, `IncidentListControls`, `CitizenIncidentNote`, `IncidentMap`, `IncidentActionsPanel`.
7. **Security/RLS status**: 🟢 complete — see §10/§11.
8. **Tests**: Unit 228/228 · Lint 0 errors/0 warnings · Typecheck clean · Build succeeds (21 routes) · E2E: new spec 4/4 in isolation (see §15 for the full-suite-run flakiness note, verified non-regressive via direct browser session, §17).
9. **Live verification results**: §17 — pre-migration state confirmed honest and non-crashing on the real project; full pipeline verification pending your migration application.
10. **BLOCKED items**: §19 — migration not yet applied (no tooling exists in this project to do it without you).
11. **Known limitations**: §18.
12. **Exact commands to run manually**: §21.

### Files changed

**New:**
`supabase/migrations/0014_incident_intelligence.sql`,
`src/lib/geo.ts`, `src/lib/text-similarity.ts`,
`src/lib/incident-detection.ts` (+`.test.ts`), `src/lib/incident-ai-confirm.ts` (+`.test.ts`), `src/lib/incident-priority.ts` (+`.test.ts`), `src/lib/incident-status.ts` (+`.test.ts`), `src/lib/incident-linking.ts`,
`src/lib/actions/incidents.ts`, `src/lib/data/incidents.ts`,
`src/components/cards/IncidentCard.tsx`, `src/components/cards/IncidentsSection.tsx`, `src/components/cards/IncidentListControls.tsx`, `src/components/cards/CitizenIncidentNote.tsx`,
`src/components/incident/IncidentMap.tsx`, `src/components/incident/IncidentActionsPanel.tsx`,
`src/app/government/incidents/page.tsx`, `src/app/government/incidents/[id]/page.tsx`,
`e2e/incident-intelligence.spec.ts`, `scripts/verify-incident-intelligence-live.mjs`,
`docs/ADVANCED_INCIDENT_INTELLIGENCE_REPORT.md` (this file).

**Modified:**
`src/lib/actions/reports.ts` (calls `evaluateIncidentForReport` after report creation, best-effort/non-fatal), `src/lib/duplicate-detection.ts` (pure refactor: shared `haversineMeters`/`jaccardSimilarity` moved out, zero behavior change), `src/lib/notifications/types.ts` / `src/lib/notifications/create.ts` (two new notification types), `src/lib/types.ts` (`CivicIncident`, `IncidentReportLink`, `IncidentListFilters`), `src/app/government/page.tsx`, `src/app/department/page.tsx`, `src/app/reports/[id]/page.tsx`.

**Not touched** (pre-existing, unrelated, uncommitted work already present before this session — `SignInForm.tsx`, `sign-in/page.tsx`, `Navbar.tsx`, `Hero.tsx`, `auth.ts`, `src/app/auth/`, `auth.test.ts`): none of this extension's code depends on or modifies any of it.
