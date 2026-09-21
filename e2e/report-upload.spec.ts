import { test, expect, type Page } from "@playwright/test";
import { tinyJpegBuffer, spoofedNotAnImageBuffer, oversizedJpegBuffer } from "./fixtures";
import { AUTH_STATE_PATH } from "./global-setup";

/**
 * Phase 4 Step 10 — real browser file-upload E2E.
 *
 * Prerequisites (see e2e/README.md):
 *   1. `node --env-file=.env.local scripts/seed-test-accounts.mjs` has been
 *      run at least once against the project's Supabase instance, so
 *      citizen1@test.civicfix.local exists.
 *   2. GEMINI_API_KEY may or may not be configured — this suite doesn't
 *      depend on AI analysis succeeding (createReport already treats AI
 *      failure as non-fatal), only on the upload path itself.
 *
 * This drives the actual /report page, the actual hidden <input type=file>,
 * and the actual createReport Server Action — never a mocked fetch.
 */

// A fresh, low-traffic constituency per test *run* (not per test — several
// tests in the same run share it) keeps findPossibleDuplicate
// (src/lib/duplicate-detection.ts) from flagging one test's report as a
// near-duplicate of another's, without disabling real duplicate detection.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function fillReportBasics(page: Page, description: string) {
  await page.goto("/report");
  await page.locator("#description").fill(description);
  await page.getByRole("button", { name: "Road / Pothole" }).click();

  await page.locator("#loc-state").selectOption("Andhra Pradesh");
  await page.locator("#loc-district").selectOption("Palnadu");
  await page.locator("#loc-constituency").selectOption("Gurazala");
  await page.locator("#loc-area").fill(`E2E-${RUN_ID}`);
  await page.locator("#loc-area").blur();

  // Reporter details are pre-filled from the signed-in profile — fill them
  // defensively so the test doesn't depend on seed data having run.
  const nameField = page.getByLabel("Full Name");
  if ((await nameField.inputValue()) === "") await nameField.fill("Test Citizen");
  const mobileField = page.getByLabel("Mobile Number");
  if ((await mobileField.inputValue()) === "") await mobileField.fill("9876500001");
}

type SubmitOutcome = "success" | "error" | "duplicate" | "timeout";

/**
 * After clicking "Analyze with AI", the single createReport round trip can
 * land in one of three states: it succeeds (navigates to /report/analysis),
 * it fails validation (an alert appears on the review step), or this
 * description/category/area combination looks like a possible duplicate of
 * an earlier run's report (a "Submit anyway" banner on the SAME step,
 * before ever reaching photo validation — duplicate detection runs first
 * in src/lib/actions/reports.ts). Races all three — whichever resolves
 * first wins — rather than guessing a fixed delay; a real Gemini call can
 * occasionally be slow, so this is generous.
 */
/** Real inline error messages in this app are `<p role="alert">{message}</p>`
 * with actual text (see ReportForm's submitError paragraph) — but Next.js
 * also renders its own always-present, empty accessibility route announcer
 * with role="alert" on every page. Requiring non-whitespace text excludes
 * that announcer so this only matches a genuine error message. */
function nonEmptyAlert(page: Page) {
  return page.getByRole("alert").filter({ hasText: /\S/ });
}

async function waitForSubmitOutcome(page: Page): Promise<SubmitOutcome> {
  return await Promise.race([
    page
      .getByRole("button", { name: "Submit anyway" })
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => "duplicate" as const),
    page.waitForURL(/\/report\/analysis/, { timeout: 60_000 }).then(() => "success" as const),
    nonEmptyAlert(page)
      .first()
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => "error" as const),
  ]).catch(() => "timeout" as const);
}

/** Clicks "Analyze with AI" and resolves to the real terminal outcome,
 * transparently clicking through a duplicate-warning banner if one
 * appears (see waitForSubmitOutcome) since that's not what any of these
 * tests are checking for. */
async function submitAndAwaitOutcome(page: Page): Promise<SubmitOutcome> {
  await page.getByRole("button", { name: "Analyze with AI" }).click();
  let outcome = await waitForSubmitOutcome(page);
  if (outcome === "duplicate") {
    await page.getByRole("button", { name: "Submit anyway" }).click();
    outcome = await waitForSubmitOutcome(page);
  }
  return outcome;
}

