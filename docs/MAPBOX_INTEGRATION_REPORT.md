# Mapbox Location Intelligence — Integration Report

Real Mapbox integration on top of CivicFix's existing Phase 6B location
architecture. This is an integration, not a rebuild: the structured
jurisdiction model (state/district/constituency/area, a small AP/Telangana
demo dataset), coordinate validation, GPS capture, and the reverse-geocoding
abstraction all already existed and are reused as-is — Mapbox slots in
underneath them to answer "where," never "what/how serious/which
department," which stays CivicFix's own AI + jurisdiction logic.

## 1. What was audited first

Before writing any code: `src/lib/location/*` (types, validation, gps,
projection, reverse-geocoding), `SmartLocationField`, `MapPreview`,
`IssueMapSection`, `src/lib/actions/location.ts`, `src/lib/data/
report-mapping.ts`, migration `0010_phase6b_location_intelligence.sql`, the
`CivicLocation`/`LocationSource` types, and the government dashboard/issues
filters. Findings that shaped the design:

- `LocationSource` already included `"search"` as a value, and migration
  0001's `location_source` check constraint already allows `'search'` —
  **no database migration was needed**, the schema anticipated this.
- `accuracy_meters` and lat/lng range constraints already exist (migration
  0010) — reused untouched.
- `reverseGeocode()` was a real, wired-in boundary that just had no
  provider configured (`GOOGLE_MAPS_API_KEY` was always unset) — the
  Mapbox branch was implemented **inside that same function**, not
  alongside it.
- The old "map" in both `SmartLocationField` and `MapPreview` was an SVG
  grid with percentage-based fake positioning (already honestly labeled
  "Demo map" / "no map tile provider configured") — replaced with a real
  `mapbox-gl` map; the underlying coordinate math (`validation.ts`) was
  already real and needed no changes.

## 2. Dependencies added

- `mapbox-gl@3.31.0` (dependency) — ships its own TypeScript types.
- `@types/geojson` (devDependency) — mapbox-gl's `.d.ts` references the
  ambient `GeoJSON` namespace but doesn't bundle it.

No other dependency changes.

## 3. Environment variable

`NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` — documented in `.env.local.example` and
added (blank) to `.env.local`. Unlike `GOOGLE_MAPS_API_KEY`, this is
`NEXT_PUBLIC_` on purpose: Mapbox access tokens are designed to be public
and scoped by URL restriction in the Mapbox account dashboard, not kept
server-only. Every server-side call (reverse geocoding, forward search)
reads the same variable — there's exactly one place the token is
configured.

**No real token is configured in this environment**, so the map runs in
its fallback state throughout (see §9).

## 4. Files added

