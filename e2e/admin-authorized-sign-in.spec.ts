import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { requireLocalSupabaseEnv } from "./local-supabase-guard";

/**
 * Admin through /sign-in?mode=authorized, end to end. There is no seeded
 * admin test account (the only real admin is a person's own account), so
 * this creates a throwaway, email-confirmed account with a random password
 * that is never printed, promotes it to admin exactly the way
 * scripts/seed-test-accounts.mjs promoted the real one (profiles.role only
 * — no department, no jurisdiction), and deletes it afterwards.
 * The citizen-escalation test uses a throwaway citizen too: the app's
 * rejection path signs the account out, and Supabase's default sign-out is
 * global, so using the shared citizen1 would revoke the session every later
 * spec reuses (e2e/global-setup.ts).
 * Needs .env.g8-local (local service role) for that setup/cleanup only.
 */
// LOCAL Supabase only (e2e/local-supabase-guard.ts): loads .env.g8-local, never
// .env.local, and aborts this file for any non-local URL or hosted key.
requireLocalSupabaseEnv();

test.use({ storageState: { cookies: [], origins: [] } });

let admin: SupabaseClient;
let adminUser: { id: string; email: string; password: string } | null = null;
let citizenUser: { id: string; email: string; password: string } | null = null;

test.beforeAll(async () => {
  admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  // Throwaway citizen (role 'citizen' is the signup default, set by the
  // handle_new_user trigger — no profile write needed).
  const citizenEmail = `g1-citizen-${Date.now()}@test.civicfix.local`;
  const citizenPassword = `Cit-${randomBytes(12).toString("base64url")}`;
  const { data: citizenData, error: citizenError } = await admin.auth.admin.createUser({
    email: citizenEmail,
    password: citizenPassword,
    email_confirm: true,
    user_metadata: { full_name: "E2E Throwaway Citizen" },
  });
  if (citizenError) throw citizenError;
  citizenUser = { id: citizenData.user.id, email: citizenEmail, password: citizenPassword };

  const email = `g1-admin-${Date.now()}@test.civicfix.local`;
  const password = `Adm-${randomBytes(12).toString("base64url")}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "E2E Throwaway Admin" },
  });
  if (error) throw error;
  adminUser = { id: data.user.id, email, password };
  const { error: roleError } = await admin.from("profiles").update({ role: "admin" }).eq("id", data.user.id);
  if (roleError) throw roleError;
});

test.afterAll(async () => {
  if (adminUser) await admin.auth.admin.deleteUser(adminUser.id);
  if (citizenUser) await admin.auth.admin.deleteUser(citizenUser.id);
});

test.describe("Admin via Authorized Sign In", () => {
  test("an admin (role only — no department/jurisdiction) signs in via authorized mode and reaches /admin", async ({ page }) => {
    await page.goto("/sign-in?mode=authorized");
    await page.getByLabel("Email").fill(adminUser!.email);
    await page.getByLabel("Password").fill(adminUser!.password);
    await page.getByRole("button", { name: "Sign In" }).click();

    await page.waitForURL(/\/admin$/, { timeout: 20_000 });
    // The real Admin dashboard rendered — not an error boundary, not
    // another role's dashboard.
    await expect(page.getByRole("heading", { name: "System Configuration" })).toBeVisible();
    await expect(page.getByText("Create Authorized User")).toBeVisible();
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
  });

  test("?role=admin cannot escalate a citizen, and a citizen can't open /admin directly", async ({ page }) => {
    await page.goto("/sign-in?mode=authorized&role=admin");
    await page.getByLabel("Email").fill(citizenUser!.email);
    await page.getByLabel("Password").fill(citizenUser!.password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Citizens, please use Citizen Sign In" })).toBeVisible();

    // Signed back out by the authorized context -> /admin sends to sign-in.
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/sign-in$/);

    // Signed in normally as a citizen -> /admin still refuses (own home).
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(citizenUser!.email);
    await page.getByLabel("Password").fill(citizenUser!.password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/\/dashboard$/, { timeout: 20_000 });
    await page.goto("/admin?role=admin");
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});
