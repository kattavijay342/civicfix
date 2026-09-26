// G5 Government "Action Required" command center — live database/RLS checks
// against the real Supabase project. Every principal reads/writes through
// the anon key + its own signed-in session, so Postgres RLS, grants and the
// protect_profile_fields trigger decide each outcome. The command center's
// classification is unit-tested (src/lib/action-required.test.ts) and its
// rendering is covered by e2e/g5-action-required.spec.ts; this script proves
// the database boundary those rely on:
//   - a government user sees exactly its jurisdiction's reports (and the
//     report-scoped rows the command center reads), never another's,
//   - citizens / in-charges / signed-out callers can't read government-only
//     data (department_incharges roster, other users' profiles, reminders),
//   - a government user can't read in-charge profiles directly (contact data
//     is only ever served by the server for an effective in-charge),
//   - a government user can't forge reminders, change workflow/assignment
//     state, change any jurisdiction, or edit another user's profile.
//
// Fixtures: seeded citizen1/gov1/incharge1 (scripts/seed-test-accounts.mjs)
// plus throwaway @test.civicfix.local users and "G5 Test:" reports, all
// deleted at the end. Baseline counts are compared before/after. Existing
// reports (incl. INC-0002/INC-0003) are never touched. Sends NO email.
// Usage: node --env-file=.env.local scripts/verify-g5-action-required-live.mjs
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
  const email = `g5-${tag}-${RUN}@test.civicfix.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: `G5 ${tag}` } });
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

async function fixtureReport({ reporterId, tag, jurisdiction, status = "routed", priority = "high", ageDays = 0, assignment = null }) {
  const title = `G5 Test: ${tag} ${RUN}`;
  const createdAt = new Date(Date.now() - ageDays * DAY).toISOString();
  const { data: report, error } = await admin
    .from("reports")
    .insert({ reporter_id: reporterId, title, description: `${title} — disposable, deleted by this script.`, category: "road", status, priority, severity: priority, created_at: createdAt })
    .select("id")
    .single();
  if (error) throw new Error(`report insert failed: ${error.message}`);
  cleanupReports.push(report.id);
  await admin.from("report_locations").insert({ report_id: report.id, display_name: `G5 fixture location ${RUN}`, ...jurisdiction, location_source: "manual" });
  if (assignment) await admin.from("report_assignments").insert({ report_id: report.id, ...assignment, assignment_method: "auto" });
  return report.id;
}

const ids = async (client, table, column, values) => ((await client.from(table).select(column).in(column, values)).data ?? []).map((r) => r[column]);

let baseline;
try {
  baseline = await counts();
  console.log("Baseline:", JSON.stringify(baseline));

  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const byEmail = (e) => users.users.find((u) => u.email === e);
  const [citizen1Auth, gov1Auth, incharge1Auth] = ["citizen1", "gov1", "incharge1"].map((n) => byEmail(`${n}@test.civicfix.local`));
  if (!citizen1Auth || !gov1Auth || !incharge1Auth) throw new Error("Seeded accounts missing — run scripts/seed-test-accounts.mjs first.");
  const { data: gov1Before } = await admin.from("profiles").select("gov_state, gov_district, gov_constituency, gov_area, role").eq("id", gov1Auth.id).single();

  const { data: departments } = await admin.from("departments").select("id, name");
  const roads = departments.find((d) => d.name === "Roads & Infrastructure");

  // Throwaway principals: a Tenali government user, and an in-charge whose
  // department_incharges row is INACTIVE (never routable, "stale").
  const govTenali = await throwawayUser("gov-tenali");
  await admin.from("profiles").update({ role: "government", ...scope(TENALI) }).eq("id", govTenali.id);
  const staleIncharge = await throwawayUser("stale-incharge");
  await admin.from("profiles").update({ role: "department_incharge", department_id: roads.id, mobile_number: "+910000000005" }).eq("id", staleIncharge.id);
  await admin.from("department_incharges").insert({ department_id: roads.id, profile_id: staleIncharge.id, ...scope(NARASARAOPET), is_active: false });

  const gov1 = await asUser(gov1Auth.email);
  const citizen1 = await asUser(citizen1Auth.email);
  const incharge1 = await asUser(incharge1Auth.email);
  const tenali = await asUser(govTenali.email);
  const stale = await asUser(staleIncharge.email);
  const anon = createClient(url, anonKey, noPersist);

  const otherCitizen = await throwawayUser("citizen2");
  const nrtCritical = await fixtureReport({ reporterId: otherCitizen.id, tag: "critical", jurisdiction: NARASARAOPET, priority: "critical", assignment: { department_id: roads.id, incharge_id: incharge1.userId } });
  const nrtOld = await fixtureReport({ reporterId: otherCitizen.id, tag: "pending 9 days", jurisdiction: NARASARAOPET, priority: "low", ageDays: 9, assignment: { department_id: roads.id, incharge_id: incharge1.userId } });
  const nrtStale = await fixtureReport({ reporterId: otherCitizen.id, tag: "stale in-charge", jurisdiction: NARASARAOPET, assignment: { department_id: roads.id, incharge_id: staleIncharge.id } });
  const nrtUnrouted = await fixtureReport({ reporterId: otherCitizen.id, tag: "unrouted", jurisdiction: NARASARAOPET, status: "reported", priority: null });
  const tenaliReport = await fixtureReport({ reporterId: otherCitizen.id, tag: "tenali", jurisdiction: TENALI, priority: "critical" });
  const nrtAll = [nrtCritical, nrtOld, nrtStale, nrtUnrouted];

  // ---- Jurisdiction isolation ----------------------------------------
  const govSees = await ids(gov1.client, "reports", "id", [...nrtAll, tenaliReport]);
  record("TEST 1 - ALLOW: gov1 sees every matching-jurisdiction fixture report", nrtAll.every((id) => govSees.includes(id)));
  record("TEST 2 - DENY: gov1 cannot see another jurisdiction's report (direct id)", !govSees.includes(tenaliReport));
  const tenaliSees = await ids(tenali.client, "reports", "id", [...nrtAll, tenaliReport]);
  record("TEST 3 - DENY: Tenali government user sees only Tenali, not Narasaraopet", tenaliSees.length === 1 && tenaliSees[0] === tenaliReport);

  // The exact report-scoped reads the command center loader performs.
  const locs = await ids(gov1.client, "report_locations", "report_id", [...nrtAll, tenaliReport]);
  const asg = await ids(gov1.client, "report_assignments", "report_id", [...nrtAll, tenaliReport]);
  record("TEST 4 - loader reads (locations/assignments) are jurisdiction-scoped too", locs.length === 4 && !locs.includes(tenaliReport) && asg.length === 3);

  // ---- Unresolved / queue data visible via RLS ------------------------
  const { data: unresolved } = await gov1.client.from("reports").select("id, status, priority, created_at").in("id", nrtAll).neq("status", "resolved");
  const old = unresolved.find((r) => r.id === nrtOld);
  record(
    "TEST 5 - queue facts are real stored values (critical priority, 9-day age, reported status)",
    unresolved.find((r) => r.id === nrtCritical)?.priority === "critical" &&
      Math.floor((Date.now() - new Date(old.created_at).getTime()) / DAY) === 9 &&
      unresolved.find((r) => r.id === nrtUnrouted)?.status === "reported"
  );

  // ---- Government-only data denied to other roles -----------------------
  const citizenSees = await ids(citizen1.client, "reports", "id", [...nrtAll, tenaliReport]);
  const { data: citizenRoster } = await citizen1.client.from("department_incharges").select("id");
  const { data: citizenProfiles } = await citizen1.client.from("profiles").select("id").neq("id", citizen1.userId);
  record("TEST 6 - DENY: citizen cannot see other citizens' reports, the in-charge roster, or other profiles", citizenSees.length === 0 && (citizenRoster ?? []).length === 0 && (citizenProfiles ?? []).length === 0);

  const inchargeSees = await ids(incharge1.client, "reports", "id", [...nrtAll, tenaliReport]);
  const { data: inchargeRoster } = await incharge1.client.from("department_incharges").select("profile_id");
  record(
    "TEST 7 - DENY: in-charge sees only its own effective assignments (not unrouted/stale/Tenali) and only its own roster row",
    inchargeSees.length === 2 && inchargeSees.includes(nrtCritical) && inchargeSees.includes(nrtOld) && (inchargeRoster ?? []).every((r) => r.profile_id === incharge1.userId)
  );

  const staleSees = await ids(stale.client, "reports", "id", [nrtStale]);
  record("TEST 8 - DENY: the deactivated (stale) in-charge cannot read the report still naming it", staleSees.length === 0);

  const anonReports = await ids(anon, "reports", "id", [...nrtAll, tenaliReport]);
  const { data: anonReminders } = await anon.from("reminders").select("id");
  const { data: anonRoster } = await anon.from("department_incharges").select("id");
  record("TEST 9 - DENY: signed-out caller sees no reports, reminders or roster", anonReports.length === 0 && (anonReminders ?? []).length === 0 && (anonRoster ?? []).length === 0);

  // ---- Contact data only via the server ----------------------------------
  const { data: govProfileRead } = await gov1.client.from("profiles").select("id, mobile_number").in("id", [incharge1.userId, staleIncharge.id]);
  record("TEST 10 - gov1 cannot read in-charge profiles/phones directly (server serves effective in-charge contact only)", (govProfileRead ?? []).length === 0);

  // ---- Reminders: no forging, server-derived recipient ------------------
  const forged = await gov1.client.from("reminders").insert({
    report_id: nrtCritical, created_by: govTenali.id, department_id: roads.id, recipient_id: staleIncharge.id,
    title: "forged", message: "forged reminder", scheduled_at: new Date(Date.now() + DAY).toISOString(),
  });
  const { count: forgedCount } = await admin.from("reminders").select("*", { count: "exact", head: true }).eq("report_id", nrtCritical);
  record("TEST 11 - DENY: gov1 cannot insert a reminder directly (forged recipient/creator) — server action only", !!forged.error && forgedCount === 0);

  // A reminder created the way createReminder does (service role, recipient
  // from the assignment) is visible to gov1 and the recipient, not to others.
  const { data: rem } = await admin.from("reminders").insert({
    report_id: nrtCritical, created_by: gov1.userId, department_id: roads.id, recipient_id: incharge1.userId,
    title: "G5 Test reminder", message: "G5 disposable reminder", scheduled_at: new Date(Date.now() + DAY).toISOString(),
  }).select("id").single();
  const see = async (c) => ((await c.from("reminders").select("id").eq("id", rem.id)).data ?? []).length === 1;
  record(
    "TEST 12 - reminder visibility: gov1 + recipient ALLOW; Tenali gov, citizen, stale in-charge, signed-out DENY",
    (await see(gov1.client)) && (await see(incharge1.client)) && !(await see(tenali.client)) && !(await see(citizen1.client)) && !(await see(stale.client)) && !(await see(anon))
  );
  const { data: hijack } = await tenali.client.from("reminders").update({ status: "cancelled" }).eq("id", rem.id).select("id");
  const { data: hijack2 } = await gov1.client.from("reminders").update({ recipient_id: staleIncharge.id }).eq("id", rem.id).select("id");
  const { data: remAfter } = await admin.from("reminders").select("status, recipient_id").eq("id", rem.id).single();
  record("TEST 13 - DENY: no client can cancel/redirect a reminder directly", (hijack ?? []).length === 0 && (hijack2 ?? []).length === 0 && remAfter.status === "scheduled" && remAfter.recipient_id === incharge1.userId);

  // ---- No G4 department actions for government -------------------------
  const { data: st } = await gov1.client.from("reports").update({ status: "acknowledged" }).eq("id", nrtCritical).select("id");
  const { data: asgUpd } = await gov1.client.from("report_assignments").update({ incharge_id: gov1.userId }).eq("report_id", nrtCritical).select("id");
  const asgIns = await gov1.client.from("report_assignments").insert({ report_id: nrtUnrouted, department_id: roads.id, incharge_id: incharge1.userId });
  const hist = await gov1.client.from("status_history").insert({ report_id: nrtCritical, old_status: "routed", new_status: "resolved", changed_by: gov1.userId });
  const ev = await gov1.client.from("resolution_evidence").insert({ report_id: nrtCritical, resolution_notes: "forged", resolved_by: gov1.userId });
  const { data: after } = await admin.from("reports").select("status").eq("id", nrtCritical).single();
  const { data: asgAfter } = await admin.from("report_assignments").select("incharge_id").eq("report_id", nrtCritical).single();
  const { count: unroutedAsg } = await admin.from("report_assignments").select("*", { count: "exact", head: true }).eq("report_id", nrtUnrouted);
  record(
    "TEST 14 - DENY: gov1 cannot acknowledge/resolve, write history/evidence, assign or change the in-charge",
    (st ?? []).length === 0 && (asgUpd ?? []).length === 0 && !!asgIns.error && !!hist.error && !!ev.error &&
      after.status === "routed" && asgAfter.incharge_id === incharge1.userId && unroutedAsg === 0
  );

  // ---- Jurisdiction / impersonation --------------------------------------
  await gov1.client.from("profiles").update({ gov_district: "Guntur", gov_constituency: "Tenali", gov_area: "Tenali Municipality", role: "admin" }).eq("id", gov1.userId);
  const { data: gov1After } = await admin.from("profiles").select("gov_state, gov_district, gov_constituency, gov_area, role").eq("id", gov1Auth.id).single();
  record("TEST 15 - DENY: gov1 cannot change its own jurisdiction or role (protect_profile_fields)", JSON.stringify(gov1After) === JSON.stringify(gov1Before));

  const { data: otherUpd } = await gov1.client.from("profiles").update({ gov_district: "Palnadu", full_name: "hijacked" }).eq("id", govTenali.id).select("id");
  const { data: tenaliAfter } = await admin.from("profiles").select("gov_district, full_name").eq("id", govTenali.id).single();
  record("TEST 16 - DENY: gov1 cannot change another government user's jurisdiction/profile", (otherUpd ?? []).length === 0 && tenaliAfter.gov_district === "Guntur" && tenaliAfter.full_name !== "hijacked");

  // Impersonation: the only identity RLS knows is the JWT. A forged
  // created_by in a follow-up insert is rejected (no insert policy at all).
  const fu = await gov1.client.from("follow_ups").insert({ report_id: nrtCritical, government_user_id: govTenali.id, notes: "impersonated" });
  const { count: fuCount } = await admin.from("follow_ups").select("*", { count: "exact", head: true }).eq("report_id", nrtCritical);
  record("TEST 17 - DENY: gov1 cannot write a follow-up as another government user", !!fu.error && fuCount === 0);
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
    const { count: leftover } = await admin.from("reports").select("*", { count: "exact", head: true }).ilike("title", "G5 Test:%");
    record("CLEANUP - no leftover G5 fixture reports", leftover === 0);
  }
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
