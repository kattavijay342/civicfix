import { test, expect, type Page, type Browser } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { TEST_GOVERNMENT } from "./fixtures";
import { AUTH_STATE_PATH } from "./global-setup";

/**
 * Phase G2 — Citizen report -> Government connectivity, end to end in a
 * real browser against the real createReport Server Action and real RLS:
 *
 *   citizen1 files a report in Narasaraopet (area typed in lowercase, to
 *   prove the server canonicalizes it) -> gov1 (scoped to Narasaraopet
 *   Municipality) sees it on the dashboard, in the issue explorer, in
 *   notifications and on the detail page -> a throwaway government user
 *   scoped to Tenali Municipality sees none of that, including via the
 *   direct report URL.
 *
 * Needs .env.local (service role) only to create/delete the throwaway
 * Tenali user and delete the test report afterwards.
 */

try {
  process.loadEnvFile(".env.local");
} catch {
  // Env already provided by the shell/CI.
}

const RUN_STARTED = new Date().toISOString();
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TITLE = `G2 E2E pothole on Main Road ${RUN_ID}`;
const PASSWORD = "CivicFixTest2026!";

let admin: SupabaseClient;
let tenaliUser: { id: string; email: string } | null = null;
let reportId: string | null = null;

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.locator('button[type="submit"]', { hasText: "Sign In" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 15_000 });
}

async function newSignedInPage(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email, PASSWORD);
  return page;
}

