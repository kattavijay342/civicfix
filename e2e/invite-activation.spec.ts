import { test, expect, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";

/**
 * Admin-provisioned account activation (/auth/accept-invite), end to end
 * against the real Supabase project:
 *   provisioned invite -> invitation link -> set own password -> dashboard
 *   picked from the stored role -> later sign-in via /sign-in?mode=authorized.
 *
 * Provisioning mirrors provisionAuthorizedUser (src/lib/actions/admin.ts):
 * Supabase's own invite (generateLink creates the user and link without
 * sending any email) + the role/scope write. The action's admin-only
 * checks themselves are unit-tested in src/lib/actions/admin.test.ts.
 *
 * The invite redirect is generated for the production origin (the one on
 * Supabase's Redirect URLs allow-list) and the resulting fragment is
 * replayed on this server's /auth/accept-invite. Every throwaway account
 * is deleted afterwards. Needs .env.local (service role) for setup only.
 */
process.loadEnvFile(".env.local");

test.use({ storageState: { cookies: [], origins: [] } });

const JURISDICTION = {
  gov_state: "Andhra Pradesh",
  gov_district: "Palnadu",
  gov_constituency: "Narasaraopet",
  gov_area: "Narasaraopet Municipality",
};

let admin: SupabaseClient;
const created: string[] = [];

test.beforeAll(() => {
  admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
});

test.afterAll(async () => {
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

async function provisionInvite(role: "government" | "department_incharge") {
  const email = `g1-activate-${role}-${Date.now()}@test.civicfix.local`;
  const { data, error } = await admin.auth.admin.generateLink({
    type: "invite",
    email,
    options: { data: { full_name: "E2E Activation Test" }, redirectTo: "https://civicfix-sbte.vercel.app/auth/accept-invite" },
  });
  if (error) throw error;
  created.push(data.user.id);

  let departmentId: string | null = null;
  if (role === "department_incharge") {
    const { data: dept } = await admin.from("departments").select("id").eq("name", "Roads & Infrastructure").single();
    departmentId = dept!.id;
    await admin.from("department_incharges").insert({ department_id: departmentId, profile_id: data.user.id, is_active: true, ...JURISDICTION });
  }
  const { error: roleError } = await admin
    .from("profiles")
    .update({ role, department_id: departmentId, ...JURISDICTION })
    .eq("id", data.user.id);
  if (roleError) throw roleError;

  const res = await fetch(data.properties.action_link, { redirect: "manual" });
  const fragment = (res.headers.get("location") ?? "").split("#")[1];
  if (!fragment?.includes("access_token=")) throw new Error("invite link did not yield a session fragment");
  return { email, userId: data.user.id, activationPath: `/auth/accept-invite#${fragment}` };
}

async function setPassword(page: Page, password: string) {
  await page.getByLabel("New password").fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Set password and continue" }).click();
}

test.describe("Admin-provisioned account activation", () => {
  test("'Activate your invited account →' leads to activation instructions — never a sign-up form", async ({ page }) => {
    await page.goto("/sign-in?mode=authorized");
    await page.getByRole("link", { name: "Activate your invited account →" }).click();
    await expect(page).toHaveURL(/\/auth\/accept-invite$/);
    await expect(page.getByRole("heading", { name: "Activate your invited account" })).toBeVisible();
    await expect(page.getByText("Open the invitation email from your CivicFix administrator.")).toBeVisible();
    // Nothing to fill in: no email, password, name or role fields.
    await expect(page.locator("main input:not([type=hidden]), main select")).toHaveCount(0);

    await page.getByRole("link", { name: "← Back to authorized sign in" }).click();
    await expect(page).toHaveURL(/\/sign-in\?mode=authorized$/);
  });

  test("a forged invitation link is rejected and offers no password form", async ({ page }) => {
    await page.goto("/credits");
    await page.goto("/auth/accept-invite#access_token=forged&refresh_token=forged&type=invite&expires_in=3600&token_type=bearer");
    await expect(page.getByText("This invitation link is invalid or has expired.")).toBeVisible();
    await expect(page.getByLabel("New password")).toHaveCount(0);
  });

  test("provisioned Government user activates, sets own password, lands on /government, then signs in via authorized mode", async ({ page, browser }) => {
    const invite = await provisionInvite("government");
    const password = `Act-${randomBytes(9).toString("base64url")}`;

    await page.goto("/credits");
    await page.goto(invite.activationPath);
    await setPassword(page, password);
    await page.waitForURL(/\/government$/, { timeout: 20_000 });

    const fresh = await (await browser.newContext({ storageState: { cookies: [], origins: [] } })).newPage();
    await fresh.goto("/sign-in?mode=authorized");
    await fresh.getByLabel("Email").fill(invite.email);
    await fresh.getByLabel("Password").fill(password);
    await fresh.getByRole("button", { name: "Sign In" }).click();
    await fresh.waitForURL(/\/government$/, { timeout: 20_000 });
  });

  test("provisioned Department In-charge activates and lands on /department", async ({ page }) => {
    const invite = await provisionInvite("department_incharge");

    await page.goto("/credits");
    await page.goto(invite.activationPath);
    await setPassword(page, `Act-${randomBytes(9).toString("base64url")}`);
    await page.waitForURL(/\/department$/, { timeout: 20_000 });
  });

  test("an invited user cannot change their role during activation", async ({ page }) => {
    const invite = await provisionInvite("government");

    await page.goto("/credits");
    await page.goto(invite.activationPath);
    await expect(page.getByLabel("New password")).toBeVisible();
    // Tamper with the form: smuggle role/department/jurisdiction fields in.
    await page.evaluate(() => {
      const form = document.querySelector("main form")!;
      for (const [name, value] of [["role", "admin"], ["department_id", "x"], ["gov_state", ""]]) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }
    });
    await setPassword(page, `Act-${randomBytes(9).toString("base64url")}`);
    await page.waitForURL(/\/government$/, { timeout: 20_000 });

    const { data: profile } = await admin.from("profiles").select("role, gov_state").eq("id", invite.userId).single();
    expect(profile).toEqual({ role: "government", gov_state: "Andhra Pradesh" });
  });
});
