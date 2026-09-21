# PHASE 6B REPORT — Maps & Location Intelligence

## 1. Executive Summary

Phase 6B improves CivicFix's location system honestly, within a hard constraint confirmed by audit: **no map/geocoding/reverse-geocoding/boundary provider is configured anywhere in this project** (`GOOGLE_MAPS_API_KEY` is unset). Nothing was fabricated to compensate. Instead:

- Every location capability that does **not** require an external provider was made genuinely better: coordinate validation (previously nonexistent), GPS error handling (previously one generic message for every failure), GPS accuracy capture/display (previously discarded), and — the single biggest fix — the **Government Dashboard map**, which previously plotted markers at a **hash of the report ID** and rendered **fixed decorative "heat zones"** regardless of the underlying data. It now plots only reports with real coordinates, via a genuine bounding-box projection, with an honest empty state when no report has coordinates, and a real density grid computed from actual coordinates.
- Every capability that **does** require an external provider (map tiles, forward-geocoding search, reverse geocoding, administrative boundaries) is built as a clean, ready-to-activate abstraction, clearly marked 🔵 BLOCKED, with graceful "unavailable" UX — never a fake result.
- A real, non-obvious bug was caught and fixed during this rollout: the new `accuracy_meters` column doesn't exist on the live database until the migration below is applied, and the original insert would have failed the *entire* report-creation flow (not just the accuracy field) in that window. Fixed by moving it to a separate, best-effort update that can never block report creation.

## 2. Initial Audit