test.describe.serial("G2 citizen -> government connectivity", () => {
  // Report creation waits on a real Gemini call (with retries).
  test.setTimeout(150_000);

  test.beforeAll(async () => {
    admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const email = `g2-e2e-gov-tenali-${RUN_ID}@test.civicfix.local`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (error) throw error;
    tenaliUser = { id: data.user.id, email };
    await admin
      .from("profiles")
      .update({
        role: "government",
        gov_state: "Andhra Pradesh",
        gov_district: "Guntur",
        gov_constituency: "Tenali",
        gov_area: "Tenali Municipality",
      })
      .eq("id", data.user.id);
  });

  test.afterAll(async () => {
    // By run-unique title, not just reportId: if the submit wait times out
    // (e.g. a slow Gemini call) the report can still be created afterwards.
    const { data: testReports } = await admin.from("reports").select("id").eq("title", TITLE);
    const testReportIds = (testReports ?? []).map((r) => r.id);
    // Existing incident linking (src/lib/incident-linking.ts) may group the
    // test report with nearby real reports into a NEW incident and notify
    // about it. Only incidents this run created are removed (created after
    // RUN_STARTED and containing the test report) — never a pre-existing one
    // the test report merely joined; its link row cascades with the report.
    if (testReportIds.length > 0) {
      const { data: links } = await admin.from("incident_reports").select("incident_id").in("report_id", testReportIds);
      const linkedIds = [...new Set((links ?? []).map((l) => l.incident_id))];
      if (linkedIds.length > 0) {
        for (const id of linkedIds) {
          await admin
            .from("notifications")
            .delete()
            .eq("action_url", `/government/incidents/${id}`)
            .gte("created_at", RUN_STARTED);
        }
        const { data: created } = await admin
          .from("civic_incidents")
          .select("id")
          .in("id", linkedIds)
          .gte("created_at", RUN_STARTED);
        for (const { id } of created ?? []) await admin.from("civic_incidents").delete().eq("id", id);
      }
      await admin.from("reports").delete().in("id", testReportIds);
    }
    if (tenaliUser) await admin.auth.admin.deleteUser(tenaliUser.id);
  });

  test.describe("as citizen", () => {
    test.use({ storageState: AUTH_STATE_PATH });

    test("citizen creates a report in Narasaraopet Municipality", async ({ page }) => {
      await page.goto("/report");
      await page.locator("#description").fill(`${TITLE}. Deep pothole near the bus stop is causing two-wheeler accidents.`);
      await page.getByRole("button", { name: "Road / Pothole" }).click();
      await page.locator("#loc-state").selectOption("Andhra Pradesh");
      await page.locator("#loc-district").selectOption("Palnadu");
      await page.locator("#loc-constituency").selectOption("Narasaraopet");
      // Lowercase on purpose: the server must canonicalize to the configured
      // "Narasaraopet Municipality" or gov1's gov_area scope wouldn't match.
      await page.locator("#loc-area").fill("narasaraopet municipality");
      await page.locator("#loc-area").blur();
      const nameField = page.getByLabel("Full Name");
      if ((await nameField.inputValue()) === "") await nameField.fill("Test Citizen");
      const mobileField = page.getByLabel("Mobile Number");
      if ((await mobileField.inputValue()) === "") await mobileField.fill("9876500001");

      await page.getByRole("button", { name: "Continue to Review" }).click();
      await page.getByRole("button", { name: "Analyze with AI" }).click();

      const submitAnyway = page.getByRole("button", { name: "Submit anyway" });
      const outcome = await Promise.race([
        page.waitForURL(/\/report\/analysis/, { timeout: 85_000 }).then(() => "success"),
        submitAnyway.waitFor({ state: "visible", timeout: 85_000 }).then(() => "duplicate"),
      ]);
      if (outcome === "duplicate") {
        await submitAnyway.click();
        await page.waitForURL(/\/report\/analysis/, { timeout: 75_000 });
      }

      reportId = new URL(page.url()).searchParams.get("reportId");
      expect(reportId).toBeTruthy();

      const { data: loc } = await admin
        .from("report_locations")
        .select("state, district, constituency, area")
        .eq("report_id", reportId!)
        .single();
      expect(loc).toEqual({
        state: "Andhra Pradesh",
        district: "Palnadu",
        constituency: "Narasaraopet",
        area: "Narasaraopet Municipality",
      });

      // Citizen still sees it in My Reports.
      await page.goto("/dashboard/reports");
      await expect(page.getByText(TITLE).first()).toBeVisible({ timeout: 15_000 });
    });
  });

  test("Narasaraopet government user sees it: dashboard, explorer, notification, detail", async ({ browser }) => {
    expect(reportId).toBeTruthy();
    const page = await newSignedInPage(browser, TEST_GOVERNMENT.email);

    await page.goto("/government");
    await expect(page.getByRole("heading", { name: "New & Recent Reports" })).toBeVisible({ timeout: 20_000 });
    const recent = page.locator("li", { hasText: TITLE });
    await expect(recent).toBeVisible();
    await expect(recent.getByText("New", { exact: true })).toBeVisible();
    await expect(recent.getByRole("link", { name: "View issue" })).toHaveAttribute("href", `/reports/${reportId}`);
    await page
      .locator("section", { has: page.getByRole("heading", { name: "New & Recent Reports" }) })
      .screenshot({ path: "test-results/g2-recent-reports.png" });

    await page.goto(`/government/issues?search=${encodeURIComponent(RUN_ID)}`);
    await expect(page.getByText(TITLE).first()).toBeVisible({ timeout: 15_000 });

    // report_created, or critical_issue if the AI rated it critical.
    await page.goto("/notifications");
    await expect(
      page.getByText(/New issue reported in your jurisdiction|Critical issue reported in your jurisdiction/).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(TITLE).first()).toBeVisible();
    await page.screenshot({ path: "test-results/g2-notification.png" });

    await page.goto(`/reports/${reportId}`);
    await expect(page.getByRole("heading", { name: TITLE })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Report not found")).toHaveCount(0);
  });

  test("Tenali government user cannot see it anywhere, including by direct URL", async ({ browser }) => {
    expect(reportId).toBeTruthy();
    const page = await newSignedInPage(browser, tenaliUser!.email);

    await page.goto("/government");
    await expect(page.getByRole("heading", { name: "Area Overview" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(TITLE)).toHaveCount(0);

    await page.goto(`/government/issues?search=${encodeURIComponent(RUN_ID)}`);
    await expect(page.getByText(TITLE)).toHaveCount(0);

    await page.goto("/notifications");
    await expect(page.getByText(TITLE)).toHaveCount(0);

    await page.goto(`/reports/${reportId}`);
    await expect(page.getByText("Report not found")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(TITLE)).toHaveCount(0);
  });
});
