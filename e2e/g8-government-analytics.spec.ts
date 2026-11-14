import { test, expect, type Browser, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { TEST_CITIZEN, TEST_GOVERNMENT } from "./fixtures";
import { assertLocalSupabase, requireLocalSupabaseEnv } from "./local-supabase-guard";

/**
 * Phase G8 — Government Analytics in a real browser against the real server
 * and RLS of the LOCAL Docker Supabase stack. Requires migration
 * 0018_g8_area_breakdown.sql. Independent of Gemini: every assertion is on
 * the deterministic, database-backed sections.
 *
 * Fixtures ("G8 E2E" + RUN_ID): reports in gov1's jurisdiction and in a
 * synthetic jurisdiction unique to this run, plus a throwaway government
 * user scoped to that synthetic jurisdiction. Everything is deleted in
 * afterAll.
 *
 * Local only: loads .env.g8-local, never .env.local; the guard below aborts
 * the whole file for any URL other than http://127.0.0.1:54321 /
 * http://localhost:54321 or any non-local key.
 */
const SUPABASE_URL = requireLocalSupabaseEnv().url;

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const T = (tag: string) => `G8 E2E ${tag} ${RUN_ID}`;
const PASSWORD = "CivicFixTest2026!";
const NARASARAOPET = { state: "Andhra Pradesh", district: "Palnadu", constituency: "Narasaraopet", area: "Narasaraopet Municipality" };
const OTHER = { state: `G8 E2E State ${RUN_ID}`, district: "G8 E2E District", constituency: "G8 E2E Constituency", area: `G8 E2E Area ${RUN_ID}` };

let admin: SupabaseClient;
const reportIds: string[] = [];
const userIds: string[] = [];
let otherGovEmail: string;

type StorageState = Awaited<ReturnType<import("@playwright/test").BrowserContext["storageState"]>>;
const sessions = new Map<string, StorageState>();

async function signedInPage(browser: Browser, email: string, password = PASSWORD): Promise<Page> {
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
  const context = await browser.newContext({ storageState: sessions.get(email) });
  return context.newPage();
}

async function userId(email: string) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  return data.users.find((u) => u.email === email)!.id;
}

async function fixture(key: string, opts: { status?: string; priority?: string; jurisdiction?: typeof NARASARAOPET }) {
  const { status = "routed", priority = "medium", jurisdiction = NARASARAOPET } = opts;
  const title = T(key);
  const { data: report, error } = await admin
    .from("reports")
    .insert({
      reporter_id: await userId(TEST_CITIZEN.email),
      title,
      description: `${title}. Disposable G8 E2E fixture — deleted after the run.`,
      category: "road",
      status,
      priority,
      severity: priority,
    })
    .select("id")
    .single();
  if (error) throw error;
  reportIds.push(report.id);
  const loc = await admin.from("report_locations").insert({ report_id: report.id, display_name: `G8 fixture spot ${RUN_ID}`, ...jurisdiction, location_source: "manual" });
  if (loc.error) throw loc.error;
}

async function openDashboard(p: Page) {
  await p.goto("/government");
  await expect(p.getByRole("heading", { name: "Area Overview" })).toBeVisible({ timeout: 30_000 });
}

const kpi = (p: Page, label: string) => p.getByTestId("overview-kpis").getByText(label, { exact: true }).locator("..");
/** The KPI card's value paragraph (DashboardStat renders value before label). */
const kpiValue = (p: Page, label: string) => kpi(p, label).locator("p").first();

