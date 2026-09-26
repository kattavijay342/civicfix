// G6 Government ↔ Department follow-up — live database/RLS checks against
// the real Supabase project. Every principal reads/writes through the anon
// key + its own signed-in session, so Postgres RLS decides each outcome.
// The server action (createReminder "Send now"/scheduled), recipient
// derivation and effective-in-charge checks are unit-tested
// (src/lib/actions/reminders.test.ts, src/lib/reminders.test.ts,
// src/lib/data/reminders.test.ts) and the UI flow by e2e/g6-follow-up.spec.ts;
// this script proves the database boundary they rely on:
//   - follow-ups (reminders rows) on a report are visible to the matching
//     government user and the effective in-charge, never to another
//     jurisdiction's government user, another department's or another
//     jurisdiction's in-charge, a citizen, or a signed-out caller,
//   - nobody can forge, redirect, cancel or "complete" a follow-up directly,
//   - the delivered notification is readable only by its recipient,
//   - duplicate scheduled follow-ups are rejected by reminders_dedupe_idx,
//   - a follow-up grants no G4 workflow power to the government user.
//   - a FORMER recipient (deactivated, moved department, re-scoped out of
//     the jurisdiction, or replaced by another in-charge) can no longer read
//     follow-ups addressed to them — requires
//     supabase/migrations/0017_g6_reminders_recipient_effective.sql; TEST 16
//     FAILS on a database where 0017 has not been applied yet.
//
// Fixtures: seeded gov1/incharge1/citizen1 plus throwaway
// @test.civicfix.local users and "G6 Test:" reports, all deleted at the
// end; baseline counts compared before/after. INC-0002/INC-0003 and other
// existing reports are never touched. Sends NO email.
// Usage: node --env-file=.env.local scripts/verify-g6-follow-up-live.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const noPersist = { auth: { autoRefreshToken: false, persistSession: false } };
const admin = createClient(url, serviceKey, noPersist);
const PASSWORD = "CivicFixTest2026!";
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

const NARASARAOPET = { state: "Andhra Pradesh", district: "Palnadu", constituency: "Narasaraopet", area: "Narasaraopet Municipality" };
const TENALI = { state: "Andhra Pradesh", district: "Guntur", constituency: "Tenali", area: "Tenali Municipality" };
const scope = (j) => ({ gov_state: j.state, gov_district: j.district, gov_constituency: j.constituency, gov_area: j.area });
const DAY = 24 * 60 * 60 * 1000;

const results = [];
function record(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} - ${name}${detail ? ` (${detail})` : ""}`);
}

const cleanupUsers = [];
const cleanupReports = [];

async function counts() {
  const c = async (t) => (await admin.from(t).select("*", { count: "exact", head: true })).count;
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  return {
    reports: await c("reports"),
    profiles: await c("profiles"),
    auth_users: users.users.length,
    departments: await c("departments"),
    department_incharges: await c("department_incharges"),
    notifications: await c("notifications"),
    reminders: await c("reminders"),
    follow_ups: await c("follow_ups"),
    report_assignments: await c("report_assignments"),
  };
}

async function throwawayUser(tag) {
  const email = `g6-${tag}-${RUN}@test.civicfix.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: `G6 ${tag}` } });
  if (error) throw new Error(`createUser(${tag}) failed: ${error.message}`);
  cleanupUsers.push(data.user.id);
  return { email, id: data.user.id };
}

async function asUser(email) {
  const client = createClient(url, anonKey, noPersist);
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return { client, userId: data.user.id };
}

async function fixtureReport({ reporterId, tag, jurisdiction, assignment }) {
  const title = `G6 Test: ${tag} ${RUN}`;
  const { data: report, error } = await admin
    .from("reports")
    .insert({ reporter_id: reporterId, title, description: `${title} — disposable, deleted by this script.`, category: "road", status: "routed", priority: "high", severity: "high" })
    .select("id")
    .single();
  if (error) throw new Error(`report insert failed: ${error.message}`);
  cleanupReports.push(report.id);
  await admin.from("report_locations").insert({ report_id: report.id, display_name: `G6 fixture location ${RUN}`, ...jurisdiction, location_source: "manual" });
  if (assignment) await admin.from("report_assignments").insert({ report_id: report.id, ...assignment, assignment_method: "auto" });
  return report.id;
}

/** A follow-up row exactly as createReminder inserts it (service role,
 * recipient/department derived from the assignment). */
async function followUp(reportId, createdBy, departmentId, recipientId, extra = {}) {
  const { data, error } = await admin
    .from("reminders")
    .insert({
      report_id: reportId, created_by: createdBy, department_id: departmentId, recipient_id: recipientId,
      title: "G6 Test follow-up", message: "Please provide an update on this issue.",
      scheduled_at: new Date().toISOString(), ...extra,
    })
    .select("id")
    .single();
  if (error) throw new Error(`reminder insert failed: ${error.message}`);
  return data.id;
}