test.describe("Report creation — file upload", () => {
  test.use({ storageState: AUTH_STATE_PATH });

  test("uploads a valid image, creates the report, and the stored media is retrievable only via a signed URL", async ({
    page,
    request,
  }) => {
    const description = `E2E upload test pothole ${RUN_ID}`;
    await fillReportBasics(page, description);

    await page.setInputFiles('input[type="file"]', {
      name: "evidence.jpg",
      mimeType: "image/jpeg",
      buffer: tinyJpegBuffer(),
    });
    await expect(page.getByText("Photo attached")).toBeVisible();

    await page.getByRole("button", { name: "Continue to Review" }).click();
    await expect(page.getByRole("heading", { name: "Review your report" })).toBeVisible();

    const outcome = await submitAndAwaitOutcome(page);
    expect(outcome).toBe("success");

    const url = new URL(page.url());
    const reportId = url.searchParams.get("reportId");
    expect(reportId).toBeTruthy();

    // Verify the report is real and the media reference resolves to a
    // working, signed (not public) Storage URL. The <img> src goes through
    // Next's image optimizer (next.config.ts allows this remote pattern),
    // so the real Supabase Storage URL is the `url=` query param on it.
    await page.goto(`/reports/${reportId}`);
    const img = page.locator("img[src*='report-media']").first();
    await expect(img).toBeVisible({ timeout: 10_000 });
    const proxiedSrc = await img.getAttribute("src");
    expect(proxiedSrc).toBeTruthy();

    const proxiedUrl = new URL(proxiedSrc!, page.url());
    const signedUrl = proxiedUrl.searchParams.get("url");
    expect(signedUrl).toBeTruthy();
    expect(signedUrl).toMatch(/token=/); // a signed URL, not a bare public path

    const signedResponse = await request.get(signedUrl!);
    expect(signedResponse.ok()).toBe(true);

    // Same object path WITHOUT the signing token must be refused — this is
    // the "unauthorized users cannot access protected files" check.
    const unsignedUrl = signedUrl!.split("?")[0];
    const unsignedResponse = await request.get(unsignedUrl);
    expect(unsignedResponse.ok()).toBe(false);
  });

  test("rejects an oversized file with a clear error, without creating the report", async ({ page }) => {
    const description = `E2E oversize test ${RUN_ID}`;
    await fillReportBasics(page, description);

    await page.setInputFiles('input[type="file"]', {
      name: "too-big.jpg",
      mimeType: "image/jpeg",
      buffer: oversizedJpegBuffer(),
    });
    await page.getByRole("button", { name: "Continue to Review" }).click();

    const outcome = await submitAndAwaitOutcome(page);
    expect(outcome).toBe("error");
    await expect(page.getByRole("alert").filter({ hasText: /too large/i })).toBeVisible();
    expect(page.url()).not.toMatch(/\/report\/analysis/);
  });

  test("rejects a file whose content doesn't match its claimed image type (MIME spoofing protection)", async ({
    page,
  }) => {
    const description = `E2E spoof test ${RUN_ID}`;
    await fillReportBasics(page, description);

    // Client-reported type says JPEG (exactly what a forged Content-Type
    // looks like); the actual bytes are plain text. Client-side checks only
    // look at this reported type/size, so this reaches the server, where
    // src/lib/upload-limits.ts's magic-byte sniffing must catch it.
    await page.setInputFiles('input[type="file"]', {
      name: "fake.jpg",
      mimeType: "image/jpeg",
      buffer: spoofedNotAnImageBuffer(),
    });
    await page.getByRole("button", { name: "Continue to Review" }).click();

    const outcome = await submitAndAwaitOutcome(page);
    expect(outcome).toBe("error");
    await expect(page.getByRole("alert").filter({ hasText: /JPEG, PNG, WEBP/i })).toBeVisible();
    expect(page.url()).not.toMatch(/\/report\/analysis/);
  });

  test("the photo picker never attaches a non-image file client-side", async ({ page }) => {
    const description = `E2E non-image test ${RUN_ID}`;
    await fillReportBasics(page, description);

    await page.setInputFiles('input[type="file"]', {
      name: "notes.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 fake pdf content", "utf-8"),
    });

    // PhotoUploader.handleFiles only calls onSelect() for image/* types —
    // a non-image selection is silently ignored, so the dropzone never
    // switches to its "Photo attached" state. The report can still be
    // submitted (photo is optional) without ever reaching the server with
    // a non-image file.
    await expect(page.getByText("Photo attached")).not.toBeVisible();
    await expect(page.getByText("Upload a photo")).toBeVisible();
  });
});
