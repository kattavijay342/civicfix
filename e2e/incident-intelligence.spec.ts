import { test, expect } from "@playwright/test";
import { TEST_GOVERNMENT } from "./fixtures";
import { AUTH_STATE_PATH } from "./global-setup";

/**
 * Civic Incident Intelligence E2E. Kept independent of Gemini (like
 * government-intelligence.spec.ts) — the AI-confirmation band
 * (src/lib/incident-ai-confirm.ts) is covered live by manual verification
 * and by scripts/verify-incident-intelligence-live.mjs, not gated in CI.
 *
 * Every assertion here is written to hold BOTH before and after migration
 * 0014 is applied: getIncidentList()/getCitizenIncidentNote() degrade to
 * an honest empty result on a missing-RPC error rather than throwing
 * (src/lib/data/incidents.ts), so these pages never crash regardless of
 * migration state — that resilience is itself part of what's being tested.
 */

async function signIn(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.locator('button[type="submit"]', { hasText: "Sign In" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 15_000 });
}

test.describe("Government dashboard — Civic Incidents section", () => {
  test("shows a Civic Incidents section without crashing", async ({ page }) => {
    await signIn(page, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);
    await page.goto("/government");
    await expect(page.getByRole("heading", { name: "Civic Incidents", exact: true })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("Government incidents list page", () => {
  test("loads with filters and an honest empty state when there's nothing to show", async ({ page }) => {
    await signIn(page, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);
    await page.goto("/government/incidents");

    await expect(page.getByRole("heading", { name: "Civic Incidents", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('select[name="status"]')).toBeVisible();
    await expect(page.locator('select[name="priority"]')).toBeVisible();
    await expect(page.locator('select[name="category"]')).toBeVisible();
    await expect(page.locator('select[name="department"]')).toBeVisible();

    // Either a real incident grid or the honest "no incidents yet" empty
    // state — never a raw error/crash.
    const hasEmptyState = await page.getByText("No civic incidents yet").isVisible().catch(() => false);
    const hasCards = await page.locator('a[href^="/government/incidents/"]').first().isVisible().catch(() => false);
    expect(hasEmptyState || hasCards).toBe(true);
  });
});

test.describe("Unauthorized access to incidents", () => {
  test.use({ storageState: AUTH_STATE_PATH });

  test("a citizen cannot reach the incidents list", async ({ page }) => {
    await page.goto("/government/incidents");
    await page.waitForURL((url) => url.pathname === "/dashboard", { timeout: 15_000 });
  });

  test("a citizen cannot reach an incident detail page", async ({ page }) => {
    await page.goto("/government/incidents/00000000-0000-0000-0000-000000000000");
    await page.waitForURL((url) => url.pathname === "/dashboard", { timeout: 15_000 });
  });
});