const canSee = async (client, reminderId) => ((await client.from("reminders").select("id").eq("id", reminderId)).data ?? []).length === 1;

let baseline;
try {
  baseline = await counts();
  console.log("Baseline:", JSON.stringify(baseline));

  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const byEmail = (e) => users.users.find((u) => u.email === e);
  const [citizen1Auth, gov1Auth, incharge1Auth] = ["citizen1", "gov1", "incharge1"].map((n) => byEmail(`${n}@test.civicfix.local`));
  if (!citizen1Auth || !gov1Auth || !incharge1Auth) throw new Error("Seeded accounts missing — run scripts/seed-test-accounts.mjs first.");

  const { data: departments } = await admin.from("departments").select("id, name");
  const roads = departments.find((d) => d.name === "Roads & Infrastructure");
  const other = departments.find((d) => d.id !== roads.id);

  // Throwaway principals.
  const govTenali = await throwawayUser("gov-tenali");
  await admin.from("profiles").update({ role: "government", ...scope(TENALI) }).eq("id", govTenali.id);
  // Another department's active in-charge in the SAME jurisdiction.
  const otherDept = await throwawayUser("other-dept");
  await admin.from("profiles").update({ role: "department_incharge", department_id: other.id }).eq("id", otherDept.id);
  await admin.from("department_incharges").insert({ department_id: other.id, profile_id: otherDept.id, ...scope(NARASARAOPET), is_active: true });
  // Roads in-charge for ANOTHER jurisdiction.
  const tenaliRoads = await throwawayUser("tenali-roads");
  await admin.from("profiles").update({ role: "department_incharge", department_id: roads.id }).eq("id", tenaliRoads.id);
  await admin.from("department_incharges").insert({ department_id: roads.id, profile_id: tenaliRoads.id, ...scope(TENALI), is_active: true });
  // Two in-charges who ARE effective at first, then go stale.
  const toDeactivate = await throwawayUser("to-deactivate");
  const toMove = await throwawayUser("to-move");
  const toRescope = await throwawayUser("to-rescope");
  const toReplace = await throwawayUser("to-replace");
  for (const u of [toDeactivate, toMove, toRescope, toReplace]) {
    await admin.from("profiles").update({ role: "department_incharge", department_id: roads.id }).eq("id", u.id);
    await admin.from("department_incharges").insert({ department_id: roads.id, profile_id: u.id, ...scope(NARASARAOPET), is_active: true });
  }

  const gov1 = await asUser(gov1Auth.email);
  const citizen1 = await asUser(citizen1Auth.email);
  const incharge1 = await asUser(incharge1Auth.email);
  const tenali = await asUser(govTenali.email);
  const otherDeptC = await asUser(otherDept.email);
  const tenaliRoadsC = await asUser(tenaliRoads.email);
  const deactC = await asUser(toDeactivate.email);
  const moveC = await asUser(toMove.email);
  const rescopeC = await asUser(toRescope.email);
  const replaceC = await asUser(toReplace.email);
  const unrelated = await throwawayUser("unrelated");
  const unrelatedC = await asUser(unrelated.email);
  const anon = createClient(url, anonKey, noPersist);

  const reporter = await throwawayUser("citizen2");
  const nrtReport = await fixtureReport({ reporterId: reporter.id, tag: "effective", jurisdiction: NARASARAOPET, assignment: { department_id: roads.id, incharge_id: incharge1.userId } });
  const deactReport = await fixtureReport({ reporterId: reporter.id, tag: "to-deactivate", jurisdiction: NARASARAOPET, assignment: { department_id: roads.id, incharge_id: toDeactivate.id } });
  const moveReport = await fixtureReport({ reporterId: reporter.id, tag: "to-move", jurisdiction: NARASARAOPET, assignment: { department_id: roads.id, incharge_id: toMove.id } });
  const rescopeReport = await fixtureReport({ reporterId: reporter.id, tag: "to-rescope", jurisdiction: NARASARAOPET, assignment: { department_id: roads.id, incharge_id: toRescope.id } });
  const replaceReport = await fixtureReport({ reporterId: reporter.id, tag: "to-replace", jurisdiction: NARASARAOPET, assignment: { department_id: roads.id, incharge_id: toReplace.id } });

  // ---- Follow-up visibility (sent follow-up to the effective in-charge) ----
  const { data: notif } = await admin
    .from("notifications")
    .insert({ recipient_id: incharge1.userId, type: "reminder_due", title: "G6 Test follow-up", body: "G6 disposable", related_report_id: nrtReport })
    .select("id")
    .single();
  const sent = await followUp(nrtReport, gov1.userId, roads.id, incharge1.userId, { status: "sent", sent_at: new Date().toISOString(), notification_id: notif.id, attempt_count: 1 });

  record("TEST 1 - ALLOW: matching-jurisdiction government user sees the follow-up history", await canSee(gov1.client, sent));
  record("TEST 2 - ALLOW: the effective in-charge sees the follow-up addressed to them", await canSee(incharge1.client, sent));
  record("TEST 3 - DENY: another jurisdiction's government user", !(await canSee(tenali.client, sent)));
  record("TEST 4 - DENY: another department's in-charge (same jurisdiction)", !(await canSee(otherDeptC.client, sent)));
  record("TEST 5 - DENY: same department, another jurisdiction's in-charge", !(await canSee(tenaliRoadsC.client, sent)));
  record("TEST 6 - DENY: citizen, unrelated signed-in user and signed-out caller", !(await canSee(citizen1.client, sent)) && !(await canSee(unrelatedC.client, sent)) && !(await canSee(anon, sent)));

  // Department inbox query shape (recipient + sent + effective report ids).
  const { data: inbox } = await incharge1.client.from("reminders").select("id").eq("recipient_id", incharge1.userId).eq("status", "sent").in("report_id", [nrtReport]);
  record("TEST 7 - department inbox query returns the delivered follow-up through RLS", (inbox ?? []).some((r) => r.id === sent));

  // ---- Notification recipient correctness ---------------------------------
  const seeN = async (c) => ((await c.from("notifications").select("id").eq("id", notif.id)).data ?? []).length === 1;
  record(
    "TEST 8 - follow-up notification readable only by its recipient (not gov1, other in-charges, citizen, signed-out)",
    (await seeN(incharge1.client)) && !(await seeN(gov1.client)) && !(await seeN(otherDeptC.client)) && !(await seeN(citizen1.client)) && !(await seeN(anon))
  );

  // ---- No forging / redirecting / completing ------------------------------
  const forged = await gov1.client.from("reminders").insert({
    report_id: nrtReport, created_by: gov1.userId, department_id: other.id, recipient_id: otherDept.id,
    title: "forged", message: "forged recipient", scheduled_at: new Date(Date.now() + DAY).toISOString(),
  });
  const { count: afterForge } = await admin.from("reminders").select("*", { count: "exact", head: true }).eq("report_id", nrtReport);
  record("TEST 9 - DENY: government user cannot insert a follow-up with a forged recipient/department", !!forged.error && afterForge === 1);

  const { data: r1 } = await gov1.client.from("reminders").update({ recipient_id: otherDept.id }).eq("id", sent).select("id");
  const { data: r2 } = await incharge1.client.from("reminders").update({ status: "cancelled", failure_reason: "done" }).eq("id", sent).select("id");
  const { data: r3 } = await gov1.client.from("reminders").delete().eq("id", sent).select("id");
  const { data: sentAfter } = await admin.from("reminders").select("status, recipient_id").eq("id", sent).single();
  record(
    "TEST 10 - DENY: no client can redirect, complete/cancel or delete a follow-up directly",
    (r1 ?? []).length === 0 && (r2 ?? []).length === 0 && (r3 ?? []).length === 0 && sentAfter.status === "sent" && sentAfter.recipient_id === incharge1.userId
  );

  // ---- Duplicate prevention (reminders_dedupe_idx) ------------------------
  const slot = new Date(Date.now() + 2 * DAY).toISOString();
  const s1 = await admin.from("reminders").insert({ report_id: nrtReport, created_by: gov1.userId, department_id: roads.id, recipient_id: incharge1.userId, title: "G6 dup", message: "G6 dup", scheduled_at: slot }).select("id").single();
  const s2 = await admin.from("reminders").insert({ report_id: nrtReport, created_by: gov1.userId, department_id: roads.id, recipient_id: incharge1.userId, title: "G6 dup", message: "G6 dup", scheduled_at: slot });
  record("TEST 11 - duplicate scheduled follow-up (same report, recipient, time) rejected with 23505", !s1.error && s2.error?.code === "23505");
  await admin.from("reminders").update({ status: "sent" }).eq("id", s1.data.id);
  const s3 = await admin.from("reminders").insert({ report_id: nrtReport, created_by: gov1.userId, department_id: roads.id, recipient_id: incharge1.userId, title: "G6 dup", message: "G6 dup", scheduled_at: slot });
  record("TEST 12 - dedupe is scoped to still-scheduled rows (a delivered one doesn't block a new follow-up)", !s3.error);

  // ---- No G4 workflow power via follow-ups --------------------------------
  const { data: st } = await gov1.client.from("reports").update({ status: "in_progress" }).eq("id", nrtReport).select("id");
  const hist = await gov1.client.from("status_history").insert({ report_id: nrtReport, old_status: "routed", new_status: "acknowledged", changed_by: gov1.userId });
  const { data: asgUpd } = await gov1.client.from("report_assignments").update({ incharge_id: otherDept.id }).eq("report_id", nrtReport).select("id");
  const { data: rep } = await admin.from("reports").select("status").eq("id", nrtReport).single();
  record("TEST 13 - DENY: government user still cannot change status, history or assignment (G4 unchanged)", (st ?? []).length === 0 && !!hist.error && (asgUpd ?? []).length === 0 && rep.status === "routed");

  // ---- Stale former recipients ---------------------------------------------
  const later = { scheduled_at: new Date(Date.now() + DAY).toISOString() }; // still-scheduled follow-ups
  const deactFu = await followUp(deactReport, gov1.userId, roads.id, toDeactivate.id, later);
  const moveFu = await followUp(moveReport, gov1.userId, roads.id, toMove.id, later);
  const rescopeFu = await followUp(rescopeReport, gov1.userId, roads.id, toRescope.id, later);
  const replaceFu = await followUp(replaceReport, gov1.userId, roads.id, toReplace.id, later);
  const pairs = [[deactC, deactFu], [moveC, moveFu], [rescopeC, rescopeFu], [replaceC, replaceFu]];
  let allSeeWhileEffective = true;
  for (const [c, id] of pairs) allSeeWhileEffective &&= await canSee(c.client, id);
  record("TEST 14 - ALLOW: while effective, each in-charge reads the (scheduled) follow-up addressed to them", allSeeWhileEffective);

  await admin.from("department_incharges").update({ is_active: false }).eq("profile_id", toDeactivate.id);
  await admin.from("profiles").update({ department_id: other.id }).eq("id", toMove.id);
  await admin.from("department_incharges").update(scope(TENALI)).eq("profile_id", toRescope.id);
  await admin.from("report_assignments").update({ incharge_id: incharge1.userId }).eq("report_id", replaceReport);

  const readsReport = async (c, id) => ((await c.client.from("reports").select("id").eq("id", id)).data ?? []).length === 1;
  record(
    "TEST 15 - DENY: former in-charges can no longer read the report (G4 RLS intact)",
    !(await readsReport(deactC, deactReport)) && !(await readsReport(moveC, moveReport)) && !(await readsReport(rescopeC, rescopeReport)) && !(await readsReport(replaceC, replaceReport))
  );

  const stillSees = {
    deactivated: await canSee(deactC.client, deactFu),
    moved_department: await canSee(moveC.client, moveFu),
    rescoped_jurisdiction: await canSee(rescopeC.client, rescopeFu),
    replaced_by_new_incharge: await canSee(replaceC.client, replaceFu),
  };
  const leaks = Object.entries(stillSees).filter(([, v]) => v).map(([k]) => k);
  record(
    "TEST 16 - DENY: former recipient (deactivated / moved / wrong jurisdiction / replaced) cannot read follow-ups addressed to them [needs 0017]",
    leaks.length === 0,
    leaks.length ? `still readable by: ${leaks.join(", ")}` : ""
  );

  record("TEST 17 - ALLOW: government user keeps the follow-up history on a report whose in-charge went stale", await canSee(gov1.client, deactFu));
  record("TEST 18 - ALLOW: the NEW effective in-charge sees the follow-up history on the reassigned report", await canSee(incharge1.client, replaceFu));
} catch (err) {
  record("script completed without error", false, err instanceof Error ? err.message : String(err));
} finally {
  // Cascades: report_locations, report_assignments, status_history,
  // reminders, follow_ups, notifications(related_report_id).
  if (cleanupReports.length) await admin.from("reports").delete().in("id", cleanupReports);
  if (cleanupUsers.length) await admin.from("department_incharges").delete().in("profile_id", cleanupUsers);
  for (const id of cleanupUsers) await admin.auth.admin.deleteUser(id);

  if (baseline) {
    const final = await counts();
    const same = JSON.stringify(final) === JSON.stringify(baseline);
    record("CLEANUP - baseline counts restored (reports, users, departments, in-charges, notifications, reminders, follow-ups, assignments)", same, same ? "" : `after=${JSON.stringify(final)}`);
    const { count: leftover } = await admin.from("reports").select("*", { count: "exact", head: true }).ilike("title", "G6 Test:%");
    record("CLEANUP - no leftover G6 fixture reports", leftover === 0);
  }
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
