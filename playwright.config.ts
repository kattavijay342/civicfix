import { defineConfig } from "@playwright/test";

/**
 * Phase 4 Step 10 — real browser-level E2E for the file-upload path.
 * Drives an actual Chromium instance against the real dev server, the real
 * upload code path (src/lib/actions/reports.ts), and a real Supabase test
 * project — never a mocked fetch. See e2e/README.md for prerequisites.
 */
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
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: process.env.E2E_SKIP_WEBSERVER
    ? undefined
    : {
        command: "npm run dev",
        url: process.env.E2E_BASE_URL ?? "http://localhost:3000",
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
