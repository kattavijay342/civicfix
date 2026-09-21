import { test, expect } from "@playwright/test";
import { TEST_GOVERNMENT } from "./fixtures";
import { AUTH_STATE_PATH } from "./global-setup";

/**
 * Phase 6D — citizen resolution feedback / reopen E2E.
 *
 * The full submit-feedback -> reopen -> re-resolve -> re-confirm cycle
 * needs a resolved report with precise, disposable state and is exercised
 * live with the admin client (scripts/verify-phase6d-live.mjs), the same
 * pattern verify-phase6c-live.mjs used for RLS/notification proofs — far
 * more reliable than orchestrating four role logins through the UI. These
 * specs cover what Playwright verifies best: real rendering/gating in a
 * real browser, without depending on Gemini or fragile shared fixtures.
 */

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test.describe("Resolution feedback — rendering and authorization (Phase 6D)", () => {
  test.use({ storageState: AUTH_STATE_PATH });

  test("the resolution-feedback form never appears on a report that isn't resolved yet", async ({ page }) => {
    // A freshly created report starts at REPORTED — no Gemini call needed
    // to reach this state (the AI step is a separate, later action).
    await page.goto("/report");
    await page.locator("#description").fill(`E2E resolution-feedback gating test ${RUN_ID}`);
    await page.getByRole("button", { name: "Road / Pothole" }).click();
    await page.locator("#loc-state").selectOption("Andhra Pradesh");
    await page.locator("#loc-district").selectOption("Palnadu");
    await page.locator("#loc-constituency").selectOption("Gurazala");
    await page.locator("#loc-area").fill(`E2E-Loc-${RUN_ID}`);
    await page.locator("#loc-area").blur();
    await expect(page.getByText("Location identified")).toBeVisible();

    await page.getByRole("button", { name: "Continue to Review" }).click();
    await expect(page.getByRole("heading", { name: "Review your report" })).toBeVisible();
    await page.getByRole("button", { name: "Analyze with AI" }).click();

    // Whether AI succeeds or gracefully degrades (Gemini quota), the report
    // itself is created and reachable — confirmed by either outcome's own
    // real UI text, not asserted further here since AI's own behavior is
    // covered by Phase 6A's own regression, not this spec.
    await expect(
      page.getByText(/Report saved|AI analysis is temporarily unavailable|Complaint Generated/i).first()
    ).toBeVisible({ timeout: 20_000 });

    await expect(page.getByText("Was this issue actually resolved?")).toHaveCount(0);
  });

  test("a government viewer (not the reporter) never sees the resolution-feedback form on someone else's report", async ({
    browser,
  }) => {
    const citizenContext = await browser.newContext({ storageState: AUTH_STATE_PATH });
    const citizenPage = await citizenContext.newPage();
    await citizenPage.goto("/dashboard/reports?status=RESOLVED");
    const firstResolvedLink = citizenPage.getByRole("link", { name: /View details for/ }).first();
    const hasResolvedReport = (await firstResolvedLink.count()) > 0;
    test.skip(!hasResolvedReport, "No resolved report exists for the seeded citizen in this environment.");
    const href = await firstResolvedLink.getAttribute("href");
    await citizenContext.close();

    const govContext = await browser.newContext();
    const govPage = await govContext.newPage();
    await govPage.goto("/sign-in");
    await govPage.getByLabel("Email").fill(TEST_GOVERNMENT.email);
    await govPage.getByLabel("Password").fill(TEST_GOVERNMENT.password);
    await govPage.locator('button[type="submit"]', { hasText: "Sign In" }).click();
    await govPage.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 15_000 });

    await govPage.goto(href!);
    // Government can VIEW the report (jurisdiction-based read access) but
    // is never the original reporter, so the feedback form must not render
    // — only report.reporterId === session user renders it (isOwner gate
    // in src/app/reports/[id]/page.tsx).
    await expect(govPage.getByText("Was this issue actually resolved?")).toHaveCount(0);
    await govContext.close();
  });
});

test.describe("Duplicate/related issue card privacy (Phase 6D)", () => {
  test.use({ storageState: AUTH_STATE_PATH });

  test("a duplicate/related issue card, when shown, never exposes another citizen's private details", async ({
    page,
  }) => {
    await page.goto("/dashboard/reports");
    const links = page.getByRole("link", { name: /View details for/ });
    const count = await links.count();
    test.skip(count === 0, "No reports exist for the seeded citizen in this environment.");

    // Collect every href up front — navigating away invalidates `links`
    // against the list page's DOM, so re-querying `.nth(i)` after the first
    // goto() would hang waiting for an element that no longer exists there.
    const hrefs: string[] = [];
    for (let i = 0; i < Math.min(count, 15); i++) {
      hrefs.push((await links.nth(i).getAttribute("href"))!);
    }

    let found = false;
    for (const href of hrefs) {
      if (found) break;
      await page.goto(href);
      const duplicateCard = page.getByText(/Possible Duplicate Detected|Related Issue Detected/);
      if (await duplicateCard.count()) {
        found = true;
        const cardText = await page.locator("body").innerText();
        // Only ever a title/location/category/status/reason are shown — no
        // email/phone pattern should ever appear inside the card's text.
        expect(cardText).not.toMatch(/@test\.civicfix\.local/);
        expect(cardText).not.toMatch(/\+91\d{10}/);
      }
    }
    test.skip(!found, "No duplicate/related report exists for the seeded citizen in this environment.");
  });
});