| Capability | Current State | Evidence | Phase 6B Action |
|---|---|---|---|
| Manual location | Real, working — cascading State→District→Constituency→Area + optional landmark | `src/lib/jurisdiction.ts`, `SmartLocationField.tsx` | No change — already honest (small, clearly-labeled demo hierarchy) |
| GPS/current location | Called the real `navigator.geolocation` API, but one generic error message for every failure mode, no accuracy captured, no `maximumAge`/`enableHighAccuracy` | `SmartLocationField.tsx` (pre-change) | Improved: per-failure messages, accuracy capture/display, explicit options |
| Coordinates | Real when present (GPS-only; the manual map pin never faked lat/lng); **zero validation anywhere** | `reports.ts` (`latitude: location.latitude ?? null`, no bounds check) | Added real validation, client + server, never a `(0,0)` fallback |
| Map display (citizen) | Illustrative pin-placement surface, already honestly labeled "Demo map" | `SmartLocationField.tsx` | No change needed |
| Map display (government) | **Fake** — marker position = hash of report id; fixed "Zone 2" rectangle; 3 hardcoded heat-zone circles | `MapPreview.tsx` (pre-change) | Rewritten — see §6 |
| Reverse geocoding | Dead, unimplemented stub, zero callers, already correctly returned "unavailable" | `src/lib/geocoding.ts` (pre-change) | Relocated + wired in for real via a server action (§7) |
| Jurisdiction detection | Manual only, small hand-picked demo dataset, already labeled "not an official government boundary lookup" | `jurisdiction.ts` | No change — do not infer from coordinates (would need a real boundary dataset — BLOCKED) |
| Area/ward detection | Free-text manual entry with an optional suggestion list | `SmartLocationField.tsx` | No change |
| Heatmap/concentration | Phase 6A's `get_area_concentration()` SQL is real and untouched; the map's *visual* heat zones were fake | migration `0009`, `MapPreview.tsx` (pre-change) | Preserved the SQL insight; fixed only the fake visual |
| Location validation | None | `reports.ts` | Added (§4) |
| Location source | Enum correct and used correctly; `search`/`demo` never produced by the live flow | migration `0001` | No schema change |
| Location search (forward geocoding) | Not implemented live. A separate, unused, honestly-labeled demo dataset (`src/lib/demo-locations.ts`) exists with zero callers | `demo-locations.ts` | Left untouched — not wiring fake data into a "search" UX (per the spec's explicit instruction) |
| Mobile location UX | Not previously verified at mobile width this phase | `SmartLocationField.tsx` | Verified live at 375px — works, good touch targets, no overflow |
| Tests | `jurisdiction.test.ts` only | — | Added `validation.test.ts`, `gps.test.ts`, `projection.test.ts` (27 new tests) |
| E2E | Manual location selection implicitly covered; no GPS coverage | `e2e/report-upload.spec.ts` | Added `e2e/location.spec.ts` using Playwright's real geolocation mocking |
| RLS | Untouched by anything in this phase | migration `0002` | No changes |

## 3. Map Provider

🔵 **BLOCKED — external provider/API configuration required.** No map tile provider (Google Maps, Mapbox, Leaflet+OSM tiles, etc.) is configured anywhere in the project. `MapPreview.tsx` uses an abstract, non-geographic decorative surface (grid pattern) with markers positioned by real relative lat/lng projection — there is no real basemap underneath, and nothing claims there is.

## 4. Geocoding (forward/search)

🔵 **BLOCKED — external provider/API configuration required.** No forward-geocoding/search provider is configured. The existing structured manual-location flow (state/district/constituency/area dropdowns) remains the fully-functional primary path and was not touched. `src/lib/demo-locations.ts` (a small, honestly-labeled, already-built demo place list) exists but is intentionally left disconnected — wiring it into a "search" UI would look like real search results without being backed by a real provider.

## 5. Reverse Geocoding

🔵 **BLOCKED — external provider/API configuration required**, but now **wired in for real** instead of left as a dormant stub:

- Relocated `src/lib/geocoding.ts` → `src/lib/location/reverse-geocoding.ts` (identical behavior, still returns `{status: "unavailable", reason: "..."}` since `GOOGLE_MAPS_API_KEY` is unset).
- Added `src/lib/actions/location.ts` (`attemptReverseGeocode`) — a real server action, called once per confirmed GPS fix from `SmartLocationField`. Keeps any future API key server-only (never sent to the client).
- Today's UX is unchanged (still shows "Address lookup unavailable — please confirm the location manually"), but it's now the output of a live code path, not hardcoded copy — the day a real key is configured, addresses will populate with zero further code changes.

## 6. Jurisdiction Intelligence

Unchanged by design. The existing jurisdiction hierarchy (`src/lib/jurisdiction.ts`) is a small, explicitly-labeled demo dataset — already exactly what the spec asks for: never inferring a ward/constituency from coordinates, never claiming an official boundary lookup, only showing fields the citizen actually entered. Building real coordinate→jurisdiction inference would require a real administrative-boundary dataset, which doesn't exist in this project — marked 🔵 BLOCKED rather than approximated.

## 7. Government Dashboard Map

Full rewrite of `src/components/cards/MapPreview.tsx`, same props/call-site (`<MapPreview issues={issues} />` in `government/page.tsx`, unchanged):

- **Before**: marker position = `hashPosition(issue.id)` — a hash of the report's UUID, completely unrelated to its real location. Fixed "Zone 2" dashed rectangle. Three heat-zone circles at hardcoded coordinates, identical on every single render regardless of data.
- **After**: only reports with a *validated* latitude/longitude (`src/lib/location/validation.ts`) are plotted, via a real min/max bounding-box projection (`src/lib/location/projection.ts`) — the relative positions between markers now genuinely reflect their relative real-world geography (though there's still no real basemap/tiles underneath, since none is configured). When **zero** visible issues have coordinates, an honest empty state renders instead: "Not enough location data to generate this view," with an accurate reason. The old fake heat zones are replaced by a real density grid, binned from the same real coordinates. Added priority/status/category filters (client-side, over the same already-RLS-scoped `issues` list — a UI convenience, not a new authorization boundary). Added a "View issue →" link on the marker popover, and a caption stating exactly how many of the filtered issues actually have coordinates.
- **Verified live** (screenshots taken during this session): with the seeded government test account, all visible issues currently lack GPS coordinates (they were entered via the manual flow), so the map correctly shows the honest empty state — proof it does not fabricate positions when data is missing.

## 8. Location Search

Not implemented — see §4. The existing structured/manual flow is fully functional and was not gated on this.

## 9. GPS / Current Location

`src/components/report/SmartLocationField.tsx`, backed by new pure modules `src/lib/location/gps.ts` and `validation.ts`:

- Distinguishes `PERMISSION_DENIED` / `POSITION_UNAVAILABLE` / `TIMEOUT` / unsupported-browser with a specific, correct message for each (previously: one generic message for all of them).
- `getCurrentPosition` now called with `{ enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }` — never a stale cached fix.
- Captures `pos.coords.accuracy` and displays "±X m" both during confirmation and after ("GPS location: 16.23330, 80.04990 (accuracy: approximately 15 m)" / "Location confirmed — 16.23330, 80.04990 (±15 m)").
- Coordinates are sanitized (`sanitizeCoordinates`) before ever being stored in component state or emitted to the parent form — an invalid GPS fix is discarded, never coerced into `(0, 0)`.
- Duplicate-request guard: the existing `gpsLoading`-disabled button plus a defensive early-return inside the handler itself.
- **Verified live** via Playwright's real `context.setGeolocation`/`grantPermissions` (genuine Chromium Geolocation API, not a stub): a granted-permission run shows the real coordinates and accuracy and confirms correctly; a denied/unavailable run shows the correct manual-fallback message and the citizen can still complete the form via the dropdowns.
- **Also verified live in the browser preview, post-migration**: a GPS fix showed "GPS location: 16.50620, 80.64800 (accuracy: approximately 22 m)" and, after confirming, "Location confirmed — 16.50620, 80.64800 (±22 m)"; a simulated permission denial showed the exact distinct message "Location permission was denied. You can search or select the location manually." — never the old generic fallback. Both screenshots taken during this session.

## 10. Database Changes

`supabase/migrations/0010_phase6b_location_intelligence.sql` — **applied to the live Supabase project and verified.**

- `alter table report_locations add column if not exists accuracy_meters double precision;` — nullable, additive.
- Three `CHECK` constraints (`report_locations_latitude_range`, `_longitude_range`, `_accuracy_nonnegative`) — defense in depth alongside the application-level validation; only bound the value when present (both columns stay nullable).
- No `drop`, no `delete`, no destructive statement. Migrations 0001–0009 untouched.

**A real bug was caught and fixed before this shipped:** the first version of `src/lib/actions/reports.ts` included `accuracy_meters` directly in the initial `report_locations` insert. Before the migration was applied, that would have failed the *entire* report-creation flow (not just the accuracy field) with "column does not exist." Verified directly against the live database at the time, then fixed by moving `accuracy_meters` into a separate, best-effort `UPDATE` that can never block report creation — re-verified live both before and after the migration.

### Post-migration live verification

Ran a new read-only-by-default script, `scripts/verify-phase6b-live.mjs` (same style as `verify-phase6a-live.mjs`), which behaviorally proves the constraints work (not just that they exist) via three disposable, self-cleaning fixture inserts:

```
PASS - report_locations.accuracy_meters exists
PASS - Out-of-range latitude (999) is rejected by the database CHECK constraint (new row for relation "report_locations" violates check constraint "report_locations_latitude_range")
PASS - Out-of-range longitude (-200) is rejected by the database CHECK constraint (new row for relation "report_locations" violates check constraint "report_locations_longitude_range")
PASS - Negative accuracy_meters (-5) is rejected by the database CHECK constraint (new row for relation "report_locations" violates check constraint "report_locations_accuracy_nonnegative")
PASS - A fully valid location (including real accuracy_meters) inserts successfully
PASS - A manual location with no coordinates still inserts successfully (core flow unaffected)
PASS - Existing tables still readable with historical data intact (reports=32, ai_analyses=13, report_locations=32)

7/7 passed.
```

Also verified via a real, full live submission through the actual `/report` UI (not a script) — a GPS-tagged report was created end-to-end and the resulting `report_locations` row confirmed directly in the database:

```json
{
  "latitude": 16.5062,
  "longitude": 80.648,
  "accuracy_meters": 22,
  "location_source": "gps"
}
```

This is the first real proof that the full write path — client GPS capture → validation → server-side re-validation → `report_locations` insert → separate best-effort `accuracy_meters` update — works end-to-end against the live, post-migration schema. The test report was deleted afterward to keep the database clean.

## 11. Security

- `GOOGLE_MAPS_API_KEY` (whenever configured) never reaches client code — `reverse-geocoding.ts` is `"server-only"`, and the only way to call it is the server action `attemptReverseGeocode`.
- Coordinates are validated **server-side** (`performCreateReport` in `reports.ts`) regardless of what the client sends — the client-side validation in `SmartLocationField` is a UX convenience, not the security boundary.
- No RLS policy was touched. Government/department jurisdiction scoping remains entirely server-side (existing policies from migration `0002`); the new map filters are client-side conveniences over an already-authorized, already-bounded `issues` list — never a substitute for authorization.
- No precise-location logging added; existing signed-URL media protection is untouched.

## 12. Performance

- Reverse geocoding is called at most once per confirmed GPS fix (not on every render, not repeated for the same coordinates) — moot today since it's a no-op unavailable check, but the discipline is in place for when a real provider is added.
- The map's projection/density computation runs client-side over the already-fetched, already-bounded `issues` array (same data source as before) — no new database queries, no N+1 patterns.
- No new external network calls of any kind are made by default (no provider configured).

## 13. Accessibility

- GPS failure messages use `role="alert"`; the in-progress GPS/address status text uses `aria-live="polite"`.
- Map priority/status/category filters have explicit `aria-label`s (they're icon/text-free bare selects).
- Markers retain their existing `aria-label`/`aria-pressed` wiring.
- The map is never the only way to select a location — the structured dropdown flow works fully independently, as before.

## 14. Mobile

Verified live at 375×812 (iPhone-class width) via the browser preview: the "Use my current location" / "Choose on map" buttons, jurisdiction dropdowns, and reporter-details fields all render with comfortable touch targets and no horizontal overflow. No structural changes were needed.

## 15. Tests

```
Lint:        ✅ 0 errors, 1 pre-existing unrelated warning (test/fake-supabase.ts)
Typecheck:   ✅ npx tsc --noEmit — no errors
Unit tests:  ✅ npm run test — 13 files, 118/118 passed (91 pre-existing + 27 new:
             validation.test.ts, gps.test.ts, projection.test.ts)
Build:       ✅ npm run build — compiled successfully, all 18 routes generated
E2E:         ✅ e2e/location.spec.ts — all 3 new tests pass (real Playwright geolocation
             mocking for GPS grant/deny, government map honest-state check)
             ✅ e2e/report-upload.spec.ts — 4/4 passed after the citizen rate-limit
             window reset (a real Gemini 429 was handled gracefully in test 1,
             confirming the pre-existing AI-failure-tolerant design still holds)
```

New unit coverage: coordinate bounds (valid/invalid/NaN/Infinity), accuracy bounds, "never a `(0,0)` fallback," every `GeolocationPositionError` code mapped to a distinct message (never one generic message), geolocation options (`maximumAge: 0`, `enableHighAccuracy: true`), bounding-box computation, lat/lng→percent projection (single point centers, north-above-south, east-right-of-west, always within the padded surface), and density-grid binning.

## 16. Known Limitations

- **No real map tiles / forward-geocoding search / reverse geocoding / administrative boundaries** — all four are 🔵 BLOCKED on an external provider that isn't configured. Abstractions are built and ready; nothing is faked.
- **Location search UI was not built** on top of the existing `demo-locations.ts` dataset, per the spec's explicit instruction not to present demo data as if it were real search — that module remains dead/unused code, documented as such.
- **The Playwright "GPS permission denied" test relies on Chromium's default automation behavior** (no permission = denied) rather than an explicit "deny" API, since Playwright doesn't expose one directly — this is still a genuine denial path through the real browser API, just not one we can force with 100% certainty across all Playwright/Chromium versions.
- (Resolved) `e2e/report-upload.spec.ts` — re-run after the citizen `create_report` rate-limit window reset; now 4/4 clean, confirming the earlier 3 failures were exactly the already-diagnosed shared-quota exhaustion (§18), not a Phase 6B regression.

## 17. BLOCKED External Capabilities

| Capability | Status | What's missing | Free/low-cost option | Notes |
|---|---|---|---|---|
| Map tiles | 🔵 BLOCKED | No provider configured | Mapbox (free tier ~50k loads/mo), Leaflet + OpenStreetMap tiles (free, attribution required), Google Maps (paid beyond a small free tier) | Provider-agnostic marker layer already built; a real tile layer can be dropped underneath without touching marker logic |
| Forward geocoding / search | 🔵 BLOCKED | No provider configured | Google Places/Geocoding API, Mapbox Geocoding, OpenStreetMap Nominatim (free, rate-limited, requires a User-Agent + usage policy compliance) | No code depends on this being available |
| Reverse geocoding | 🔵 BLOCKED | `GOOGLE_MAPS_API_KEY` unset | Same providers as above | Abstraction fully wired (§5) — only the provider call itself is missing |
| Administrative boundaries / jurisdiction inference | 🔵 BLOCKED | No boundary dataset | India-specific: Survey of India / data.gov.in boundary shapefiles; generic: OpenStreetMap boundary relations via Overpass API | Would require real spatial data + a spatial query, a materially larger effort than this phase |

## 18. Final Verification

- `npm run lint`, `npx tsc --noEmit`, `npm run test`, `npm run build` — all clean (§15), re-confirmed after the migration was applied.
- `npx playwright test location.spec.ts` — 3/3 passed.
- `npx playwright test report-upload.spec.ts` — 4/4 passed after the citizen `create_report` rate-limit window reset (the earlier 3 failures were exactly that shared-quota exhaustion, now proven by this clean re-run, not a Phase 6B code issue).
- Live browser verification: Government Dashboard map (real empty state confirmed, then a real GPS-tagged marker's data confirmed end-to-end after the migration, filters work, zero console/server errors beyond the pre-existing sandbox HMR websocket quirk noted in the Phase 6A report), report form location step at desktop and mobile width, GPS grant/deny flows via both Playwright and a live browser smoke test, `accuracy_meters` persistence confirmed directly in the database.
- Migration `0010` applied to the live project and verified 7/7 via `scripts/verify-phase6b-live.mjs`, including behavioral proof (not just schema presence) that all three CHECK constraints actually reject invalid data.
- Re-ran `scripts/verify-phase6a-live.mjs` after the migration and all Phase 6B changes — still 7/7, confirming Phase 6A's schema, functions, and data remain completely unaffected.
- A real bug (the `accuracy_meters` pre-migration insert failure, §10) was found and fixed during this rollout, verified both before and after the migration.

## 19. Phase 6B Status

🟢 **COMPLETE** — migration `0010` is applied and live-verified; every in-scope capability (coordinate validation, GPS UX, reverse-geocoding wiring, the government map rewrite, notification-free regression of Phase 6A) is implemented, tested, and confirmed live end-to-end, including a real GPS-tagged report round-tripping through the full stack with `accuracy_meters` persisted. Every external mapping/geocoding capability (map tiles, forward geocoding, reverse geocoding, administrative boundaries) is honestly marked 🔵 BLOCKED rather than faked (§17) — none is required for Phase 6B's own acceptance criteria. No Phase 6C work was started as part of this phase.
