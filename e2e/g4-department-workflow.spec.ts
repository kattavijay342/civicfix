import { test, expect, type Browser, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { TEST_CITIZEN, TEST_DEPARTMENT_INCHARGE, TEST_GOVERNMENT, tinyJpegBuffer } from "./fixtures";
import { AUTH_STATE_PATH } from "./global-setup";

/**
 * Phase G4 — the Department In-charge workflow in a real browser against
 * the real server actions and real RLS. Independent of Gemini: the fixture
 * report is stored exactly as routeReport() stores a routed report
 * (Roads & Infrastructure -> incharge1, Narasaraopet Municipality).
 *
 * Negative principals are throwaway @test.civicfix.local in-charges. The
 * "stale" in-charge gets a department_incharges row for the same scope as
 * incharge1 — routing ties always go to the longest-serving in-charge
 * (pickIncharge), so real reports can never route to it while this runs.
 * Every fixture report, row and user is deleted in afterAll.
 */

try {
  process.loadEnvFile(".env.local");
} catch {
  // Env already provided by the shell/CI.
}

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TITLE = `G4 workflow pothole near RTC Bus Stand ${RUN_ID}`;
const STALE_TITLE = `G4 stale-assignment pothole ${RUN_ID}`;
const PASSWORD = "CivicFixTest2026!";
const NARASARAOPET = {
  state: "Andhra Pradesh",
  district: "Palnadu",
  constituency: "Narasaraopet",
  area: "Narasaraopet Municipality",
};
const NARASARAOPET_SCOPE = {
  gov_state: NARASARAOPET.state,
  gov_district: NARASARAOPET.district,
  gov_constituency: NARASARAOPET.constituency,
  gov_area: NARASARAOPET.area,
};

let admin: SupabaseClient;
let roadsId: string;
let reportId: string;
let staleReportId: string;
const reportIds: string[] = [];
const userIds: string[] = [];
let otherIncharge: { id: string; email: string };
let staleIncharge: { id: string; email: string };

async function signedInPage(browser: Browser, email: string, password = PASSWORD): Promise<Page> {
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

async function throwawayIncharge(tag: string) {
  const email = `g4-e2e-${tag}-${RUN_ID}@test.civicfix.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  userIds.push(data.user.id);
  await admin
    .from("profiles")
    .update({ role: "department_incharge", department_id: roadsId, ...NARASARAOPET_SCOPE })
    .eq("id", data.user.id);
  return { id: data.user.id, email };
}

async function routedReport(title: string, inchargeId: string) {
  const { data: report, error } = await admin
    .from("reports")
    .insert({
      reporter_id: await userId(TEST_CITIZEN.email),
      title,
      description: `${title}. Disposable G4 E2E fixture — deleted after the run.`,
      category: "road",
      status: "routed",
      priority: "high",
      severity: "high",
    })
    .select("id")
    .single();
  if (error) throw error;
  reportIds.push(report.id);
  await admin.from("report_locations").insert({
    report_id: report.id,
    display_name: "RTC Bus Stand, Narasaraopet",
    ...NARASARAOPET,
    location_source: "manual",
  });
  await admin
    .from("report_assignments")
    .insert({ report_id: report.id, department_id: roadsId, incharge_id: inchargeId, assignment_method: "auto" });
  return report.id as string;
}

const dbStatus = async (id: string) => (await admin.from("reports").select("status").eq("id", id).single()).data!.status;

test.describe.serial("G4 department in-charge workflow", () => {
  test.beforeAll(async () => {
    admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: roads } = await admin.from("departments").select("id").eq("name", "Roads & Infrastructure").single();
    roadsId = roads!.id;

    reportId = await routedReport(TITLE, await userId(TEST_DEPARTMENT_INCHARGE.email));
    otherIncharge = await throwawayIncharge("other");
    staleIncharge = await throwawayIncharge("stale");
    await admin
      .from("department_incharges")
      .insert({ department_id: roadsId, profile_id: staleIncharge.id, ...NARASARAOPET_SCOPE, is_active: true });
    staleReportId = await routedReport(STALE_TITLE, staleIncharge.id);
  });

  test.afterAll(async () => {
    for (const id of reportIds) await admin.from("reports").delete().eq("id", id); // cascades
    await admin.storage.from("report-media").list(`resolution/${reportId}`).then(async ({ data }) => {
      if (data?.length) await admin.storage.from("report-media").remove(data.map((f) => `resolution/${reportId}/${f.name}`));
    });
    for (const id of userIds) {
      await admin.from("department_incharges").delete().eq("profile_id", id);
      await admin.auth.admin.deleteUser(id);
    }
  });

  test("dashboard: My Assigned Issues shows real workflow stats and the assigned card", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_DEPARTMENT_INCHARGE.email, TEST_DEPARTMENT_INCHARGE.password);
    await p.goto(`/department?q=${encodeURIComponent(RUN_ID)}`);
    await expect(p.getByRole("heading", { name: "My Assigned Issues" })).toBeVisible({ timeout: 20_000 });
    const stats = p.getByTestId("department-stats");
    for (const label of ["Total assigned", "Awaiting acknowledgement", "Acknowledged", "In progress", "Resolved", "High/critical open"]) {
      await expect(stats.getByText(label, { exact: true })).toBeVisible();
    }
    const card = p.getByRole("link", { name: `View details for ${TITLE}` });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText(`#${reportId.slice(0, 8)}`);
    await expect(card).toContainText("Assigned");
    await expect(card).toContainText("Routed");
    await p.screenshot({ path: "test-results/g4-department-dashboard.png", fullPage: true });
  });

  test("citizen sees status but no department actions on their own report", async ({ browser }) => {
    const context = await browser.newContext({ storageState: AUTH_STATE_PATH });
    const p = await context.newPage();
    await p.goto(`/reports/${reportId}`);
    await expect(p.getByRole("heading", { name: TITLE })).toBeVisible({ timeout: 15_000 });
    await expect(p.getByTestId("department-actions")).toHaveCount(0);
    await expect(p.locator("dt", { hasText: "In-charge" })).toHaveCount(0);
    // ...and the in-charge's name appears nowhere on the page (incl. the summary).
    const { data: incharge } = await admin
      .from("profiles")
      .select("full_name")
      .eq("id", await userId(TEST_DEPARTMENT_INCHARGE.email))
      .single();
    expect(incharge?.full_name).toBeTruthy();
    await expect(p.getByText("Routed to Roads & Infrastructure").first()).toBeVisible();
    expect(await p.locator("body").innerText()).not.toContain(incharge!.full_name);
  });

  test("government user monitors the report but gets no department actions", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);
    await p.goto(`/reports/${reportId}`);
    await expect(p.getByRole("heading", { name: TITLE })).toBeVisible({ timeout: 15_000 });
    await expect(p.getByTestId("department-actions")).toHaveCount(0);
  });

  test("security: another in-charge of the same department gets 'Report not found' by direct URL", async ({ browser }) => {
    const p = await signedInPage(browser, otherIncharge.email);
    await p.goto(`/reports/${reportId}`);
    await expect(p.getByText("Report not found")).toBeVisible({ timeout: 15_000 });
    await expect(p.getByTestId("department-actions")).toHaveCount(0);
  });

  test("assigned in-charge: Acknowledge -> Start work -> Resolve", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_DEPARTMENT_INCHARGE.email, TEST_DEPARTMENT_INCHARGE.password);
    await p.goto(`/reports/${reportId}`);
    const panel = p.getByTestId("department-actions");
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // Only the valid next step is offered.
    await expect(panel.getByRole("button", { name: "Start work" })).toHaveCount(0);
    await panel.getByLabel("Action notes (optional)").fill("G4 E2E: inspection scheduled");
    await panel.getByRole("button", { name: "Acknowledge" }).click();
    await expect(panel.getByRole("button", { name: "Start work" })).toBeVisible({ timeout: 15_000 });
    expect(await dbStatus(reportId)).toBe("acknowledged");

    await panel.getByRole("button", { name: "Start work" }).click();
    await expect(panel.getByRole("button", { name: "Resolve" })).toBeVisible({ timeout: 15_000 });
    expect(await dbStatus(reportId)).toBe("in_progress");

    await panel.getByLabel("Resolution notes").fill("G4 E2E: pothole filled and compacted.");
    await panel.getByLabel("After photo").setInputFiles({ name: "after.jpg", mimeType: "image/jpeg", buffer: tinyJpegBuffer() });
    await panel.getByRole("button", { name: "Resolve" }).click();
    await expect(panel.getByText("This report is resolved.")).toBeVisible({ timeout: 20_000 });
    await p.screenshot({ path: "test-results/g4-resolved-detail.png", fullPage: true });

    expect(await dbStatus(reportId)).toBe("resolved");
    const { data: history } = await admin
      .from("status_history")
      .select("old_status, new_status, changed_by")
      .eq("report_id", reportId)
      .order("created_at");
    const inchargeId = await userId(TEST_DEPARTMENT_INCHARGE.email);
    expect(history!.filter((h) => h.changed_by === inchargeId).map((h) => `${h.old_status}>${h.new_status}`)).toEqual([
      "routed>acknowledged",
      "acknowledged>in_progress",
      "in_progress>resolved",
    ]);
    const { data: evidence } = await admin.from("resolution_evidence").select("resolved_by").eq("report_id", reportId);
    expect(evidence).toEqual([{ resolved_by: inchargeId }]);
    const { count: resolvedNotifications } = await admin
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("related_report_id", reportId)
      .eq("type", "report_resolved");
    expect(resolvedNotifications).toBe(1);
  });

  test("citizen and government both see Resolved through their existing views", async ({ browser }) => {
    const citizen = await (await browser.newContext({ storageState: AUTH_STATE_PATH })).newPage();
    await citizen.goto(`/reports/${reportId}`);
    await expect(citizen.getByText("Resolved").first()).toBeVisible({ timeout: 15_000 });
    await expect(citizen.getByTestId("department-actions")).toHaveCount(0);

    const gov = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);
    await gov.goto(`/government/issues?search=${encodeURIComponent(RUN_ID)}`);
    const card = gov.getByRole("link", { name: `View details for ${TITLE}` });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText("Resolved");
  });

  test("stale assignment: a deactivated in-charge loses the report on the dashboard and by direct URL", async ({ browser }) => {
    const p = await signedInPage(browser, staleIncharge.email);
    await p.goto(`/reports/${staleReportId}`);
    await expect(p.getByTestId("department-actions")).toBeVisible({ timeout: 15_000 });

    await admin.from("department_incharges").update({ is_active: false }).eq("profile_id", staleIncharge.id);

    await p.goto(`/reports/${staleReportId}`);
    await expect(p.getByText("Report not found")).toBeVisible({ timeout: 15_000 });
    await p.goto(`/department?q=${encodeURIComponent(RUN_ID)}`);
    await expect(p.getByRole("heading", { name: "My Assigned Issues" })).toBeVisible({ timeout: 15_000 });
    await expect(p.getByRole("link", { name: `View details for ${STALE_TITLE}` })).toHaveCount(0);
    expect(await dbStatus(staleReportId)).toBe("routed");
  });
});
