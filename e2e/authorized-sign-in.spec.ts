import { test, expect, type Page } from "@playwright/test";
import { TEST_CITIZEN, TEST_GOVERNMENT, TEST_DEPARTMENT_INCHARGE } from "./fixtures";

/**
 * Government & Department sign-in mode (/sign-in?mode=authorized): a UI
 * mode of the one existing sign-in form. Checks the real navigation path
 * from Citizen Sign Up, that there's no role picker or sign-up there, and
 * that the landing dashboard still comes only from the stored profile role.
 * Every test starts signed out.
 */
test.use({ storageState: { cookies: [], origins: [] } });

async function signInFromAuthorizedMode(page: Page, email: string, password: string) {
  await page.goto("/sign-in?mode=authorized");
  await expect(page.getByRole("heading", { name: "Authorized Government & Department Users" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL((url) => url.pathname !== "/sign-in", { timeout: 20_000 });
}

test.describe("Government & Department sign-in mode", () => {
  test("Citizen Sign Up → 'Sign in here →' opens Government & Department mode; Back returns to Citizen Sign In", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByRole("tab", { name: "Citizen Sign Up" }).click();
    await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();

    await page.getByRole("link", { name: "Sign in here →" }).click();
    await expect(page).toHaveURL(/\/sign-in\?mode=authorized$/);
    await expect(page.getByRole("heading", { name: "Authorized Government & Department Users" })).toBeVisible();
    await expect(page.getByText("Use the account invited by your CivicFix administrator.")).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    // No role picker, no public sign-up in this mode.
    await expect(page.locator("select")).toHaveCount(0);
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(page.getByText("Citizen Sign Up")).toHaveCount(0);

    await page.getByRole("link", { name: "← Back to Citizen Sign In" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole("heading", { name: "Welcome to CivicFix" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Citizen Sign Up" })).toBeVisible();
  });

  test("an Authorized Government User lands on /government", async ({ page }) => {
    await signInFromAuthorizedMode(page, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);
    await expect(page).toHaveURL(/\/government$/);
  });

  test("a Department In-charge lands on /department", async ({ page }) => {
    await signInFromAuthorizedMode(page, TEST_DEPARTMENT_INCHARGE.email, TEST_DEPARTMENT_INCHARGE.password);
    await expect(page).toHaveURL(/\/department$/);
  });

  test("citizen credentials in Government & Department mode are rejected — no privileged access, no session", async ({ page }) => {
    await page.goto("/sign-in?mode=authorized");
    await page.getByLabel("Email").fill(TEST_CITIZEN.email);
    await page.getByLabel("Password").fill(TEST_CITIZEN.password);
    await page.getByRole("button", { name: "Sign In" }).click();

    await expect(page.getByRole("alert").filter({ hasText: "Citizens, please use Citizen Sign In" })).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in\?mode=authorized$/);

    // Signed back out: protected pages send it to sign-in, not a dashboard.
    await page.goto("/government");
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test("citizen credentials on normal /sign-in still work exactly as before", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(TEST_CITIZEN.email);
    await page.getByLabel("Password").fill(TEST_CITIZEN.password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL((url) => url.pathname !== "/sign-in", { timeout: 20_000 });
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});
