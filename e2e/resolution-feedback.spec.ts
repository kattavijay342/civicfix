import { test, expect, type Browser, type Page } from "@playwright/test";
import { createResolutionFeedbackFixture, type ResolutionFeedbackFixture } from "./resolution-feedback-fixture";

/**
 * Phase 6D — citizen resolution feedback / reopen E2E.
 *
 * The full submit-feedback -> reopen -> re-resolve -> re-confirm cycle
 * needs a resolved report with precise, disposable state and is exercised
 * live with the admin client (scripts/verify-phase6d-live.mjs), the same
 * pattern verify-phase6c-live.mjs used for RLS/notification proofs — far
 * more reliable than orchestrating four role logins through the UI. These
 * specs cover what Playwright verifies best: real rendering/gating in a
 * real browser, without depending on Gemini.
 *
 * Self-contained: every report and user this spec looks at is created by
 * e2e/resolution-feedback-fixture.ts in beforeAll (isolated citizen, a
 * second citizen, a government user in a synthetic jurisdiction, and a
 * resolved / routed / duplicate-flagged report) and removed in afterAll —
 * which Playwright runs even when a test fails. Nothing depends on data
 * left over from earlier runs, so no test needs a "no data" skip.
 */

let fixture: ResolutionFeedbackFixture | null = null;

function requireFixture(): ResolutionFeedbackFixture {
  if (!fixture) throw new Error("resolution-feedback fixture was not created");
  return fixture;
}

async function signedInPage(browser: Browser, email: string, password: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.locator('button[type="submit"]', { hasText: "Sign In" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 30_000 });
  return page;
}

async function openReport(page: Page, reportId: string) {
  await page.goto(`/reports/${reportId}`);
  // The report itself must actually render — an access-denied or not-found
  // page would trivially "not show the form" and prove nothing.
  await expect(page.getByRole("heading", { name: "Routing" })).toBeVisible({ timeout: 20_000 });
}

const FEEDBACK_QUESTION = "Was this issue actually resolved?";

test.describe.serial("Resolution feedback — rendering and authorization (Phase 6D)", () => {
  test.beforeAll(async () => {
    fixture = await createResolutionFeedbackFixture();
  });

  test.afterAll(async () => {
    if (fixture) await fixture.cleanup();
    fixture = null;
  });

  test("the reporter sees the resolution-feedback form on their own resolved report", async ({ browser }) => {
    const fx = requireFixture();
    const page = await signedInPage(browser, fx.citizen.email, fx.citizen.password);
    await openReport(page, fx.reports.resolved);
    await expect(page.getByText(FEEDBACK_QUESTION)).toBeVisible();
    await page.context().close();
  });

  test("the resolution-feedback form never appears on a report that isn't resolved yet", async ({ browser }) => {
    const fx = requireFixture();
    const page = await signedInPage(browser, fx.citizen.email, fx.citizen.password);
    await openReport(page, fx.reports.routed);
    await expect(page.getByText(FEEDBACK_QUESTION)).toHaveCount(0);
    await page.context().close();
  });

  test("a government viewer (not the reporter) never sees the resolution-feedback form on someone else's report", async ({
    browser,
  }) => {
    const fx = requireFixture();
    const govPage = await signedInPage(browser, fx.government.email, fx.government.password);
    // Government can VIEW the resolved report (jurisdiction-based read
    // access) but is never the original reporter, so the feedback form must
    // not render — only report.reporterId === session user renders it
    // (isOwner gate in src/app/reports/[id]/page.tsx).
    await openReport(govPage, fx.reports.resolved);
    await expect(govPage.getByText(FEEDBACK_QUESTION)).toHaveCount(0);
    await govPage.context().close();
  });
});

test.describe.serial("Duplicate/related issue card privacy (Phase 6D)", () => {
  test.beforeAll(async () => {
    fixture = await createResolutionFeedbackFixture();
  });

  test.afterAll(async () => {
    if (fixture) await fixture.cleanup();
    fixture = null;
  });

  test("a duplicate/related issue card never exposes another citizen's private details", async ({ browser }) => {
    const fx = requireFixture();
    const page = await signedInPage(browser, fx.citizen.email, fx.citizen.password);
    await openReport(page, fx.reports.withDuplicate);

    // The card really renders, and really points at the other citizen's report.
    await expect(page.getByText(/Possible Duplicate Detected|Related Issue Detected/)).toBeVisible();
    await expect(page.getByText(fx.otherReportTitle)).toBeVisible();

    // Only a title/location/category/status/reason are shown — never the
    // other reporter's identity or contact details, nor any email/phone.
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain(fx.otherCitizen.fullName);
    expect(bodyText).not.toContain(fx.otherCitizen.email);
    expect(bodyText).not.toContain(fx.otherCitizen.mobile);
    expect(bodyText).not.toContain(fx.otherCitizen.mobile.replace("+91", ""));
    expect(bodyText).not.toMatch(/@test\.civicfix\.local/);
    expect(bodyText).not.toMatch(/\+91\d{10}/);
    await page.context().close();
  });
});
