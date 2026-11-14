import { defineConfig } from "@playwright/test";
import { requireLocalSupabaseEnv } from "./e2e/local-supabase-guard";

/**
 * Phase 4 Step 10 — real browser-level E2E for the file-upload path.
 * Drives an actual Chromium instance against the real dev server, the real
 * upload code path (src/lib/actions/reports.ts), and a real Supabase test
 * project — never a mocked fetch. See e2e/README.md for prerequisites.
 *
 * LOCAL Supabase only (G8): this config is evaluated before the dev server
 * starts and in every worker, so the guard below makes the whole suite —
 * specs, global setup and the `npm run dev` server it launches (which
 * inherits this process's env, and Next.js never overrides an env var that
 * is already set with a .env.local value) — run against
 * http://127.0.0.1:54321 / http://localhost:54321 with the local CLI keys,
 * or not at all. It loads .env.g8-local, never .env.local.
 */
requireLocalSupabaseEnv();

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const base = new URL(BASE_URL);
if (!["localhost", "127.0.0.1"].includes(base.hostname)) {
  throw new Error(`ABORT (local-only guard): E2E_BASE_URL must be a local app server, got ${BASE_URL}`);
}
if (process.env.E2E_SKIP_WEBSERVER) {
  // An externally started server's Supabase env can't be verified here.
  throw new Error("ABORT (local-only guard): E2E_SKIP_WEBSERVER is not allowed — Playwright must start the dev server with the local env.");
}

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // Generous — report creation makes a real Gemini API call (with its own
  // internal retries, see analyzeWithRetry in src/lib/actions/reports.ts),
  // which can occasionally take a while. AI failure is non-fatal to report
  // creation either way, so this suite never depends on it succeeding fast.
  timeout: 90_000,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    // Never attach to an already-running server: its Supabase env (possibly
    // the hosted .env.local) can't be verified. A busy port fails the run.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
