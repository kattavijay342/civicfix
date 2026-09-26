import { test, expect, type Page, type Browser } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { TEST_DEPARTMENT_INCHARGE, TEST_GOVERNMENT } from "./fixtures";
import { AUTH_STATE_PATH } from "./global-setup";

/**
 * Phase G3 — AI -> Department routing, end to end in a real browser
 * against the real createReport Server Action, real Gemini analysis, the
 * real configured departments and real RLS:
 *
 *   citizen1 reports a pothole in Narasaraopet Municipality -> AI analyzes
 *   it -> the recommendation is validated against the configured
 *   departments -> routed to Roads & Infrastructure -> incharge1 (Roads,
 *   Narasaraopet Municipality) sees it in My Assigned Issues and gets the
 *   notification -> gov1 still sees it with its department.
 *
 * Negative paths use two throwaway in-charges with ACTIVE routing rows, so
 * the real router genuinely had them as candidates and had to exclude them:
 * Roads in Tenali (right department, wrong jurisdiction) and Water Supply
 * in Narasaraopet (right jurisdiction, wrong department).
 *
 * Needs .env.local (service role) to create/delete those users and the
 * test report, and to read back the stored assignment.
 */

try {
  process.loadEnvFile(".env.local");
} catch {
  // Env already provided by the shell/CI.
}

const RUN_STARTED = new Date().toISOString();
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TITLE = `G3 E2E large pothole near RTC Bus Stand ${RUN_ID}`;
const PASSWORD = "CivicFixTest2026!";

let admin: SupabaseClient;
let reportId: string | null = null;
/** Whether Gemini actually analyzed the report this run. When it didn't
 * (quota/outage), the AI-failure invariants are asserted instead and every
 * routed-path check is SKIPPED — never reported as passed. */
let aiOk = false;
/** Pre-run aggregates of every existing incident, so a pre-existing
 * incident the test report joined can be restored exactly (joining
 * recomputes severity/priority/confidence; deleting the report later
 * doesn't undo that). */
let incidentSnapshot = new Map<string, { severity: string; priority: string; confidence: number }>();
const AI_UNAVAILABLE = "Gemini analysis unavailable this run (quota/outage) — routed-path check not executed";
const throwaway: Record<"roadsTenali" | "waterNarasaraopet", { id: string; email: string } | null> = {
  roadsTenali: null,
  waterNarasaraopet: null,
};

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.locator('button[type="submit"]', { hasText: "Sign In" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 15_000 });
}

async function newSignedInPage(browser: Browser, email: string, password = PASSWORD) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email, password);
  return page;
}

