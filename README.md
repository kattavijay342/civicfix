# CivicFix

Citizen civic-issue reporting with AI-assisted triage, jurisdiction-aware
routing to department in-charges, a government analytics dashboard, and
citizen verification of resolutions.

**Stack:** Next.js 16 (App Router, `proxy.ts`), React 19, Tailwind CSS 4,
Supabase (Postgres + Auth + Storage, RLS on every table), Google Gemini
(report analysis, optional), Mapbox (maps/geocoding, optional), Vitest and
Playwright.

## Roles

| Role | Home | Can do |
| --- | --- | --- |
| `citizen` | `/dashboard` | Report issues (photo + location), track status, follow up, set reminders, verify or reject a resolution |
| `department_incharge` | `/department` | Work reports routed to their department and jurisdiction: acknowledge, progress, resolve with after-photo |
| `government` | `/government` | Jurisdiction analytics, issue list, incidents (clustered reports) |
| `admin` | `/admin` | Create departments, provision government/in-charge accounts, change roles |

Self sign-up always creates a `citizen`; other roles are provisioned by an
admin (see migration `0015_g1_signup_role_lockdown.sql`).

## Local setup

```bash
npm install
cp .env.local.example .env.local   # then fill in values
npm run dev
```

Environment variables (see `.env.local.example`):

| Variable | Required | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase project API settings |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-only. Never prefix with `NEXT_PUBLIC_` |
| `GEMINI_API_KEY` | no | Without it reports are still created and routed by category; AI analysis shows as unavailable with a retry button |
| `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` | no | Without it location falls back to GPS + manual entry |
| `CRON_SECRET` | for reminders | Authorizes `/api/cron/reminders`; the endpoint refuses all calls when unset |

## Database

Migrations live in `supabase/migrations` and are additive only. Apply them
in order (`npx supabase db push` on a linked project, or the SQL editor),
then `supabase/seed.sql` for the department list. See
`supabase/migrations/README.md`.

## Tests

```bash
npm test            # Vitest unit/integration suite (no live services)
npx tsc --noEmit    # type check
npm run lint
npm run build
```

Browser E2E (`npm run test:e2e`) runs **only against a local Docker
Supabase stack** — the Playwright config refuses any other target. Start
Docker Desktop, then:

```bash
npx supabase start
node --env-file=.env.g8-local scripts/seed-test-accounts.mjs --local
npx playwright install chromium
npm run test:e2e
```

`.env.g8-local` holds the local stack's URL/keys from `npx supabase status`
(see `e2e/README.md`).

## Deployment (Vercel)

1. Set every variable above in the Vercel project (Production + Preview).
2. In Supabase → Authentication → URL Configuration, add
   `https://<your-domain>/auth/callback` to Redirect URLs. The production
   origin used in auth emails is set in `src/lib/auth-redirect.ts`.
3. `vercel.json` schedules the reminder cron daily (Hobby-plan limit);
   Vercel sends `CRON_SECRET` automatically.
