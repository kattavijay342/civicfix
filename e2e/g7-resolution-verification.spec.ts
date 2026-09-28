import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { TEST_CITIZEN, TEST_DEPARTMENT_INCHARGE, TEST_GOVERNMENT, tinyJpegBuffer } from "./fixtures";
import { AUTH_STATE_PATH } from "./global-setup";

/**
 * Phase G7 — Resolution -> Citizen Verification in a real browser against
 * the real server actions (submitResolution, submitResolutionFeedback) and
 * real RLS. Independent of Gemini: every fixture report is stored exactly
 * as routeReport() stores a routed report (Roads & Infrastructure ->
 * incharge1, Narasaraopet Municipality), already advanced to In Progress;
 * the G4 acknowledge/start steps are covered by g4-department-workflow.
 *
 * Unauthorized-verification coverage goes beyond hidden UI: the owner's own
 * rendered form (a bound Server Action) is re-POSTed with other users'
 * sessions, so the server itself must refuse them.
 *
 * Every fixture report (cascading media rows, evidence, feedback, history,
 * notifications), storage object and throwaway user is deleted in afterAll.
 */

try {
  process.loadEnvFile(".env.local");
} catch {
  // Env already provided by the shell/CI.
}

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const T = (tag: string) => `G7 ${tag} pothole near RTC Bus Stand ${RUN_ID}`;
const PASSWORD = "CivicFixTest2026!";
const REASON = "The pothole was only partly filled and rain water still collects there.";
const NARASARAOPET = {
  state: "Andhra Pradesh",
  district: "Palnadu",
  constituency: "Narasaraopet",
  area: "Narasaraopet Municipality",
};

let admin: SupabaseClient;
let roadsId: string;
let citizenId: string;
let inchargeId: string;
let govId: string;
const reportIds: string[] = [];
const userIds: string[] = [];
const ids: Record<"verify" | "reject" | "race" | "control" | "deactivated" | "moved", string> = {
  verify: "",
  reject: "",
  race: "",
  control: "",
  deactivated: "",
  moved: "",
};
const staleIncharges: Record<"deactivated" | "moved", string> = { deactivated: "", moved: "" };
let otherCitizen: { id: string; email: string };

// One real sign-in per principal for the whole file (Supabase Auth rate
// limits); later pages reuse that session's storage state.
const sessions = new Map<string, Awaited<ReturnType<BrowserContext["storageState"]>>>();
async function signedInPage(browser: Browser, email: string, password = PASSWORD): Promise<Page> {
  const cached = sessions.get(email);
  if (cached) return (await browser.newContext({ storageState: cached })).newPage();
  const context = await browser.newContext();
  const p = await context.newPage();
  await p.goto("/sign-in");
  await p.getByLabel("Email").fill(email);
  await p.getByLabel("Password").fill(password);
  await p.locator('button[type="submit"]', { hasText: "Sign In" }).click();
  await p.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 15_000 });
  sessions.set(email, await context.storageState());
  return p;
}

async function citizenContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ storageState: AUTH_STATE_PATH });
}

async function userId(email: string) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  return data.users.find((u) => u.email === email)!.id;
}

