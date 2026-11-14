/**
 * LOCAL-Supabase-only guard for E2E specs. All logic lives in
 * scripts/lib/local-supabase-guard.mjs (shared with the verification
 * scripts); this file only re-exports it for Playwright.
 *
 * Specs call `requireLocalSupabaseEnv()` at import time instead of the old
 * `process.loadEnvFile(".env.local")`: it loads `.env.g8-local` (never
 * `.env.local`) when the env isn't already set, accepts only
 * http://127.0.0.1:54321 / http://localhost:54321 with the local CLI's demo
 * keys, and throws — failing the whole spec file — for anything else.
 */
export {
  LOCAL_ENV_FILE,
  assertLocalSupabaseUrl as assertLocalSupabase,
  localSupabaseEnvProblems,
  localSupabaseKeyProblem,
  localSupabaseUrlProblem,
  requireLocalSupabaseEnv,
} from "../scripts/lib/local-supabase-guard.mjs";
