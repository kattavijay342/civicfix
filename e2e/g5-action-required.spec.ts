import { test, expect, type Browser, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { TEST_CITIZEN, TEST_DEPARTMENT_INCHARGE, TEST_GOVERNMENT } from "./fixtures";

/**
 * Phase G5 — Government "Action Required" command center in a real browser
 * against the real server, server actions and RLS. Independent of Gemini:
 * fixture reports are stored exactly as G3 routing / G4 workflow store them.
 *
 * Fixtures ("G5 E2E" + RUN_ID) in gov1's jurisdiction (Narasaraopet
 * Municipality): critical, 9-day-old, reopened, never-routed, and one still
 * naming a DEACTIVATED in-charge; plus one Tenali report gov1 must never see.
 * Throwaway @test.civicfix.local users: the deactivated in-charge (its
 * department_incharges row is inactive from the start, so it's never
 * routable) and an empty-jurisdiction government user. Everything —
 * including reminders created here (cascade) — is deleted in afterAll.
 */

try {
  process.loadEnvFile(".env.local");
} catch {
  // Env already provided by the shell/CI.
}

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const T = (tag: string) => `G5 E2E ${tag} ${RUN_ID}`;
const PASSWORD = "CivicFixTest2026!";
const DAY = 24 * 60 * 60 * 1000;
const NARASARAOPET = { state: "Andhra Pradesh", district: "Palnadu", constituency: "Narasaraopet", area: "Narasaraopet Municipality" };
const TENALI = { state: "Andhra Pradesh", district: "Guntur", constituency: "Tenali", area: "Tenali Municipality" };
const STALE_NAME = `G5 Deactivated Incharge ${RUN_ID}`;
const STALE_PHONE = "+910000000077";

let admin: SupabaseClient;
let roadsId: string;
let incharge1Id: string;
const reportIds: string[] = [];
const userIds: string[] = [];
const ids: Record<string, string> = {};
let emptyGov: { email: string };

/** One real sign-in per user per run, then the saved session is reused —
 * the app's sign-in limiter (8/email, 20/IP per 10 min, src/lib/actions/auth.ts)
 * would otherwise lock the shared test accounts out of later specs. */
type StorageState = Awaited<ReturnType<import("@playwright/test").BrowserContext["storageState"]>>;
const sessions = new Map<string, StorageState>();

async function signedInPage(browser: Browser, email: string, password = PASSWORD, viewport?: { width: number; height: number }): Promise<Page> {
  if (!sessions.has(email)) {
    const context = await browser.newContext();
    const p = await context.newPage();
    await p.goto("/sign-in");
    await p.getByLabel("Email").fill(email);
    await p.getByLabel("Password").fill(password);
    await p.locator('button[type="submit"]', { hasText: "Sign In" }).click();
    // Government sign-in lands on the (heavy) dashboard; the redirect itself
    // is what matters here, not that page's full load.
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

async function throwawayUser(tag: string) {
  const email = `g5-e2e-${tag}-${RUN_ID}@test.civicfix.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  userIds.push(data.user.id);
  return { id: data.user.id, email };
}

async function fixture(
  key: string,
  opts: { status?: string; priority?: string | null; ageDays?: number; jurisdiction?: typeof NARASARAOPET; inchargeId?: string | null; routed?: boolean }
) {
  const { status = "routed", priority = "medium", ageDays = 1, jurisdiction = NARASARAOPET, inchargeId = incharge1Id, routed = true } = opts;
  const title = T(key);
  const { data: report, error } = await admin
    .from("reports")
    .insert({
      reporter_id: await userId(TEST_CITIZEN.email),
      title,
      description: `${title}. Disposable G5 E2E fixture — deleted after the run.`,
      category: "road",
      status,
      priority,
      severity: priority,
      created_at: new Date(Date.now() - ageDays * DAY).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  reportIds.push(report.id);
  ids[key] = report.id;
  await admin.from("report_locations").insert({ report_id: report.id, display_name: `G5 fixture spot ${RUN_ID}`, ...jurisdiction, location_source: "manual" });
  if (routed) {
    await admin
      .from("report_assignments")
      .insert({ report_id: report.id, department_id: roadsId, incharge_id: inchargeId, assignment_method: "auto" });
  }
}

const row = (p: Page, key: string) => p.getByTestId("action-row").filter({ hasText: T(key) });

test.describe.serial("G5 government Action Required command center", () => {
  test.beforeAll(async () => {
    admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: roads } = await admin.from("departments").select("id").eq("name", "Roads & Infrastructure").single();
    roadsId = roads!.id;
    incharge1Id = await userId(TEST_DEPARTMENT_INCHARGE.email);

    const stale = await throwawayUser("stale");
    await admin
      .from("profiles")
      .update({ role: "department_incharge", department_id: roadsId, full_name: STALE_NAME, mobile_number: STALE_PHONE })
      .eq("id", stale.id);
    await admin.from("department_incharges").insert({
      department_id: roadsId,
      profile_id: stale.id,
      gov_state: NARASARAOPET.state,
      gov_district: NARASARAOPET.district,
      gov_constituency: NARASARAOPET.constituency,
      gov_area: NARASARAOPET.area,
      is_active: false,
    });

    emptyGov = await throwawayUser("empty-gov");
    await admin
      .from("profiles")
      .update({ role: "government", gov_state: "Andhra Pradesh", gov_district: `G5 Empty District ${RUN_ID}` })
      .eq("id", userIds[userIds.length - 1]);

    await fixture("critical", { priority: "critical" });
    await fixture("aged", { priority: "low", ageDays: 9.3 });
    await fixture("reopened", { status: "reopened", priority: "low" });
    await fixture("unrouted", { status: "reported", priority: null, routed: false, ageDays: 20 });
    await fixture("stale", { priority: "high", inchargeId: stale.id });
    await fixture("tenali", { priority: "critical", jurisdiction: TENALI });
  });

  test.afterAll(async () => {
    for (const id of reportIds) await admin.from("reports").delete().eq("id", id); // cascades reminders/follow-ups/notifications
    for (const id of userIds) {
      await admin.from("department_incharges").delete().eq("profile_id", id);
      await admin.auth.admin.deleteUser(id);
    }
  });

  test("shows real queues, reasons, contact data and ordering for gov1's jurisdiction only", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password, { width: 1366, height: 900 });
    await p.goto("/government");
    await expect(p.getByRole("heading", { name: "Action Required", exact: true })).toBeVisible({ timeout: 20_000 });
    // Existing overview KPIs preserved.
    await expect(p.getByText("Overall Resolution Rate")).toBeVisible();

    await expect(row(p, "critical")).toContainText("Critical issue");
    await expect(row(p, "aged")).toContainText("Pending for 9 days");
    await expect(row(p, "reopened")).toContainText("Reopened");
    await expect(row(p, "unrouted")).toContainText("Routing pending — awaiting AI analysis");
    await expect(row(p, "unrouted")).toContainText("Not routed yet");
    await expect(row(p, "stale")).toContainText("Department in-charge unavailable");

    // Effective in-charge: name + phone. Deactivated one: nothing exposed.
    await expect(row(p, "critical")).toContainText("Test Roads Incharge");
    await expect(row(p, "critical").getByRole("link", { name: /\+91/ })).toHaveAttribute("href", /^tel:\+91\d+$/);
    await expect(p.getByText(STALE_NAME)).toHaveCount(0);
    await expect(p.getByText(STALE_PHONE)).toHaveCount(0);

    // Jurisdiction isolation in the UI.
    await expect(p.getByText(T("tenali"))).toHaveCount(0);

    // Deterministic precedence: critical before high before reopened before plain aged.
    const order = await p.getByTestId("action-row").allTextContents();
    const pos = (k: string) => order.findIndex((t) => t.includes(T(k)));
    expect(pos("critical")).toBeGreaterThanOrEqual(0);
    expect(pos("critical")).toBeLessThan(pos("stale"));
    expect(pos("stale")).toBeLessThan(pos("reopened"));
    expect(pos("reopened")).toBeLessThan(pos("unrouted"));
    expect(pos("unrouted")).toBeLessThan(pos("aged"));

    // Counts are real and include the fixtures.
    const n = async (id: string) => Number(await p.getByTestId(id).textContent());
    expect(await n("count-critical")).toBeGreaterThanOrEqual(1);
    expect(await n("count-pending_over_7_days")).toBeGreaterThanOrEqual(2);
    expect(await n("count-reopened")).toBeGreaterThanOrEqual(1);
    expect(await n("count-routing_pending")).toBeGreaterThanOrEqual(2);

    // Monitoring only — no G4 department controls anywhere on the dashboard.
    const section = p.getByTestId("action-required");
    await expect(section.getByRole("button", { name: /Acknowledge|Start Work|Resolve|Assign/i })).toHaveCount(0);
    await expect(section.getByRole("link", { name: /Acknowledge|Start Work|Resolve|Assign/i })).toHaveCount(0);

    await section.screenshot({ path: "test-results/g5-action-required-desktop.png" });
  });

  test("queue tiles filter server-authorized rows; unknown queue values are ignored", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password, { width: 1366, height: 900 });
    await p.goto("/government?queue=reopened");
    await expect(row(p, "reopened")).toBeVisible({ timeout: 20_000 });
    await expect(row(p, "critical")).toHaveCount(0);
    await expect(p.getByRole("link", { name: "Clear filter" })).toBeVisible();

    await p.goto("/government?queue=all_jurisdictions");
    await expect(row(p, "critical")).toBeVisible({ timeout: 20_000 });
    await expect(p.getByText(T("tenali"))).toHaveCount(0);
  });

  test("report detail: stale in-charge is 'unavailable', no reminder form, no G4 actions", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);
    await p.goto(`/reports/${ids.stale}`);
    await expect(p.getByTestId("incharge-name")).toHaveText("Department in-charge unavailable", { timeout: 20_000 });
    await expect(p.getByText(STALE_NAME)).toHaveCount(0);
    await expect(p.getByRole("button", { name: "Schedule reminder" })).toHaveCount(0);
    await expect(p.getByText(/Department in-charge unavailable — a reminder can be scheduled/)).toBeVisible();
    await expect(p.getByRole("button", { name: /^(Acknowledge|Start Work|Mark Resolved|Submit resolution)/i })).toHaveCount(0);
  });

  test("Send reminder: the existing reminder flow targets the server-derived effective in-charge", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password, { width: 1366, height: 900 });
    await p.goto("/government");
    await row(p, "critical").getByRole("link", { name: "Send reminder" }).click();
    await p.waitForURL(new RegExp(`/reports/${ids.critical}#reminders$`), { timeout: 20_000 });

    await p.locator('input[name="title"]').fill("G5 E2E follow-up");
    await p.locator('textarea[name="message"]').fill("Please share the repair status for this critical issue.");
    await p.getByRole("button", { name: "Tomorrow" }).click();
    await p.getByRole("button", { name: "Schedule reminder" }).click();
    await expect(p.getByText("Reminder scheduled.")).toBeVisible({ timeout: 20_000 });

    const { data: reminders } = await admin.from("reminders").select("recipient_id, created_by, department_id, status").eq("report_id", ids.critical);
    expect(reminders).toHaveLength(1);
    expect(reminders![0]).toMatchObject({
      recipient_id: incharge1Id,
      created_by: await userId(TEST_GOVERNMENT.email),
      department_id: roadsId,
      status: "scheduled",
    });

    // The command center now shows the follow-up state for that report.
    await p.goto("/government");
    await expect(row(p, "critical")).toContainText("Reminder scheduled", { timeout: 20_000 });
  });

  test("empty jurisdiction: honest 'No action required right now.' and zero counts", async ({ browser }) => {
    const p = await signedInPage(browser, emptyGov.email);
    await p.goto("/government");
    await expect(p.getByTestId("action-required-empty")).toContainText("No action required right now.", { timeout: 20_000 });
    for (const id of ["count-action-required", "count-critical", "count-pending_over_7_days", "count-follow_up_due", "count-reopened", "count-routing_pending"]) {
      await expect(p.getByTestId(id)).toHaveText("0");
    }
  });

  test("mobile: action items render as cards (no horizontal table)", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password, { width: 390, height: 844 });
    await p.goto("/government");
    const card = p.getByTestId("action-card").filter({ hasText: T("critical") });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText("Critical issue");
    await expect(p.getByTestId("action-row").first()).toBeHidden();
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await card.screenshot({ path: "test-results/g5-action-required-mobile.png" });
  });

  test("access control: signed-out, citizen and department in-charge cannot open the command center", async ({ browser }) => {
    const anonContext = await browser.newContext();
    const anon = await anonContext.newPage();
    await anon.goto("/government");
    await expect(anon).toHaveURL(/\/sign-in/);

    const citizen = await signedInPage(browser, TEST_CITIZEN.email, TEST_CITIZEN.password);
    await citizen.goto("/government");
    await expect(citizen).toHaveURL(/\/dashboard/);
    await expect(citizen.getByText(T("critical"))).toHaveCount(0);

    const incharge = await signedInPage(browser, TEST_DEPARTMENT_INCHARGE.email, TEST_DEPARTMENT_INCHARGE.password);
    await incharge.goto("/government?queue=critical");
    await expect(incharge).toHaveURL(/\/department/);
  });
});
