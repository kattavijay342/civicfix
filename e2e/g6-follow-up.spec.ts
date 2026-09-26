import { test, expect, type Browser, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { TEST_CITIZEN, TEST_DEPARTMENT_INCHARGE, TEST_GOVERNMENT } from "./fixtures";

/**
 * Phase G6 — Government ↔ Department follow-up in a real browser against
 * the real server actions, reminder pipeline and RLS. Independent of Gemini.
 *
 * Fixtures ("G6 E2E" + RUN_ID) in gov1's jurisdiction (Narasaraopet
 * Municipality): one report routed to incharge1 (effective) and one still
 * naming a DEACTIVATED throwaway in-charge. Everything — including the
 * reminders/notifications created here (cascade) — is deleted in afterAll.
 */

try {
  process.loadEnvFile(".env.local");
} catch {
  // Env already provided by the shell/CI.
}

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const T = (tag: string) => `G6 E2E ${tag} ${RUN_ID}`;
const PASSWORD = "CivicFixTest2026!";
const NARASARAOPET = { state: "Andhra Pradesh", district: "Palnadu", constituency: "Narasaraopet", area: "Narasaraopet Municipality" };
const STALE_NAME = `G6 Deactivated Incharge ${RUN_ID}`;
const MESSAGE = `Please provide an update on this issue. (${RUN_ID})`;

let admin: SupabaseClient;
let roadsId: string;
let incharge1Id: string;
let gov1Id: string;
let stale: { id: string; email: string };
const reportIds: string[] = [];
const userIds: string[] = [];
const ids: Record<string, string> = {};

type StorageState = Awaited<ReturnType<import("@playwright/test").BrowserContext["storageState"]>>;
const sessions = new Map<string, StorageState>();

/** One real sign-in per user per run (the app's sign-in limiter would
 * otherwise lock the shared test accounts out of later specs). */
async function signedInPage(browser: Browser, email: string, password = PASSWORD, viewport?: { width: number; height: number }): Promise<Page> {
  if (!sessions.has(email)) {
    const context = await browser.newContext();
    const p = await context.newPage();
    await p.goto("/sign-in");
    await p.getByLabel("Email").fill(email);
    await p.getByLabel("Password").fill(password);
    await p.locator('button[type="submit"]', { hasText: "Sign In" }).click();
    await p.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 30_000, waitUntil: "commit" });
    sessions.set(email, await context.storageState());
    await context.close();
  }
  const context = await browser.newContext({ storageState: sessions.get(email), ...(viewport ? { viewport } : {}) });
  return context.newPage();
}

async function userId(email: string) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  return data.users.find((u) => u.email === email)!.id;
}

async function fixture(key: string, inchargeId: string) {
  const title = T(key);
  const { data: report, error } = await admin
    .from("reports")
    .insert({
      reporter_id: await userId(TEST_CITIZEN.email),
      title,
      description: `${title}. Disposable G6 E2E fixture — deleted after the run.`,
      category: "road",
      status: "routed",
      priority: "critical",
      severity: "critical",
    })
    .select("id")
    .single();
  if (error) throw error;
  reportIds.push(report.id);
  ids[key] = report.id;
  await admin.from("report_locations").insert({ report_id: report.id, display_name: `G6 fixture spot ${RUN_ID}`, ...NARASARAOPET, location_source: "manual" });
  await admin.from("report_assignments").insert({ report_id: report.id, department_id: roadsId, incharge_id: inchargeId, assignment_method: "auto" });
}

const followUpSection = (p: Page) => p.locator("#reminders");