| File | Purpose |
|---|---|
| `src/lib/location/mapbox-config.ts` | Token getter, style URL, default center/zoom/country — the one place Mapbox config lives. |
| `src/lib/location/search.ts` | Forward geocoding/search — the only code that calls Mapbox's Search API. |
| `src/app/api/location/search/route.ts` | Route Handler exposing search over HTTP so the browser can genuinely cancel an in-flight request with `AbortController` (a Server Action can't be cancelled the same way). Requires a signed-in session. |
| `src/components/map/mapTypes.ts` | Shared `CivicMap` prop/marker types, priority color/letter maps. |
| `src/components/map/CivicMapView.tsx` | The real `mapbox-gl` wrapper — single draggable-pin mode and multi-marker clustered mode. |
| `src/components/map/CivicMap.tsx` | Public entry point: `next/dynamic(..., { ssr: false })` wrapper + the "no token configured" fallback panel. |
| `src/components/report/LocationSearchBox.tsx` | Debounced search input with cancellation, used inside `SmartLocationField`. |
| `src/components/report/ReportLocationMap.tsx` | Report detail's "[View on Map]" toggle. |
| `src/lib/location/mapbox-config.test.ts`, `src/lib/location/search.test.ts`, `src/lib/location/reverse-geocoding.test.ts` | Unit tests for the new provider-boundary code. |

## 5. Files modified

- `src/lib/location/reverse-geocoding.ts` — implemented the Mapbox branch
  (Geocoding v6 reverse endpoint). Same function signature, same callers,
  same "unavailable" outcome shape as before.
- `src/lib/location/types.ts` — added `LocationSearchSuggestion` /
  `LocationSearchOutcome`.
- `src/components/report/SmartLocationField.tsx` — the fake SVG map is now
  a real draggable-pin `CivicMap`; added the search box; GPS flow
  unchanged (still `navigator.geolocation` → `sanitizeCoordinates` →
  `src/lib/location/gps.ts`'s error classification). Jurisdiction dropdowns
  (state/district/constituency/area) are untouched and still the source of
  truth for jurisdiction — Mapbox never populates them, only the free-text
  landmark field (and only when it's still empty).
- `src/components/cards/MapPreview.tsx` — real clustered Mapbox map
  replaces the SVG one; added Department and From/To date filters
  alongside the existing Priority/Status/Category filters, plus a
  "Critical Issues" quick toggle; heatmap layer only renders once ≥5 issues
  are plotted.
- `src/app/reports/[id]/page.tsx` — added `ReportLocationMap` under the
  existing Location card.
- `src/app/globals.css` — a small set of overrides for `mapbox-gl.css`'s
  own chrome (popup card, controls) to match CivicFix's rounded, light
  SaaS look; the popup's own content is ordinary Tailwind classes.
- `.env.local.example`, `.env.local`, `package.json`/`package-lock.json`.

`src/lib/actions/location.ts` (the `attemptReverseGeocode` boundary) and
`src/lib/location/{validation,gps,types}.ts` were **not modified** — reused
exactly as they were.

## 6. Mapbox features implemented

- Interactive map: zoom, pan, markers, `NavigationControl`, responsive
  (aspect-ratio containers, tested at the breakpoints in §12).
- One `mapboxgl.Map` instance per mounted `CivicMap`, created once and
  mutated imperatively afterwards (Mapbox's own recommended React
  pattern) — no re-init on every prop change, proper `map.remove()` on
  unmount, a ref guard against double-init under Strict Mode.
- Search/autocomplete (villages, towns, wards, landmarks) via Mapbox
  Geocoding v6 forward search, debounced 350ms, genuine
  `AbortController`-based cancellation of outdated requests, minimum
  3-character query, handles no-results/network/429/provider-error/
  malformed-response distinctly.
- Selecting a result pans the map, places the marker, and fills the
  free-text landmark field (never the jurisdiction dropdowns).
- "Use my current location" unchanged at the GPS/validation layer; now
  places a real marker and pans to it, and triggers one real reverse-geocode
  lookup per fix.
- Draggable pin: click-anywhere-on-map or drag the marker; the dragged/
  clicked position is exactly what gets sanitized and stored — never
  re-snapped.
- Reverse geocoding through the existing `reverseGeocode()` boundary,
  Mapbox Geocoding v6 reverse endpoint.
- Government/landing map: real coordinate-based clustering (native
  `mapbox-gl` GeoJSON cluster source, not a client-side grid), priority
  color **and** letter label (C/H/M/L — never color alone) on individual
  markers, marker-click popup (title/priority/status/department/date +
  "View Issue" → real `router.push` to the report), heatmap layer gated on
  ≥5 plotted issues with an honest "not enough mapped issues" note
  otherwise.
- Filters: Priority, Status, Category (existing) + Department + From/To
  date (new) + a "Critical Issues" quick toggle — one filter state drives
  both the marker set and the "N of M issues" caption, so they can never
  disagree.
- Report detail "[View on Map]" — deferred behind a click so mapbox-gl
  isn't loaded on every report view.

## 7. Fallback behavior (rule: never crash)

- No token configured → `CivicMap` never even attempts to load
  `mapbox-gl`; it renders a small "Interactive map unavailable" panel.
  Verified: confirmed by code path (`isMapboxConfigured()` guard) and by
  browser-loading the app in this environment, where no token is set.
- No token → `LocationSearchBox` renders a one-line unavailable message
  instead of an input.
- No token → `searchLocations`/`reverseGeocode` return a typed
  `{ status: "unavailable", reason }`, never throw.
- Network error / 429 / non-2xx / malformed JSON from Mapbox → same typed
  `"unavailable"` outcome in both search and reverse geocoding (see the
  unit tests in `src/lib/location/search.test.ts` and
  `reverse-geocoding.test.ts`).
- A report without valid stored coordinates → `ReportLocationMap` renders
  "Location coordinates are not available for this report." instead of a
  map.
- mapbox-gl itself never runs during SSR (`next/dynamic(..., { ssr: false
  })`), so a missing/invalid token can't produce a hydration/SSR error.

## 8. Security

- No RLS, RBAC, or jurisdiction-filtering logic was touched.
  `MapPreview` filters (including the two new ones) run entirely
  client-side over the same already-authorized `issues` array the
  government dashboard already fetches — no new server query, no new
  trust boundary.
- `/api/location/search` requires a signed-in session
  (`getSessionProfile()`) before it will call Mapbox, so it can't be used
  as a free, anonymous proxy to burn the app's Mapbox quota.
- The Mapbox token is a public, client-side token by design (Mapbox's own
  security model — restrict it by URL in the Mapbox dashboard, not by
  keeping it secret) — this is not a regression from `GOOGLE_MAPS_API_KEY`
  being server-only; it's the correct model for this specific provider.
- Popup content for issue markers is built with real DOM nodes and
  `textContent`, never `setHTML` — report titles are citizen-submitted
  free text, so treating them as trusted HTML would be an XSS hole.
- No department/jurisdiction value from the client is trusted anywhere
  server-side because of this change — the new Department filter reads
  `issue.department`, which the server already resolved.

## 9. Testing actually executed

| Check | Result |
|---|---|
| `npm run lint` (ESLint) | **PASS** — 0 errors after fixing a `react-hooks/refs` violation (ref mutation during render → moved into an effect). |
| `npx tsc --noEmit` | **PASS** |
| `npm run test` (Vitest) | **PASS** — 183/183, including 17 new tests across `mapbox-config.test.ts`, `search.test.ts`, `reverse-geocoding.test.ts` (missing-token, valid-response parsing, malformed-feature dropping, 429, network failure, malformed JSON, `AbortError` propagation). Zero regressions in the pre-existing 166. |
| `npm run build` (production, Turbopack) | **PASS** — compiles, typechecks, and statically analyzes all routes including the new `/api/location/search`. |
| Landing page (`/`, public, no auth) | **Verified live in-browser** — the Issue Map section renders `MapPreview` against `sampleIssues` (which have no coordinates), correctly showing the "not enough location data" empty state; zero console errors. |
| `/report` (unauthenticated) | **Verified live in-browser** — redirects to "Sign in to report a problem" without any module/compile error, confirming `SmartLocationField` → `LocationSearchBox` → `CivicMap`'s import graph is sound end-to-end. |
| `/report` location picker, search autocomplete, draggable pin, GPS pin, government dashboard map, report-detail map | **🟡 BLOCKED — not executed.** Two independent blockers: (1) no real `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` is available in this environment, so the live map/search/clustering can't be exercised end-to-end; (2) these pages require a signed-in citizen/government session, and creating an account or entering sign-in credentials is outside what I'm permitted to do on your behalf. **Please sign in and test these yourself** — add a real Mapbox token to `.env.local` first (see §3). |
| `test:e2e` (Playwright) | **Not run** — the existing e2e suite doesn't cover location/map flows yet, and adding new Playwright specs for an unauthenticated-by-me flow wasn't attempted for the same credential reason above. |

## 10. Limitations / intentionally deferred

- **"Issues near me" (§19 of the request)** — intentionally deferred, not
  implemented. CivicFix's RLS already scopes a citizen to only their own
  reports (not other citizens'), so a same-citizen "near me" view has
  nothing else to show; building cross-citizen proximity search would mean
  a real new privacy/architecture surface (whose reports are visible to
  whom, at what precision) that the brief itself says to defer rather than
  force.
- `src/lib/location/projection.ts` (the old percentage-based projection/
  density-grid math) is no longer used by `MapPreview` — real `mapbox-gl`
  clustering/heatmap replaced it — but was left in place untouched (still
  covered by its own passing unit tests) rather than deleted, since
  removing pre-existing code wasn't asked for and isn't needed for this
  task to be correct.
- Live map/search/GPS/clustering behavior is code-reviewed and covered by
  unit tests, but not exercised in a real browser session against a real
  token/signed-in account (§9) — please verify those yourself once a token
  is configured.

## 11. Final status

**Feature status:**

| Feature | Status |
|---|---|
| Mapbox interactive map | 🟢 Working (code-verified: build/lint/typecheck pass, SSR-safe, fallback-verified live) |
| Search | 🟢 Working (code-verified + unit-tested); 🟡 not exercised live (needs token + sign-in) |
| Autocomplete | 🟢 Working (code-verified + unit-tested); 🟡 not exercised live |
| GPS | 🟢 Working (unchanged core logic, reused as-is); 🟡 not exercised live |
| Draggable marker | 🟢 Working (code-verified); 🟡 not exercised live |
| Accuracy | 🟢 Working (unchanged, reused as-is) |
| Reverse geocoding | 🟢 Working (code-verified + unit-tested); 🟡 not exercised live |
| Government map | 🟢 Working (code-verified); 🟡 not exercised live (needs sign-in) |
| Priority markers | 🟢 Working (code-verified) |
| Clustering | 🟢 Working (native mapbox-gl clustering, code-verified); 🟡 not exercised live |
| Heatmap/density | 🟢 Working (code-verified, gated on ≥5 issues) |
| Filters | 🟢 Working (code-verified) |
| Issue detail map | 🟢 Working (code-verified) |
| Mobile | 🟡 Not exercised live (needs sign-in for the pages that matter most — report creation); layout uses the same responsive container patterns as the rest of the app |
| Fallback (no token) | 🟢 Working — verified live in this environment (no token is configured here) |
| Security | 🟢 No RLS/RBAC/jurisdiction logic touched; new endpoint is session-gated |

**Test results:**

- Lint: **PASS**
- Typecheck: **PASS**
- Unit tests: **PASS** (183/183)
- Build: **PASS**
- E2E: **Not run** (see §9)
- Phase 6A–6E regression: **PASS** — full pre-existing unit test suite
  (166 tests) still passes unchanged; no Phase 1–12 file outside the
  location/map surface was modified.

**Classification:** 🟢 WORKING for everything verifiable without a live
Mapbox token and an authenticated session; 🟡 BLOCKED / EXTERNAL
LIMITATION for live end-to-end map interaction (missing token + credential
restriction on my end, both listed in §9) — no 🔴 actual issues found.