async function inProgressReport(tag: string, assignee = inchargeId) {
  const title = T(tag);
  const { data: report, error } = await admin
    .from("reports")
    .insert({
      reporter_id: citizenId,
      title,
      description: `${title}. Disposable G7 E2E fixture — deleted after the run.`,
      category: "road",
      status: "in_progress",
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
    .insert({ report_id: report.id, department_id: roadsId, incharge_id: assignee, assignment_method: "auto" });
  return report.id as string;
}

/** Resolved exactly as submitResolution leaves it (used for the race and
 * server-replay fixtures, where the resolve UI is not what's under test). */
async function resolvedReport(tag: string, assignee = inchargeId) {
  const id = await inProgressReport(tag, assignee);
  const path = `resolution/${id}/${randomUUID()}.jpg`;
  await admin.storage.from("report-media").upload(path, tinyJpegBuffer(), { contentType: "image/jpeg" });
  const { data: media } = await admin
    .from("report_media")
    .insert({ report_id: id, uploaded_by: inchargeId, kind: "after", file_path: path, file_type: "image", mime_type: "image/jpeg" })
    .select("id")
    .single();
  await admin.from("resolution_evidence").insert({
    report_id: id,
    after_media_id: media!.id,
    resolution_notes: "G7 E2E fixture resolution.",
    resolved_by: inchargeId,
    resolved_at: new Date().toISOString(),
  });
  await admin.from("reports").update({ status: "resolved" }).eq("id", id);
  await admin.from("status_history").insert({ report_id: id, old_status: "in_progress", new_status: "resolved", changed_by: inchargeId });
  return id;
}

const dbStatus = async (id: string) => (await admin.from("reports").select("status").eq("id", id).single()).data!.status;
const feedbackRows = async (id: string) =>
  (await admin.from("resolution_feedback").select("confirmed, comment, citizen_id").eq("report_id", id)).data ?? [];
/** The citizen's decision entries (old_status resolved). Excludes the
 * bootstrap row the reports insert trigger writes with changed_by =
 * reporter (supabase/migrations/0001_init_schema.sql). */
const citizenHistory = async (id: string) =>
  (
    await admin
      .from("status_history")
      .select("old_status, new_status, notes")
      .eq("report_id", id)
      .eq("changed_by", citizenId)
      .eq("old_status", "resolved")
  ).data ?? [];
async function notificationsFor(id: string, type: string) {
  const { data } = await admin.from("notifications").select("recipient_id").eq("related_report_id", id).eq("type", type);
  return (data ?? []).map((n) => n.recipient_id as string);
}
/** Decision notifications reach the effective in-charge and gov1 exactly
 * once each, and otherwise only other jurisdiction government users. */
async function expectDecisionRecipients(id: string, type: string) {
  const recipients = await notificationsFor(id, type);
  expect(recipients.filter((r) => r === inchargeId)).toHaveLength(1);
  expect(recipients.filter((r) => r === govId)).toHaveLength(1);
  const others = recipients.filter((r) => r !== inchargeId && r !== govId);
  if (others.length) {
    const { data: roles } = await admin.from("profiles").select("role").in("id", others);
    expect(roles!.every((r) => r.role === "government")).toBe(true);
  }
  expect(recipients).not.toContain(citizenId);
  expect(recipients).not.toContain(otherCitizen.id);
}

async function resolveThroughUi(p: Page, id: string, notes: string) {
  await p.goto(`/reports/${id}`);
  const panel = p.getByTestId("department-actions");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await panel.getByLabel("Resolution notes").fill(notes);
  await panel.getByLabel("After photo").setInputFiles({ name: "after.jpg", mimeType: "image/jpeg", buffer: tinyJpegBuffer() });
  await panel.getByRole("button", { name: "Resolve" }).click();
  await expect(panel.getByText("This report is resolved.")).toBeVisible({ timeout: 20_000 });
}

/** The owner's rendered verification form, serialized — including the
 * bound Server Action reference React renders for it. */
async function ownerFormFields(p: Page, id: string, decision: "yes" | "no") {
  await p.goto(`/reports/${id}`);
  const form = p.getByTestId("resolution-verification");
  await expect(form).toBeVisible({ timeout: 15_000 });
  const fields = await form.evaluate((f) => {
    const out: Record<string, string> = {};
    new FormData(f as HTMLFormElement).forEach((value, key) => {
      if (typeof value === "string") out[key] = value;
    });
    return out;
  });
  expect(Object.keys(fields).some((k) => k.startsWith("$ACTION"))).toBe(true);
  return { ...fields, confirmed: decision, comment: decision === "no" ? REASON : "", idempotencyKey: randomUUID() };
}

test.describe.serial("G7 resolution -> citizen verification", () => {
  test.beforeAll(async () => {
    admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: roads } = await admin.from("departments").select("id").eq("name", "Roads & Infrastructure").single();
    roadsId = roads!.id;
    citizenId = await userId(TEST_CITIZEN.email);
    inchargeId = await userId(TEST_DEPARTMENT_INCHARGE.email);
    govId = await userId(TEST_GOVERNMENT.email);

    const email = `g7-e2e-other-citizen-${RUN_ID}@test.civicfix.local`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (error) throw error;
    userIds.push(data.user.id);
    otherCitizen = { id: data.user.id, email };

    ids.verify = await inProgressReport("verify");
    ids.reject = await inProgressReport("reject");
    ids.race = await resolvedReport("race");
    ids.control = await resolvedReport("control");

    // In-charges who were effective when they resolved, then went stale:
    // one deactivated, one moved to another department.
    const { data: otherDept } = await admin.from("departments").select("id").neq("id", roadsId).limit(1).single();
    for (const tag of ["deactivated", "moved"] as const) {
      const email = `g7-e2e-${tag}-incharge-${RUN_ID}@test.civicfix.local`;
      const { data: u, error: e } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
      if (e) throw e;
      userIds.push(u.user.id);
      staleIncharges[tag] = u.user.id;
      await admin
        .from("profiles")
        .update({
          role: "department_incharge",
          department_id: roadsId,
          gov_state: NARASARAOPET.state,
          gov_district: NARASARAOPET.district,
          gov_constituency: NARASARAOPET.constituency,
          gov_area: NARASARAOPET.area,
        })
        .eq("id", u.user.id);
      await admin.from("department_incharges").insert({
        department_id: roadsId,
        profile_id: u.user.id,
        gov_state: NARASARAOPET.state,
        gov_district: NARASARAOPET.district,
        gov_constituency: NARASARAOPET.constituency,
        gov_area: NARASARAOPET.area,
        is_active: true,
      });
      ids[tag] = await resolvedReport(`stale-${tag}`, u.user.id);
    }
    await admin.from("department_incharges").update({ is_active: false }).eq("profile_id", staleIncharges.deactivated);
    await admin.from("profiles").update({ department_id: otherDept!.id }).eq("id", staleIncharges.moved);
  });

  test.afterAll(async () => {
    for (const id of reportIds) {
      const { data } = await admin.storage.from("report-media").list(`resolution/${id}`);
      if (data?.length) await admin.storage.from("report-media").remove(data.map((f) => `resolution/${id}/${f.name}`));
    }
    for (const id of reportIds) await admin.from("reports").delete().eq("id", id); // cascades
    for (const id of userIds) {
      await admin.from("department_incharges").delete().eq("profile_id", id);
      await admin.auth.admin.deleteUser(id);
    }
  });

  test("1-3. the assigned in-charge resolves with notes + after photo; the citizen is notified", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_DEPARTMENT_INCHARGE.email, TEST_DEPARTMENT_INCHARGE.password);
    await resolveThroughUi(p, ids.verify, "G7 E2E: pothole filled and compacted.");
    await resolveThroughUi(p, ids.reject, "G7 E2E: surface patched.");
    // The in-charge never gets a citizen verification control.
    await expect(p.getByTestId("resolution-verification")).toHaveCount(0);

    for (const id of [ids.verify, ids.reject]) {
      expect(await dbStatus(id)).toBe("resolved");
      const { data: evidence } = await admin.from("resolution_evidence").select("resolved_by, after_media_id").eq("report_id", id);
      expect(evidence).toHaveLength(1);
      expect(evidence![0].resolved_by).toBe(inchargeId);
      expect(evidence![0].after_media_id).toBeTruthy();
      expect(await notificationsFor(id, "report_resolved")).toEqual([citizenId]);
    }
  });

  test("unauthorized users never see verification controls; an unrelated citizen can't open the report", async ({ browser }) => {
    const gov = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);
    await gov.goto(`/reports/${ids.verify}`);
    await expect(gov.getByRole("heading", { level: 1, name: T("verify") })).toBeVisible({ timeout: 15_000 });
    await expect(gov.getByText("Resolution notes:")).toBeVisible();
    await expect(gov.getByTestId("resolution-verification")).toHaveCount(0);
    await expect(gov.getByRole("button", { name: "Verify Resolution" })).toHaveCount(0);

    const other = await signedInPage(browser, otherCitizen.email);
    await other.goto(`/reports/${ids.verify}`);
    await expect(other.getByText("Report not found")).toBeVisible({ timeout: 15_000 });
    await expect(other.getByRole("button", { name: "Verify Resolution" })).toHaveCount(0);

    const anon = await (await browser.newContext()).newPage();
    await anon.goto(`/reports/${ids.verify}`);
    await expect(anon.getByRole("button", { name: "Verify Resolution" })).toHaveCount(0);
  });

  test("server-level: replaying the owner's verification form as anyone else changes nothing", async ({ browser }) => {
    const owner = await (await citizenContext(browser)).newPage();
    const url = `/reports/${ids.control}`;
    const verifyFields = await ownerFormFields(owner, ids.control, "yes");
    const rejectFields = { ...verifyFields, confirmed: "no", comment: REASON };

    const gov = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);
    const incharge = await signedInPage(browser, TEST_DEPARTMENT_INCHARGE.email, TEST_DEPARTMENT_INCHARGE.password);
    const other = await signedInPage(browser, otherCitizen.email);
    const anonContext = await browser.newContext();

    // Same-site Origin so Next's Server Actions CSRF check PASSES — each
    // refusal below must come from the action's own authorization, not
    // from a transport-level rejection. No redirects are followed, so a
    // redirect could never be mistaken for a denial.
    const origin = new URL(test.info().project.use.baseURL ?? "http://localhost:3000").origin;
    const replay = async (context: BrowserContext, fields: Record<string, string>) => {
      const res = await context.request.post(url, {
        multipart: fields,
        headers: { Origin: origin },
        maxRedirects: 0,
      });
      const body = await res.text();
      // Next's transport-level refusals — none may occur, or the test proves nothing.
      expect(body).not.toMatch(/Invalid Server Actions request|Failed to find Server Action/);
      return res.status();
    };

    const attackers: Array<[string, BrowserContext]> = [
      ["government", gov.context()],
      ["in-charge", incharge.context()],
      ["other citizen", other.context()],
      ["signed-out", anonContext],
    ];
    for (const [name, attacker] of attackers) {
      for (const fields of [verifyFields, rejectFields]) {
        const status = await replay(attacker, { ...fields, idempotencyKey: randomUUID() });
        const rows = await feedbackRows(ids.control);
        console.log(`[G7 replay] ${name} confirmed=${fields.confirmed} -> HTTP ${status} feedbackRows=${rows.length}`);
        expect(status, `${name} replay must reach the page/action, not be refused by transport`).toBe(200);
        expect(rows, `${name} must not create a decision`).toEqual([]);
        expect(await dbStatus(ids.control)).toBe("resolved");
      }
    }
    expect(await citizenHistory(ids.control)).toEqual([]);
    expect(await notificationsFor(ids.control, "resolution_feedback_recorded")).toEqual([]);
    expect(await notificationsFor(ids.control, "issue_reopened")).toEqual([]);

    // Positive control: the same replay with the OWNER's session does
    // reach the action — so the refusals above were the server's decision.
    expect(await replay(owner.context(), verifyFields)).toBe(200);
    await expect.poll(async () => (await feedbackRows(ids.control)).length, { timeout: 15_000 }).toBe(1);
    expect((await feedbackRows(ids.control))[0]).toMatchObject({ confirmed: true, citizen_id: citizenId });
    expect(await citizenHistory(ids.control)).toHaveLength(1);
    await expectDecisionRecipients(ids.control, "resolution_feedback_recorded");
    console.log("[G7 replay] owner (positive control) -> decision recorded");
  });

  test("4-9. citizen: notification -> resolution details -> Verify (double click, stale tab) -> verified state", async ({ browser }) => {
    const context = await citizenContext(browser);
    const p = await context.newPage();
    // A second tab opened on the same resolution BEFORE verifying (stale page).
    const staleTab = await context.newPage();
    await staleTab.goto(`/reports/${ids.verify}`);
    await expect(staleTab.getByRole("button", { name: "Reject Resolution" })).toBeVisible({ timeout: 15_000 });

    await p.goto("/notifications");
    const row = p.locator("li").filter({ hasText: `"${T("verify")}" has been marked resolved.` });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText("Your report was resolved");
    await row.getByRole("link", { name: "View report" }).click();
    await p.waitForURL(new RegExp(`/reports/${ids.verify}$`), { timeout: 20_000 });

    await expect(p.locator("p", { hasText: "Resolution notes:" })).toContainText("G7 E2E: pothole filled and compacted.", {
      timeout: 15_000,
    });
    await expect(p.getByRole("img", { name: "After resolution" })).toBeVisible();
    await expect(p.getByText("Citizen verification pending")).toBeVisible();
    const form = p.getByTestId("resolution-verification");
    await expect(form.getByRole("button", { name: "Verify Resolution" })).toBeVisible();
    await expect(form.getByRole("button", { name: "Reject Resolution" })).toBeVisible();

    await form.getByRole("button", { name: "Verify Resolution" }).dblclick();
    // On success the action revalidates the page: the form is replaced by
    // the server-rendered verified state.
    await expect(p.getByTestId("resolution-verified-panel")).toContainText("You verified this resolution", { timeout: 20_000 });

    await p.reload();
    await expect(p.getByTestId("resolution-verified-panel")).toContainText("You verified this resolution", { timeout: 15_000 });
    await expect(p.getByTestId("citizen-verified-badge")).toHaveText("Resolution verified by citizen");
    await expect(p.getByTestId("resolution-verification")).toHaveCount(0);
    await p.screenshot({ path: "test-results/g7-citizen-verified.png", fullPage: true });

    // The stale tab tries to reject the already-verified resolution.
    await staleTab.getByRole("button", { name: "Reject Resolution" }).click();
    await staleTab.getByLabel("Why isn't it resolved?").fill(REASON);
    // The stale submission really reaches the server (POST awaited); the
    // server refuses it and the tab converges to the true, verified state.
    await Promise.all([
      staleTab.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(ids.verify)),
      staleTab.getByRole("button", { name: "Submit rejection" }).click(),
    ]);
    await expect(staleTab.getByTestId("resolution-verified-panel")).toBeVisible({ timeout: 20_000 });
    await expect(staleTab.getByTestId("resolution-rejected-panel")).toHaveCount(0);

    expect(await dbStatus(ids.verify)).toBe("resolved");
    const fb = await feedbackRows(ids.verify);
    expect(fb).toEqual([{ confirmed: true, comment: null, citizen_id: citizenId }]);
    expect(await citizenHistory(ids.verify)).toEqual([
      expect.objectContaining({ old_status: "resolved", new_status: "resolved" }),
    ]);
    await expectDecisionRecipients(ids.verify, "resolution_feedback_recorded");
    expect(await notificationsFor(ids.verify, "issue_reopened")).toEqual([]);
  });

  test("10-11. citizen rejects with a reason (double submit) -> reopened, previous resolution labelled", async ({ browser }) => {
    const p = await (await citizenContext(browser)).newPage();
    await p.goto(`/reports/${ids.reject}`);
    const form = p.getByTestId("resolution-verification");
    await form.getByRole("button", { name: "Reject Resolution" }).click({ timeout: 15_000 });
    await form.getByLabel("Why isn't it resolved?").fill(REASON);
    await form.getByRole("button", { name: "Submit rejection" }).dblclick();
    await expect(p.getByTestId("resolution-rejected-panel")).toContainText("You rejected the previous resolution", { timeout: 20_000 });

    await p.reload();
    await expect(p.getByTestId("resolution-rejected-panel")).toContainText(REASON, { timeout: 15_000 });
    await expect(p.getByTestId("citizen-rejected-badge")).toHaveText("Previous resolution rejected by citizen");
    await expect(p.locator("p", { hasText: "Previous resolution notes:" })).toContainText("G7 E2E: surface patched.");
    await expect(p.getByTestId("previous-resolution-label")).toBeVisible();
    await expect(p.getByText("Resolution evidence submitted")).toHaveCount(0);
    await expect(p.getByTestId("resolution-verification")).toHaveCount(0);
    await p.screenshot({ path: "test-results/g7-citizen-rejected.png", fullPage: true });

    expect(await dbStatus(ids.reject)).toBe("reopened");
    expect(await feedbackRows(ids.reject)).toEqual([{ confirmed: false, comment: REASON, citizen_id: citizenId }]);
    const history = await citizenHistory(ids.reject);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ old_status: "resolved", new_status: "reopened" });
    expect(history[0].notes).toContain(REASON);
    await expectDecisionRecipients(ids.reject, "issue_reopened");
    // The rejected resolution's evidence is preserved.
    const { data: evidence } = await admin.from("resolution_evidence").select("id").eq("report_id", ids.reject);
    expect(evidence).toHaveLength(1);
  });

  test("12. the department continues after rejection and the citizen can verify the new resolution", async ({ browser }) => {
    const p = await signedInPage(browser, TEST_DEPARTMENT_INCHARGE.email, TEST_DEPARTMENT_INCHARGE.password);
    await p.goto(`/reports/${ids.reject}`);
    const panel = p.getByTestId("department-actions");
    await expect(panel.getByText("The citizen reported this issue isn't actually resolved.")).toBeVisible({ timeout: 15_000 });
    await expect(panel).toContainText(REASON);
    await panel.getByRole("button", { name: "Acknowledge" }).click();
    await expect(panel.getByRole("button", { name: "Start work" })).toBeVisible({ timeout: 15_000 });
    await panel.getByRole("button", { name: "Start work" }).click();
    await expect(panel.getByRole("button", { name: "Resolve" })).toBeVisible({ timeout: 15_000 });
    await resolveThroughUi(p, ids.reject, "G7 E2E: fully resurfaced and drained.");
    expect(await dbStatus(ids.reject)).toBe("resolved");
    const { data: evidence } = await admin.from("resolution_evidence").select("resolution_notes").eq("report_id", ids.reject);
    expect(evidence).toEqual([{ resolution_notes: "G7 E2E: fully resurfaced and drained." }]);

    const c = await (await citizenContext(browser)).newPage();
    await c.goto(`/reports/${ids.reject}`);
    await expect(c.getByText("Citizen verification pending")).toBeVisible({ timeout: 15_000 });
    await expect(c.getByTestId("previous-resolution-label")).toHaveCount(0);
    await c.getByTestId("resolution-verification").getByRole("button", { name: "Verify Resolution" }).click();
    await expect(c.getByTestId("resolution-verified-panel")).toContainText("You verified this resolution", { timeout: 20_000 });
    expect(await feedbackRows(ids.reject)).toEqual([{ confirmed: true, comment: null, citizen_id: citizenId }]);
    expect(await dbStatus(ids.reject)).toBe("resolved");
  });

  test("17. two tabs: Verify racing Reject -> exactly one decision, consistent state", async ({ browser }) => {
    const context = await citizenContext(browser);
    const a = await context.newPage();
    const b = await context.newPage();
    await Promise.all([a.goto(`/reports/${ids.race}`), b.goto(`/reports/${ids.race}`)]);
    await b.getByRole("button", { name: "Reject Resolution" }).click({ timeout: 15_000 });
    await b.getByLabel("Why isn't it resolved?").fill(REASON);

    const posted = (p: Page) => p.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(ids.race));
    await Promise.all([
      posted(a),
      posted(b),
      a.getByRole("button", { name: "Verify Resolution" }).click(),
      b.getByRole("button", { name: "Submit rejection" }).click(),
    ]);

    const fb = await feedbackRows(ids.race);
    expect(fb).toHaveLength(1);
    expect(await citizenHistory(ids.race)).toHaveLength(1);
    expect(await dbStatus(ids.race)).toBe(fb[0].confirmed ? "resolved" : "reopened");
    const winnerType = fb[0].confirmed ? "resolution_feedback_recorded" : "issue_reopened";
    const loserType = fb[0].confirmed ? "issue_reopened" : "resolution_feedback_recorded";
    await expectDecisionRecipients(ids.race, winnerType);
    expect(await notificationsFor(ids.race, loserType)).toEqual([]);
    // Both tabs converge to the one decision that won.
    const panel = fb[0].confirmed ? "resolution-verified-panel" : "resolution-rejected-panel";
    const other = fb[0].confirmed ? "resolution-rejected-panel" : "resolution-verified-panel";
    for (const p of [a, b]) {
      await p.reload();
      await expect(p.getByTestId(panel)).toBeVisible({ timeout: 20_000 });
      await expect(p.getByTestId(other)).toHaveCount(0);
      await expect(p.getByTestId("resolution-verification")).toHaveCount(0);
    }
    console.log(`[G7 race] winner: ${fb[0].confirmed ? "verify" : "reject"}`);
  });

  test("11. a stale (deactivated / moved) in-charge receives no G7 notification; Government still does", async ({ browser }) => {
    const p = await (await citizenContext(browser)).newPage();
    for (const tag of ["deactivated", "moved"] as const) {
      await p.goto(`/reports/${ids[tag]}`);
      await p.getByTestId("resolution-verification").getByRole("button", { name: "Verify Resolution" }).click({ timeout: 15_000 });
      await expect(p.getByTestId("resolution-verified-panel")).toContainText("You verified this resolution", { timeout: 20_000 });
      const recipients = await notificationsFor(ids[tag], "resolution_feedback_recorded");
      expect(recipients, `${tag} in-charge must not be notified`).not.toContain(staleIncharges[tag]);
      expect(recipients).not.toContain(inchargeId);
      expect(recipients.filter((r) => r === govId)).toHaveLength(1);
      const { count } = await admin
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .eq("recipient_id", staleIncharges[tag]);
      expect(count, `${tag} in-charge has no notifications at all`).toBe(0);
    }
  });

  test("government sees the citizen-verified state read-only", async ({ browser }) => {
    const gov = await signedInPage(browser, TEST_GOVERNMENT.email, TEST_GOVERNMENT.password);
    await gov.goto(`/reports/${ids.verify}`);
    await expect(gov.getByTestId("citizen-verified-badge")).toHaveText("Resolution verified by citizen", { timeout: 15_000 });
    await expect(gov.getByTestId("resolution-verified-panel")).toHaveCount(0);
    await expect(gov.getByTestId("resolution-verification")).toHaveCount(0);
    await expect(gov.getByTestId("department-actions")).toHaveCount(0);
  });
});
