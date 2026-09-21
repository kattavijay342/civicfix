import { test, expect, type Page } from "@playwright/test";
import { TEST_GOVERNMENT } from "./fixtures";
import { AUTH_STATE_PATH } from "./global-setup";

/**
 * Phase 6B — location/map E2E.
 *
 * The GPS tests use Playwright's own `context.setGeolocation` /
 * `grantPermissions`, which drives the REAL browser Geolocation API
 * (Chromium's own implementation) — not a stub inside our code. No external
 * map/geocoding provider is required or contacted; none is configured in
 * this project (see docs/PHASE_6B_REPORT.md).
 */

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function fillJurisdiction(page: Page) {
  await page.locator("#loc-state").selectOption("Andhra Pradesh");
  await page.locator("#loc-district").selectOption("Palnadu");
  await page.locator("#loc-constituency").selectOption("Gurazala");
  await page.locator("#loc-area").fill(`E2E-Loc-${RUN_ID}`);
  await page.locator("#loc-area").blur();
}

test.describe("Location — manual entry and GPS (Phase 6B)", () => {
  test.use({ storageState: AUTH_STATE_PATH });

  test("citizen can use current location when browser geolocation permission is granted", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 16.2333, longitude: 80.0499, accuracy: 15 });

    await page.goto("/report");
    await page.locator("#description").fill(`E2E GPS location test ${RUN_ID}`);
    await page.getByRole("button", { name: "Road / Pothole" }).click();
    await fillJurisdiction(page);

    await page.getByRole("button", { name: "Use my current location" }).click();

    // Real coordinates from the real browser Geolocation API, not fabricated.
    await expect(page.getByText(/GPS location: 16\.2333/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/accuracy: approximately 15 m/)).toBeVisible();

    await page.getByRole("button", { name: "Confirm location" }).click();
    await expect(page.getByText(/Location confirmed — 16\.2333.*±15 m/)).toBeVisible();
  });

  test("GPS failure shows a specific error and the citizen can still select a location manually", async ({
    page,
    context,
  }) => {
    // No permission granted — Chromium under automation denies geolocation
    // by default (there's no UI to accept a prompt), so this exercises the
    // real PERMISSION_DENIED path, not a simulated one.
    await context.clearPermissions();

    await page.goto("/report");
    await page.locator("#description").fill(`E2E GPS denied test ${RUN_ID}`);
    await page.getByRole("button", { name: "Road / Pothole" }).click();

    await page.getByRole("button", { name: "Use my current location" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /manually/i })).toBeVisible({ timeout: 10_000 });

    // Manual fallback still fully works — a GPS failure never blocks reporting.
    await fillJurisdiction(page);
    await expect(page.getByText("Location identified")).toBeVisible();
  });
});

test.describe("Government Dashboard map (Phase 6B)", () => {
  test("shows either real coordinate-based markers or an honest empty state — never fake data", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(TEST_GOVERNMENT.email);
    await page.getByLabel("Password").fill(TEST_GOVERNMENT.password);
    await page.locator('button[type="submit"]', { hasText: "Sign In" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 15_000 });

    await page.goto("/government");
    await expect(page.getByRole("heading", { name: "Government Area Map" })).toBeVisible({ timeout: 15_000 });

    const emptyState = page.getByText("Not enough location data to generate this view");
    const markerCaption = page.getByText(/of \d+ matching issue.* have\s*\n?\s*recorded GPS coordinates/);

    // Exactly one of these must be true — either real markers with a real
    // coordinate count, or an explicit, honest "not enough data" state.
    await expect(emptyState.or(markerCaption)).toBeVisible();

    // The category filter must not throw or blank the section when changed.
    const categoryFilter = page.getByLabel("Filter map by category");
    await categoryFilter.selectOption("ROAD");
    await expect(page.getByRole("heading", { name: "Government Area Map" })).toBeVisible();
  });
});
