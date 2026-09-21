# Browser E2E tests (Phase 4 Step 10)

Real Playwright/Chromium tests against the actual dev server, the actual
`createReport` Server Action, and a real Supabase project — nothing here is
mocked. Scope: the file-upload path (`report-upload.spec.ts`) — valid image
upload end-to-end, oversized-file rejection, MIME-spoofing rejection,
non-image client-side handling, and that an uploaded evidence photo is only
reachable through a signed URL.

## Prerequisites

1. `.env.local` configured with a real Supabase project (same one the app
   already uses for `npm run dev`).
2. Seeded test accounts exist:
   ```
   node --env-file=.env.local scripts/seed-test-accounts.mjs
   ```
   (idempotent — safe to re-run). This creates
   `citizen1@test.civicfix.local` / `CivicFixTest2026!`, which this suite
   signs in as.
3. Playwright's browser binaries installed once:
   ```
   npx playwright install chromium
   ```

`GEMINI_API_KEY` does not need to be configured for this suite — report
creation already treats an AI failure as non-fatal, and these tests only
assert on the upload path.

## Running

```
npm run test:e2e
```

This starts `npm run dev` automatically (see `playwright.config.ts`) and
reuses it if already running. Point it at an already-running server with:

```
E2E_BASE_URL=http://localhost:3000 E2E_SKIP_WEBSERVER=1 npm run test:e2e
```

## Why this is separate from `npm test`

`npm test` (vitest) covers pure logic with no live service. This suite
needs a real browser, a real running server, and a real Supabase project —
it's slower and has external prerequisites, so it's kept as its own command
rather than bundled into the default test run / CI's fast path.
