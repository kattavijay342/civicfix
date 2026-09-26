import { test, expect, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { TEST_CITIZEN, TEST_GOVERNMENT, TEST_DEPARTMENT_INCHARGE } from "./fixtures";

/**
 * "Report a Problem" in the global navbar is shown only to citizens (and
 * signed-out visitors). Admin uses a throwaway admin account (random
 * password, deleted afterwards) — there is no seeded admin test account.
 * Needs .env.local (service role) for that setup/cleanup only.
 */
process.loadEnvFile(".env.local");

test.use({ storageState: { cookies: [], origins: [] } });

let admin: SupabaseClient;
let throwawayAdmin: { id: string; email: string; password: string } | null = null;

test.beforeAll(async () => {
  admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const email = `g1-navbar-admin-${Date.now()}@test.civicfix.local`;
  const password = `Adm-${randomBytes(12).toString("base64url")}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  throwawayAdmin = { id: data.user.id, email, password };
  const { error: roleError } = await admin.from("profiles").update({ role: "admin" }).eq("id", data.user.id);
  if (roleError) throw roleError;
});

test.afterAll(async () => {
  if (throwawayAdmin) await admin.auth.admin.deleteUser(throwawayAdmin.id);
});

async function signIn(page: Page, path: string, email: string, password: string, landing: RegExp) {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(landing, { timeout: 20_000 });
}

const navReport = (page: Page) => page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Report a Problem" });

test.describe("Navbar — Report a Problem is citizen-only", () => {
  test("signed-out visitor still sees it (public site unchanged)", async ({ page }) => {
    await page.goto("/");
    await expect(navReport(page)).toBeVisible();
  });

  test("citizen sees it and it opens the report form", async ({ page }) => {
    await signIn(page, "/sign-in", TEST_CITIZEN.email, TEST_CITIZEN.password, /\/dashboard$/);
    await expect(navReport(page)).toBeVisible();
    await navReport(page).click();
    await expect(page).toHaveURL(/\/report$/);
  });

  test("government user does not see it", async ({ page }) => {
    await signIn(page, "/sign-in?mode=authorized", TEST_GOVERNMENT.email, TEST_GOVERNMENT.password, /\/government$/);
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Authorized Government User" })).toBeVisible();
    await expect(navReport(page)).toHaveCount(0);
  });

  test("department in-charge does not see it", async ({ page }) => {
    await signIn(page, "/sign-in?mode=authorized", TEST_DEPARTMENT_INCHARGE.email, TEST_DEPARTMENT_INCHARGE.password, /\/department$/);
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Department In-charge" })).toBeVisible();
    await expect(navReport(page)).toHaveCount(0);
  });

  test("admin does not see it; the Admin link still works", async ({ page }) => {
    await signIn(page, "/sign-in?mode=authorized", throwawayAdmin!.email, throwawayAdmin!.password, /\/admin$/);
    await expect(navReport(page)).toHaveCount(0);
    const nav = page.getByRole("navigation", { name: "Primary" });
    await nav.getByRole("link", { name: "How It Works" }).click();
    await expect(page).toHaveURL(/\/#how-it-works$/);
    await nav.getByRole("link", { name: "Admin" }).click();
    await expect(page).toHaveURL(/\/admin$/);
  });
});