test.describe.serial("G6 government ↔ department follow-up", () => {
  test.beforeAll(async () => {
    admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: roads } = await admin.from("departments").select("id").eq("name", "Roads & Infrastructure").single();
    roadsId = roads!.id;
    incharge1Id = await userId(TEST_DEPARTMENT_INCHARGE.email);
    gov1Id = await userId(TEST_GOVERNMENT.email);

    const email = `g6-e2e-stale-${RUN_ID}@test.civicfix.local`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (error) throw error;
    stale = { id: data.user.id, email };
    userIds.push(stale.id);
    await admin.from("profiles").update({ role: "department_incharge", department_id: roadsId, full_name: STALE_NAME }).eq("id", stale.id);
    await admin.from("department_incharges").insert({
      department_id: roadsId,
      profile_id: stale.id,
      gov_state: NARASARAOPET.state,
      gov_district: NARASARAOPET.district,
      gov_constituency: NARASARAOPET.constituency,
      gov_area: NARASARAOPET.area,
      is_active: false,
    });

    await fixture("effective", incharge1Id);
    await fixture("stale", stale.id);
  });

  test.afterAll(async () => {
    for (const id of reportIds) await admin.from("reports").delete().eq("id", id); // cascades reminders/notifications
    for (const id of userIds) {
      await admin.from("department_incharges").delete().eq("profile_id", id);
      await admin.auth.admin.deleteUser(id);
    }
  });

  test("government: Action Required → issue → Send now delivers to the effective in-charge", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password, { width: 1366, height: 900 });
    await p.goto("/government");
    await p.getByTestId("action-row").filter({ hasText: T("effective") }).getByRole("link", { name: "Send reminder" }).click();
    await p.waitForURL(new RegExp(`/reports/${ids.effective}#reminders$`), { timeout: 20_000 });

    // Current department + effective in-charge + status are shown.
    await expect(p.getByTestId("incharge-name")).toHaveText("Test Roads Incharge");
    await expect(p.getByRole("heading", { name: "Department follow-ups" })).toBeVisible();

    await followUpSection(p).locator('textarea[name="message"]').fill(MESSAGE);
    await followUpSection(p).getByRole("button", { name: "Send now" }).click();
    await expect(p.getByText("Follow-up sent to the department in-charge.")).toBeVisible({ timeout: 20_000 });

    const { data: rows } = await admin.from("reminders").select("recipient_id, created_by, department_id, status, notification_id, message").eq("report_id", ids.effective);
    expect(rows).toHaveLength(1);
    expect(rows![0]).toMatchObject({ recipient_id: incharge1Id, created_by: gov1Id, department_id: roadsId, status: "sent", message: MESSAGE });
    const { data: notif } = await admin.from("notifications").select("recipient_id, type, related_report_id").eq("id", rows![0].notification_id).single();
    expect(notif).toMatchObject({ recipient_id: incharge1Id, type: "reminder_due", related_report_id: ids.effective });

    // History entry.
    const item = p.getByTestId("follow-up-history-item").filter({ hasText: MESSAGE });
    await expect(item).toContainText("Delivered", { timeout: 20_000 });
    await expect(item).toContainText("Test Roads Incharge (Department in-charge)");
    await expect(item).toContainText("Not opened yet");

    // The report status is untouched and gov has no G4 controls.
    const { data: rep } = await admin.from("reports").select("status").eq("id", ids.effective).single();
    expect(rep!.status).toBe("routed");
    await expect(p.getByRole("button", { name: /^(Acknowledge|Start Work|Mark Resolved|Submit resolution)/i })).toHaveCount(0);

    // Re-sending the identical follow-up is refused.
    await followUpSection(p).locator('textarea[name="message"]').fill(MESSAGE);
    await followUpSection(p).getByRole("button", { name: "Send now" }).click();
    await expect(p.getByText(/already sent to the department in-charge/)).toBeVisible({ timeout: 20_000 });
    const { count } = await admin.from("reminders").select("*", { count: "exact", head: true }).eq("report_id", ids.effective);
    expect(count).toBe(1);

    await followUpSection(p).screenshot({ path: "test-results/g6-follow-up-desktop.png" });
  });

  test("government: scheduled follow-up is queued (not delivered early)", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password, { width: 1366, height: 900 });
    await p.goto(`/reports/${ids.effective}#reminders`);
    await followUpSection(p).locator('textarea[name="message"]').fill(`Scheduled check-in ${RUN_ID}`);
    await followUpSection(p).getByRole("button", { name: "Tomorrow" }).click();
    await followUpSection(p).getByRole("button", { name: "Schedule reminder" }).click();
    await expect(p.getByText("Reminder scheduled.")).toBeVisible({ timeout: 20_000 });
    await expect(p.getByTestId("follow-up-history-item").filter({ hasText: `Scheduled check-in ${RUN_ID}` })).toContainText("Scheduled");

    const { data: rows } = await admin.from("reminders").select("status, notification_id").eq("report_id", ids.effective).eq("message", `Scheduled check-in ${RUN_ID}`);
    expect(rows).toEqual([{ status: "scheduled", notification_id: null }]);
  });

  test("government: stale in-charge → 'unavailable', follow-up sending disabled", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password, { width: 1366, height: 900 });
    await p.goto(`/reports/${ids.stale}`);
    await expect(p.getByTestId("incharge-name")).toHaveText("Department in-charge unavailable", { timeout: 20_000 });
    await expect(p.getByText(STALE_NAME)).toHaveCount(0);
    await expect(p.getByRole("button", { name: "Send now" })).toHaveCount(0);
    await expect(p.getByRole("button", { name: "Schedule reminder" })).toHaveCount(0);
  });

  test("department in-charge: sees the delivered follow-up, opens the issue, keeps the G4 workflow", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_DEPARTMENT_INCHARGE.email, TEST_DEPARTMENT_INCHARGE.password, { width: 1366, height: 900 });
    await p.goto("/department");
    const inbox = p.getByTestId("department-follow-ups");
    await expect(inbox).toContainText(MESSAGE, { timeout: 20_000 });
    // Scheduled (not yet due) follow-ups don't appear early.
    await expect(inbox).not.toContainText(`Scheduled check-in ${RUN_ID}`);

    await inbox.getByRole("link").filter({ hasText: MESSAGE }).click();
    await p.waitForURL(new RegExp(`/reports/${ids.effective}#reminders$`), { timeout: 20_000 });
    await expect(p.getByTestId("follow-up-history-item").filter({ hasText: MESSAGE })).toBeVisible();
    // G4 workflow is still the only way to respond.
    await expect(p.getByRole("button", { name: /Acknowledge/i })).toBeVisible();
    await expect(p.getByRole("button", { name: "Send now" })).toHaveCount(0);

    // The in-app notification reached this in-charge.
    await p.goto("/notifications");
    await expect(p.getByText(MESSAGE).first()).toBeVisible({ timeout: 20_000 });
  });

  test("deactivated in-charge: follow-up addressed to them is not shown, report not reachable", async ({ browser }) => {
    // A follow-up delivered while they were still effective (inserted as the
    // server action would have), then they were deactivated.
    await admin.from("reminders").insert({
      report_id: ids.stale, created_by: gov1Id, department_id: roadsId, recipient_id: stale.id,
      title: "Government follow-up", message: `Stale inbox ${RUN_ID}`, scheduled_at: new Date().toISOString(),
      status: "sent", sent_at: new Date().toISOString(), attempt_count: 1,
    });
    const p = await signedInPage(browser, stale.email);
    await p.goto("/department");
    await expect(p.getByRole("heading", { name: "My Assigned Issues" })).toBeVisible({ timeout: 20_000 });
    await expect(p.getByText(`Stale inbox ${RUN_ID}`)).toHaveCount(0);
    await expect(p.getByTestId("department-follow-ups")).toHaveCount(0);
    await p.goto(`/reports/${ids.stale}`);
    await expect(p.getByText(`Stale inbox ${RUN_ID}`)).toHaveCount(0);
    await expect(p.getByText(T("stale"))).toHaveCount(0);
  });

  test("citizen reporter: no follow-up controls or government follow-up history", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_CITIZEN.email, TEST_CITIZEN.password);
    await p.goto(`/reports/${ids.effective}`);
    await expect(p.getByRole("heading", { name: T("effective") })).toBeVisible({ timeout: 20_000 });
    await expect(p.getByRole("button", { name: "Send now" })).toHaveCount(0);
    await expect(p.getByText(MESSAGE)).toHaveCount(0);
  });

  test("mobile: follow-up form is usable without horizontal scroll", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password, { width: 375, height: 812 });
    await p.goto(`/reports/${ids.effective}#reminders`);
    await expect(followUpSection(p).getByRole("button", { name: "Send now" })).toBeVisible({ timeout: 20_000 });
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await followUpSection(p).screenshot({ path: "test-results/g6-follow-up-mobile.png" });
  });
});