test.describe.serial("G8 government analytics", () => {
  test.beforeAll(async () => {
    // Re-checked right before the service-role client exists (env could only
    // have changed if something mutated process.env after import).
    admin = createClient(assertLocalSupabase(SUPABASE_URL), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: user, error } = await admin.auth.admin.createUser({
      email: `g8-e2e-gov-${RUN_ID}@test.civicfix.local`,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw error;
    userIds.push(user.user.id);
    otherGovEmail = user.user.email!;
    await admin
      .from("profiles")
      .update({ role: "government", gov_state: OTHER.state, gov_district: OTHER.district, gov_constituency: OTHER.constituency, gov_area: OTHER.area })
      .eq("id", user.user.id);

    await fixture("nrt-critical-open", { priority: "critical" });
    await fixture("nrt-critical-resolved", { priority: "critical", status: "resolved" });
    await fixture("other-critical", { priority: "critical", jurisdiction: OTHER });
    await fixture("other-low", { priority: "low", jurisdiction: OTHER });
  });

  test.afterAll(async () => {
    if (!admin) return;
    if (reportIds.length) await admin.from("reports").delete().in("id", reportIds);
    for (const id of userIds) await admin.auth.admin.deleteUser(id);
    const { count } = await admin.from("reports").select("*", { count: "exact", head: true }).ilike("title", "G8 E2E%");
    expect(count).toBe(0);
  });

  test("Critical KPI shows open criticals only and matches the Area Concentration table", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);
    await openDashboard(p);
    await expect(kpi(p, "Critical (open)")).toBeVisible();
    await expect(p.getByText("Critical counts unresolved critical-priority issues only.")).toBeVisible();

    const rows = p.getByTestId("area-breakdown-row");
    await expect(rows.first()).toBeVisible();
    const cells = await rows.evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td")].slice(1).map((td) => Number(td.textContent))));
    const sums = cells.reduce((s, [t, pe, c, r]) => ({ t: s.t + t, pe: s.pe + pe, c: s.c + c, r: s.r + r }), { t: 0, pe: 0, c: 0, r: 0 });
    await expect(kpiValue(p, "Total Issues")).toHaveText(String(sums.t));
    await expect(kpiValue(p, "Pending")).toHaveText(String(sums.pe));
    await expect(kpiValue(p, "Critical (open)")).toHaveText(String(sums.c));
    await expect(kpiValue(p, "Resolved")).toHaveText(String(sums.r));
  });

  test("the jurisdiction filter offers only gov1's places and totals come from the area breakdown", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);
    await openDashboard(p);
    const selects = p.locator("select");
    const stateOptions = await selects.nth(0).locator("option").allTextContents();
    expect(stateOptions).toContain(NARASARAOPET.state);
    expect(stateOptions.some((o) => o.startsWith("G8 E2E State"))).toBe(false);

    await selects.nth(0).selectOption(NARASARAOPET.state);
    await selects.nth(1).selectOption(NARASARAOPET.district);
    await selects.nth(2).selectOption(NARASARAOPET.constituency);
    await selects.nth(3).selectOption(NARASARAOPET.area);
    await expect(p.getByText("Totals for this area filter, from all of its issues.")).toBeVisible();

    const areaRow = p.getByTestId("area-breakdown-row").filter({ hasText: NARASARAOPET.area }).filter({ hasText: NARASARAOPET.constituency });
    const [total, pending, critical, resolved] = await areaRow.locator("td").evaluateAll((tds) => tds.slice(1).map((td) => td.textContent));
    await expect(kpiValue(p, "Total Issues")).toHaveText(total!);
    await expect(kpiValue(p, "Pending")).toHaveText(pending!);
    await expect(kpiValue(p, "Critical (open)")).toHaveText(critical!);
    await expect(kpiValue(p, "Resolved")).toHaveText(resolved!);
  });

  test("a government user in another jurisdiction sees only its own analytics", async ({ browser }) => {
    const p = await signedInPage(browser, otherGovEmail);
    await openDashboard(p);
    const rows = p.getByTestId("area-breakdown-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(OTHER.area);
    await expect(rows.first()).not.toContainText(NARASARAOPET.area);
    await expect(kpiValue(p, "Total Issues")).toHaveText("2");
    await expect(kpiValue(p, "Critical (open)")).toHaveText("1");
    await expect(p.getByText(T("nrt-critical-open"))).toHaveCount(0);
  });

  test("department performance shows no fabricated trend and — for empty averages", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);
    await openDashboard(p);
    await expect(p.getByText(/[+-]\d+%/).filter({ has: p.locator("svg") })).toHaveCount(0);
    const trends = p.getByTestId("department-trend");
    expect(await trends.count()).toBeGreaterThan(0);
    for (const text of await trends.allTextContents()) expect(text.trim()).toBe("—");

    const tableRows = p.locator("table").filter({ hasText: "Avg. Resolution Time" }).locator("tbody tr");
    const rowCells = await tableRows.evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim())));
    for (const cells of rowCells) {
      const resolved = cells[2];
      const avg = cells[6];
      // No resolved issue to average → "—", never "0.0 days". (A department
      // WITH resolved issues may genuinely average 0.0 days — e.g. resolved
      // within the hour — so that value is only forbidden when resolved = 0.)
      if (resolved === "0") expect(avg).toBe("—");
      else expect(avg).toMatch(/^\d+\.\d days$/);
    }
    await expect(p.getByText(/Best Department|Worst Department|Top Performing/i)).toHaveCount(0);
  });

  test("workload shows awaiting acknowledgement and in-progress > 7 days", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);
    await openDashboard(p);
    const first = p.getByTestId("workload-row").first();
    await expect(first).toContainText("Awaiting acknowledgement:");
    await expect(first).toContainText("In progress > 7 days:");
  });

  test("category trends label both periods", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);
    await openDashboard(p);
    const chart = p.getByTestId("category-trends");
    await expect(chart.getByText("Last 30 days", { exact: true })).toBeVisible();
    await expect(chart.getByText("Previous 30 days (31–60 days ago)")).toBeVisible();
  });
});