async function createInchargeWithRoutingRow(tag: string, departmentName: string, scope: Record<string, string>) {
  const { data: dept } = await admin.from("departments").select("id").eq("name", departmentName).single();
  const email = `g3-e2e-${tag}-${RUN_ID}@test.civicfix.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  await admin.from("profiles").update({ role: "department_incharge", department_id: dept!.id, ...scope }).eq("id", data.user.id);
  await admin.from("department_incharges").insert({ department_id: dept!.id, profile_id: data.user.id, is_active: true, ...scope });
  return { id: data.user.id, email };
}

test.describe.serial("G3 AI -> department routing", () => {
  // Report creation waits on a real Gemini call (with retries).
  test.setTimeout(150_000);

  test.beforeAll(async () => {
    admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: incidents } = await admin.from("civic_incidents").select("id, severity, priority, confidence");
    incidentSnapshot = new Map(
      (incidents ?? []).map((i) => [i.id, { severity: i.severity, priority: i.priority, confidence: Number(i.confidence) }])
    );
    throwaway.roadsTenali = await createInchargeWithRoutingRow("roads-tenali", "Roads & Infrastructure", {
      gov_state: "Andhra Pradesh",
      gov_district: "Guntur",
      gov_constituency: "Tenali",
      gov_area: "Tenali Municipality",
    });
    throwaway.waterNarasaraopet = await createInchargeWithRoutingRow("water-narasaraopet", "Water Supply", {
      gov_state: "Andhra Pradesh",
      gov_district: "Palnadu",
      gov_constituency: "Narasaraopet",
      gov_area: "Narasaraopet Municipality",
    });
  });

  test.afterAll(async () => {
    // Deactivate first so nothing more can be routed to them.
    for (const u of Object.values(throwaway)) {
      if (u) await admin.from("department_incharges").update({ is_active: false }).eq("profile_id", u.id);
    }
    const { data: testReports } = await admin.from("reports").select("id").eq("title", TITLE);
    const testReportIds = (testReports ?? []).map((r) => r.id);
    if (testReportIds.length > 0) {
      // Same rule as the G2 spec: only incidents this run created are removed.
      const { data: links } = await admin.from("incident_reports").select("incident_id").in("report_id", testReportIds);
      const linkedIds = [...new Set((links ?? []).map((l) => l.incident_id))];
      if (linkedIds.length > 0) {
        for (const id of linkedIds) {
          await admin.from("notifications").delete().eq("action_url", `/government/incidents/${id}`).gte("created_at", RUN_STARTED);
        }
        const { data: created } = await admin.from("civic_incidents").select("id").in("id", linkedIds).gte("created_at", RUN_STARTED);
        for (const { id } of created ?? []) await admin.from("civic_incidents").delete().eq("id", id);
        // A pre-existing incident the test report merely joined keeps its
        // row but gets its pre-run aggregate back.
        for (const id of linkedIds) {
          const before = incidentSnapshot.get(id);
          if (before) await admin.from("civic_incidents").update(before).eq("id", id);
        }
      }
      await admin.from("reports").delete().in("id", testReportIds);
    }
    for (const u of Object.values(throwaway)) {
      if (!u) continue;
      // A real report routed to a throwaway in-charge during the run must not
      // lose its assignment — leave the user and report it instead.
      const { data: foreign } = await admin.from("report_assignments").select("report_id").eq("incharge_id", u.id);
      if ((foreign ?? []).length > 0) {
        console.warn(`CLEANUP SKIPPED: ${u.email} is assigned real report(s): ${foreign!.map((f) => f.report_id).join(", ")}`);
        continue;
      }
      await admin.auth.admin.deleteUser(u.id);
    }
  });

  test.describe("as citizen", () => {
    test.use({ storageState: AUTH_STATE_PATH });

    test("citizen reports a pothole: routed to the Roads in-charge when AI succeeds, kept unrouted and visible when AI fails", async ({ page }) => {
      await page.goto("/report");
      await page
        .locator("#description")
        .fill(`${TITLE}. Large, deep pothole on the main road near the RTC Bus Stand is causing two-wheeler accidents.`);
      await page.getByRole("button", { name: "Road / Pothole" }).click();
      await page.locator("#loc-state").selectOption("Andhra Pradesh");
      await page.locator("#loc-district").selectOption("Palnadu");
      await page.locator("#loc-constituency").selectOption("Narasaraopet");
      await page.locator("#loc-area").fill("Narasaraopet Municipality");
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

      const { data: analysis } = await admin
        .from("ai_analyses")
        .select("category, priority, severity, recommended_department")
        .eq("report_id", reportId!)
        .maybeSingle();
      aiOk = !!analysis;
      if (!aiOk) {
        // AI failure path: the report is kept, visible, and honestly unrouted.
        test.info().annotations.push({ type: "ai-unavailable", description: AI_UNAVAILABLE });
        const { data: report } = await admin.from("reports").select("status").eq("id", reportId!).single();
        expect(report!.status).toBe("reported");
        const { data: noAssignment } = await admin.from("report_assignments").select("report_id").eq("report_id", reportId!);
        expect(noAssignment).toHaveLength(0);
        const { data: loc } = await admin.from("report_locations").select("area").eq("report_id", reportId!).single();
        expect(loc!.area).toBe("Narasaraopet Municipality");
        await page.goto(`/reports/${reportId}`);
        await expect(page.getByTestId("routing-state")).toHaveText("Routing pending — waiting for AI analysis", {
          timeout: 15_000,
        });
        await expect(page.locator("dt", { hasText: "In-charge" })).toHaveCount(0);
        await page.screenshot({ path: "test-results/g3-ai-failure-detail.png", fullPage: true });
        return;
      }
      console.log("AI analysis:", JSON.stringify(analysis));

      const { data: incharge1 } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const incharge1Id = incharge1.users.find((u) => u.email === TEST_DEPARTMENT_INCHARGE.email)!.id;
      const { data: assignment } = await admin
        .from("report_assignments")
        .select("incharge_id, assignment_method, departments(name)")
        .eq("report_id", reportId!)
        .single();
      expect(assignment).toMatchObject({
        incharge_id: incharge1Id,
        assignment_method: "auto",
        departments: { name: "Roads & Infrastructure" },
      });
      const { data: report } = await admin.from("reports").select("status").eq("id", reportId!).single();
      expect(report!.status).toBe("routed");
      const { data: history } = await admin
        .from("status_history")
        .select("notes")
        .eq("report_id", reportId!)
        .eq("new_status", "routed");
      expect(history).toHaveLength(1);
      console.log("Routing note:", history![0].notes);

      // The citizen sees the routing state, but not the in-charge's identity.
      await page.goto(`/reports/${reportId}`);
      await expect(page.getByTestId("routing-state")).toHaveText("Assigned", { timeout: 15_000 });
      await expect(page.getByText("Roads & Infrastructure").first()).toBeVisible();
      await expect(page.locator("dt", { hasText: "In-charge" })).toHaveCount(0);
    });
  });

  test("Roads in-charge for Narasaraopet sees it in My Assigned Issues, notifications and detail", async ({ browser }) => {
    expect(reportId).toBeTruthy();
    const page = await newSignedInPage(browser, TEST_DEPARTMENT_INCHARGE.email, TEST_DEPARTMENT_INCHARGE.password);

    await page.goto(`/department?q=${encodeURIComponent(RUN_ID)}`);
    await expect(page.getByRole("heading", { name: "My Assigned Issues" })).toBeVisible({ timeout: 20_000 });
    if (!aiOk) {
      // Unrouted report: not assigned to anyone, so not visible to any in-charge.
      await expect(page.getByText(TITLE)).toHaveCount(0);
      await page.goto(`/reports/${reportId}`);
      await expect(page.getByText("Report not found")).toBeVisible({ timeout: 15_000 });
      test.skip(true, AI_UNAVAILABLE);
    }
    const card = page.getByRole("link", { name: `View details for ${TITLE}` });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("Roads & Infrastructure");
    await expect(card).toContainText("Narasaraopet");
    await page.screenshot({ path: "test-results/g3-department-assigned.png", fullPage: true });

    await page.goto("/notifications");
    await expect(page.getByText("New issue assigned to your department").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(TITLE).first()).toBeVisible();

    await page.goto(`/reports/${reportId}`);
    await expect(page.getByRole("heading", { name: TITLE })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("routing-state")).toHaveText("Assigned");
    await expect(page.locator("dt", { hasText: "In-charge" })).toHaveCount(1);
  });

  test("Government user still sees the routed issue with its department", async ({ browser }) => {
    expect(reportId).toBeTruthy();
    const page = await newSignedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);

    await page.goto(`/government/issues?search=${encodeURIComponent(RUN_ID)}`);
    const card = page.getByRole("link", { name: `View details for ${TITLE}` });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText(aiOk ? "Roads & Infrastructure" : "Not yet routed");

    await page.goto(`/reports/${reportId}`);
    await expect(page.getByRole("heading", { name: TITLE })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("routing-state")).toHaveText(
      aiOk ? "Assigned" : "Routing pending — waiting for AI analysis"
    );
    await page.screenshot({ path: "test-results/g3-government-detail.png", fullPage: true });
  });

  for (const [key, label] of [
    ["roadsTenali", "Roads in-charge for Tenali (other jurisdiction)"],
    ["waterNarasaraopet", "Water Supply in-charge for Narasaraopet (other department)"],
  ] as const) {
    test(`${label} cannot see it anywhere, including by direct URL`, async ({ browser }) => {
      expect(reportId).toBeTruthy();
      const page = await newSignedInPage(browser, throwaway[key]!.email);

      await page.goto(`/department?q=${encodeURIComponent(RUN_ID)}`);
      await expect(page.getByRole("heading", { name: "My Assigned Issues" })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(TITLE)).toHaveCount(0);

      await page.goto("/notifications");
      await expect(page.getByText(TITLE)).toHaveCount(0);

      await page.goto(`/reports/${reportId}`);
      await expect(page.getByText("Report not found")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(TITLE)).toHaveCount(0);
    });
  }
});
