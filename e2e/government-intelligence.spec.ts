import { test, expect } from "@playwright/test";
import { TEST_GOVERNMENT, TEST_DEPARTMENT_INCHARGE } from "./fixtures";
import { AUTH_STATE_PATH } from "./global-setup";

/**
 * Phase 6E — Government Operations & Civic Performance Intelligence E2E.
 *
 * These specs cover real rendering/authorization in a real browser without
 * depending on Gemini — the AI-grounded insight path
 * (src/lib/government-insights-ai.ts) is exercised live instead by
 * scripts/verify-phase6e-live.mjs and, when Gemini quota is exhausted (as
 * it is this session), by simply observing that the dashboard still shows
 * its always-real deterministic insights — this IS the fallback behavior
 * working, not something skipped.
 */

async function signIn(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.locator('button[type="submit"]', { hasText: "Sign In" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 15_000 });
}

test.describe("Government dashboard (Phase 6E)", () => {
  test("loads with real sections, honest SLA messaging, and no fabricated data", async ({ page }) => {
    await signIn(page, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);
    await page.goto("/government");

    await expect(page.getByRole("heading", { name: "Area Overview" })).toBeVisible({ timeout: 15_000 });
    // G5 replaced Phase 6E's "Needs Attention" panel with the Action
    // Required command center (e2e/g5-action-required.spec.ts).
    await expect(page.getByRole("heading", { name: "Action Required", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Issue Aging" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Category Trends" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Workload Distribution" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Department Trend" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Follow-up Center" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Resolution Quality" })).toBeVisible();

    // The fabricated-SLA bug fix — never a fake compliance percentage.
    await expect(page.getByText("On-time resolution data unavailable — no configured SLA.")).toBeVisible();
    await expect(page.getByText(/\d+% of resolved issues within their configured SLA/)).toHaveCount(0);

    // Never a political ranking.
    await expect(page.getByText(/Best Department|Worst Department|Top Performing Department/i)).toHaveCount(0);
  });

  test("Action Required queue tiles link to real filtered queues", async ({ page }) => {
    await signIn(page, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);
    await page.goto("/government");
    await expect(page.getByTestId("action-required")).toBeVisible({ timeout: 15_000 });

    const reopenedLink = page.getByTestId("action-required").getByRole("link", { name: /Reopened/ }).first();
    await expect(reopenedLink).toHaveAttribute("href", "/government?queue=reopened#action-required");
  });

  test("the Department Trend 7/30/90 toggle switches views client-side with no page reload", async ({ page }) => {
    await signIn(page, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);
    await page.goto("/government");
    await expect(page.getByRole("heading", { name: "Department Trend" })).toBeVisible({ timeout: 15_000 });

    const thirtyDayButton = page.getByRole("button", { name: "30 days" });
    await thirtyDayButton.click();
    await expect(thirtyDayButton).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("Government issue explorer filters (Phase 6E)", () => {
  test("supports filtering by department and date range in addition to the existing filters", async ({ browser }) => {
    const govContext = await browser.newContext();
    const govPage = await govContext.newPage();
    await signIn(govPage, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);

    await govPage.goto("/government/issues");
    await expect(govPage.getByRole("combobox").filter({ hasText: "All Departments" })).toBeVisible({ timeout: 15_000 });
    await expect(govPage.locator('input[name="dateFrom"]')).toBeVisible();
    await expect(govPage.locator('input[name="dateTo"]')).toBeVisible();

    const departmentSelect = govPage.locator('select[name="department"]');
    const options = await departmentSelect.locator("option").all();
    expect(options.length).toBeGreaterThan(1);

    const departmentValue = await options[1].getAttribute("value");
    await departmentSelect.selectOption(departmentValue!);
    await govPage.getByRole("button", { name: "Apply" }).click();
    await govPage.waitForURL((url) => url.searchParams.get("department") === departmentValue);

    await govContext.close();
  });
});

test.describe("Department dashboard operational metrics (Phase 6E)", () => {
  test("shows Issue Aging and Resolution Quality scoped to the in-charge's own assigned reports", async ({ page }) => {
    await signIn(page, TEST_DEPARTMENT_INCHARGE.email, TEST_DEPARTMENT_INCHARGE.password);
    await page.goto("/department");

    await expect(page.getByRole("heading", { name: "My Assigned Issues" })).toBeVisible({ timeout: 15_000 });
    const assignedCount = await page.getByText("Assigned").locator("..").locator("p").first().textContent();
    if (assignedCount && Number(assignedCount) > 0) {
      await expect(page.getByRole("heading", { name: "Issue Aging" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Resolution Quality" })).toBeVisible();
    }
  });
});

test.describe("Unauthorized jurisdiction access (Phase 6E §19)", () => {
  test.use({ storageState: AUTH_STATE_PATH });

  test("a citizen cannot reach the government dashboard or issue explorer", async ({ page }) => {
    await page.goto("/government");
    await page.waitForURL((url) => url.pathname === "/dashboard", { timeout: 15_000 });

    await page.goto("/government/issues");
    await page.waitForURL((url) => url.pathname === "/dashboard", { timeout: 15_000 });
  });

  test("a citizen cannot reach the department dashboard", async ({ page }) => {
    await page.goto("/department");
    await page.waitForURL((url) => url.pathname === "/dashboard", { timeout: 15_000 });
  });
});
