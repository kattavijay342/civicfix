import { test, expect, type Browser } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { TEST_CITIZEN, TEST_DEPARTMENT_INCHARGE, TEST_GOVERNMENT } from "./fixtures";
import { AUTH_STATE_PATH } from "./global-setup";

/**
 * Phase G3 — department visibility in a real browser, independent of
 * Gemini availability. The report + assignment are written with the
 * service role exactly as routeReport() stores them (Roads & Infrastructure
 * -> incharge1 for Narasaraopet Municipality); everything the browser then
 * shows is decided by the real pages and real RLS. The AI -> routing path
 * itself is e2e/g3-routing.spec.ts.
 *
 * Negative principals are throwaway in-charges with NO department_incharges
 * row (never routable): Roads/Tenali and Water Supply/Narasaraopet.
 */

try {
  process.loadEnvFile(".env.local");
} catch {
  // Env already provided by the shell/CI.
}

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TITLE = `G3 visibility pothole near RTC Bus Stand ${RUN_ID}`;
const PASSWORD = "CivicFixTest2026!";

let admin: SupabaseClient;
let reportId: string;
const users: Record<"roadsTenali" | "waterNarasaraopet", { id: string; email: string } | null> = {
  roadsTenali: null,
  waterNarasaraopet: null,
};

async function page(browser: Browser, email: string, password = PASSWORD) {
  const context = await browser.newContext();
  const p = await context.newPage();
  await p.goto("/sign-in");
  await p.getByLabel("Email").fill(email);
  await p.getByLabel("Password").fill(password);
  await p.locator('button[type="submit"]', { hasText: "Sign In" }).click();
  await p.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 15_000 });
  return p;
}

async function userId(email: string) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  return data.users.find((u) => u.email === email)!.id;
}

async function throwawayIncharge(tag: string, departmentName: string, scope: Record<string, string>) {
  const { data: dept } = await admin.from("departments").select("id").eq("name", departmentName).single();
  const email = `g3-vis-${tag}-${RUN_ID}@test.civicfix.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  await admin.from("profiles").update({ role: "department_incharge", department_id: dept!.id, ...scope }).eq("id", data.user.id);
  return { id: data.user.id, email };
}

test.describe.serial("G3 department visibility", () => {
  test.beforeAll(async () => {
    admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    users.roadsTenali = await throwawayIncharge("roads-tenali", "Roads & Infrastructure", {
      gov_state: "Andhra Pradesh",
      gov_district: "Guntur",
      gov_constituency: "Tenali",
      gov_area: "Tenali Municipality",
    });
    users.waterNarasaraopet = await throwawayIncharge("water-narasaraopet", "Water Supply", {
      gov_state: "Andhra Pradesh",
      gov_district: "Palnadu",
      gov_constituency: "Narasaraopet",
      gov_area: "Narasaraopet Municipality",
    });

    const { data: roads } = await admin.from("departments").select("id").eq("name", "Roads & Infrastructure").single();
    const { data: report, error } = await admin
      .from("reports")
      .insert({
        reporter_id: await userId(TEST_CITIZEN.email),
        title: TITLE,
        description: `${TITLE}. Large pothole near the RTC Bus Stand.`,
        category: "road",
        status: "routed",
        priority: "high",
        severity: "high",
      })
      .select("id")
      .single();
    if (error) throw error;
    reportId = report.id;
    await admin.from("report_locations").insert({
      report_id: reportId,
      display_name: "RTC Bus Stand, Narasaraopet",
      state: "Andhra Pradesh",
      district: "Palnadu",
      constituency: "Narasaraopet",
      area: "Narasaraopet Municipality",
      location_source: "manual",
    });
    await admin.from("report_assignments").insert({
      report_id: reportId,
      department_id: roads!.id,
      incharge_id: await userId(TEST_DEPARTMENT_INCHARGE.email),
      assignment_method: "auto",
    });
  });

  test.afterAll(async () => {
    if (reportId) await admin.from("reports").delete().eq("id", reportId); // cascades assignment/location/history
    for (const u of Object.values(users)) if (u) await admin.auth.admin.deleteUser(u.id);
  });

  test("Roads in-charge for Narasaraopet: My Assigned Issues card + detail with in-charge", async ({ browser }) => {
    const p = await page(browser, TEST_DEPARTMENT_INCHARGE.email, TEST_DEPARTMENT_INCHARGE.password);
    await p.goto(`/department?q=${encodeURIComponent(RUN_ID)}`);
    await expect(p.getByRole("heading", { name: "My Assigned Issues" })).toBeVisible({ timeout: 20_000 });
    const card = p.getByRole("link", { name: `View details for ${TITLE}` });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("Roads & Infrastructure");
    await expect(card).toContainText("high severity");
    await expect(card).toContainText("Narasaraopet");
    await card.screenshot({ path: "test-results/g3-assigned-issue-card.png" });

    await p.goto(`/reports/${reportId}`);
    await expect(p.getByRole("heading", { name: TITLE })).toBeVisible({ timeout: 15_000 });
    await expect(p.getByTestId("routing-state")).toHaveText("Assigned");
    await expect(p.locator("dt", { hasText: "In-charge" })).toHaveCount(1);
  });

  test.describe("as the reporting citizen", () => {
    test.use({ storageState: AUTH_STATE_PATH });
    test("citizen sees department + Assigned, but not the in-charge's identity", async ({ page: p }) => {
      await p.goto(`/reports/${reportId}`);
      await expect(p.getByTestId("routing-state")).toHaveText("Assigned", { timeout: 15_000 });
      await expect(p.getByText("Roads & Infrastructure").first()).toBeVisible();
      await expect(p.locator("dt", { hasText: "In-charge" })).toHaveCount(0);
    });
  });

  test("Government user still sees it with department and routing state", async ({ browser }) => {
    const p = await page(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);
    await p.goto(`/government/issues?search=${encodeURIComponent(RUN_ID)}`);
    const card = p.getByRole("link", { name: `View details for ${TITLE}` });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText("Roads & Infrastructure");
    await p.goto(`/reports/${reportId}`);
    await expect(p.getByTestId("routing-state")).toHaveText("Assigned", { timeout: 15_000 });
    await expect(p.locator("dt", { hasText: "In-charge" })).toHaveCount(1);
  });

  for (const [key, label] of [
    ["roadsTenali", "Roads in-charge for Tenali (other jurisdiction)"],
    ["waterNarasaraopet", "Water Supply in-charge for Narasaraopet (other department)"],
  ] as const) {
    test(`${label}: not in dashboard, direct URL denied`, async ({ browser }) => {
      const p = await page(browser, users[key]!.email);
      await p.goto(`/department?q=${encodeURIComponent(RUN_ID)}`);
      await expect(p.getByRole("heading", { name: "My Assigned Issues" })).toBeVisible({ timeout: 20_000 });
      await expect(p.getByText(TITLE)).toHaveCount(0);
      await p.goto(`/department?q=${encodeURIComponent(RUN_ID)}&category=ROAD&status=ROUTED`);
      await expect(p.getByText(TITLE)).toHaveCount(0);
      await p.goto(`/reports/${reportId}`);
      await expect(p.getByText("Report not found")).toBeVisible({ timeout: 15_000 });
      await expect(p.getByText(TITLE)).toHaveCount(0);
    });
  }
});
