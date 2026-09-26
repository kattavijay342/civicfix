// G4 — live verification of migration 0016 (report_assigned_to_me =
// effective assignment). Every access check is a real signed-in Data API
// query, so Postgres RLS alone decides the outcome.
//
// Part 1 (read-only): evaluates migration 0016's predicate — with SQL NULL
// semantics — over EVERY current live in-charge assignment, so no
// legitimate access is lost when it is applied. Also checks, through
// incharge1's real session, that each of its assignments is readable.
// Part 2: ALLOW/DENY matrix on disposable fixtures (one report per stale
// scenario, throwaway @test.civicfix.local users), all deleted before exit.
// Existing reports/incidents are only READ, never written. Sends NO email.
//
// Before 0016 is applied the stale-scenario DENY tests are expected to FAIL
// (that is the gap 0016 closes); after, everything must PASS.
// Usage: node --env-file=.env.local scripts/verify-g4-rls-effective-assignment-live.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const noPersist = { auth: { autoRefreshToken: false, persistSession: false } };
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, noPersist);
const PASSWORD = "CivicFixTest2026!";

const NARASARAOPET = { state: "Andhra Pradesh", district: "Palnadu", constituency: "Narasaraopet", area: "Narasaraopet Municipality" };
const TENALI = { state: "Andhra Pradesh", district: "Guntur", constituency: "Tenali", area: "Tenali Municipality" };
const scope = (j) => ({ gov_state: j.state, gov_district: j.district, gov_constituency: j.constituency, gov_area: j.area });

const results = [];
function record(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} - ${name}${detail ? ` (${detail})` : ""}`);
}

const cleanupUsers = [];
const cleanupReports = [];

/** Migration 0016's WHERE clause, with SQL semantics: `a = NULL` is never true. */
function sqlPredicate(profile, assignment, row, loc) {
  if (!profile || profile.role !== "department_incharge" || profile.department_id !== assignment.department_id) return false;
  if (!row || !row.is_active || row.department_id !== assignment.department_id || !loc) return false;
  const eq = (a, b) => a !== null && b !== null && a === b;
  const pairs = [[row.gov_state, loc.state], [row.gov_district, loc.district], [row.gov_constituency, loc.constituency], [row.gov_area, loc.area]];
  if (pairs.every(([s]) => s === null)) return false;
  return pairs.every(([s, l]) => s === null || eq(s, l));
}

async function throwawayUser(tag) {
  const email = `g4rls-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.civicfix.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: `G4 RLS ${tag}` } });
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

/** Throwaway in-charge. With `row`, gets a department_incharges row. Scopes are
 * chosen so real routing can never pick them (ties go to the longest-serving
 * in-charge — incharge1 — see pickIncharge). */
async function incharge(tag, departmentId, jurisdiction, row) {
  const u = await throwawayUser(tag);
  await admin.from("profiles").update({ role: "department_incharge", department_id: departmentId, ...scope(jurisdiction) }).eq("id", u.id);
  if (row) await admin.from("department_incharges").insert({ department_id: departmentId, profile_id: u.id, ...scope(jurisdiction), is_active: true });
  return { ...u, ...(await asUser(u.email)) };
}

async function routedReport(reporterId, departmentId, inchargeId, tag) {
  const title = `G4 RLS Test: ${tag} ${Date.now()}`;
  const { data: report, error } = await admin
    .from("reports")
    .insert({ reporter_id: reporterId, title, description: `${title} — disposable, deleted by this script.`, category: "road", status: "routed", priority: "high", severity: "high" })
    .select("id")
    .single();
  if (error) throw new Error(`report insert failed: ${error.message}`);
  cleanupReports.push(report.id);
  await admin.from("report_locations").insert({ report_id: report.id, display_name: "RTC Bus Stand, Narasaraopet", ...NARASARAOPET, location_source: "manual" });
  await admin.from("report_assignments").insert({ report_id: report.id, department_id: departmentId, incharge_id: inchargeId, assignment_method: "auto" });
  return report.id;
}

/** Everything an in-charge could read about a report through the Data API. */
async function reads(client, reportId) {
  const [r, loc, asg, hist, rpc] = await Promise.all([
    client.from("reports").select("id").eq("id", reportId).maybeSingle(),
    client.from("report_locations").select("report_id").eq("report_id", reportId).maybeSingle(),
    client.from("report_assignments").select("report_id").eq("report_id", reportId).maybeSingle(),
    client.from("status_history").select("id").eq("report_id", reportId),
    client.rpc("report_assigned_to_me", { r_id: reportId }),
  ]);
  return { report: !!r.data, location: !!loc.data, assignment: !!asg.data, history: (hist.data ?? []).length > 0, rpc: rpc.data === true };
}
const none = (s) => !s.report && !s.location && !s.assignment && !s.history && !s.rpc;
const all = (s) => s.report && s.location && s.assignment && s.history && s.rpc;
const show = (s) => Object.entries(s).filter(([, v]) => v).map(([k]) => k).join(",") || "nothing";

try {
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const byEmail = (e) => users.users.find((u) => u.email === e);
  const citizen1Auth = byEmail("citizen1@test.civicfix.local");
  const gov1Auth = byEmail("gov1@test.civicfix.local");
  const incharge1Auth = byEmail("incharge1@test.civicfix.local");
  if (!citizen1Auth || !gov1Auth || !incharge1Auth) throw new Error("Seeded accounts missing — run scripts/seed-test-accounts.mjs first.");
  const { data: departments } = await admin.from("departments").select("id, name");
  const roads = departments.find((d) => d.name === "Roads & Infrastructure");
  const water = departments.find((d) => d.name === "Water Supply");

  // ---- Part 1: existing live assignments (read-only) ----
  const { data: live } = await admin.from("report_assignments").select("report_id, department_id, incharge_id").not("incharge_id", "is", null);
  let kept = 0;
  for (const a of live) {
    const [{ data: profile }, { data: row }, { data: loc }] = await Promise.all([
      admin.from("profiles").select("role, department_id").eq("id", a.incharge_id).maybeSingle(),
      admin.from("department_incharges").select("*").eq("profile_id", a.incharge_id).eq("department_id", a.department_id).maybeSingle(),
      admin.from("report_locations").select("state, district, constituency, area").eq("report_id", a.report_id).maybeSingle(),
    ]);
    if (sqlPredicate(profile, a, row, loc)) kept += 1;
    else console.log(`  would lose access: report ${a.report_id.slice(0, 8)} / in-charge ${a.incharge_id.slice(0, 8)}`);
  }
  record(`PRE - 0016 predicate keeps every current live in-charge assignment`, kept === live.length, `${kept}/${live.length}`);

  const incharge1 = await asUser(incharge1Auth.email);
  const inc1Ids = live.filter((a) => a.incharge_id === incharge1.userId).map((a) => a.report_id);
  const inc1Reads = await Promise.all(inc1Ids.map((id) => reads(incharge1.client, id)));
  record("ALLOW - incharge1 reads every one of its live assignments (report, location, assignment, history, rpc)", inc1Reads.length > 0 && inc1Reads.every(all), `${inc1Reads.filter(all).length}/${inc1Ids.length}`);
  const { data: inc1Visible } = await incharge1.client.from("reports").select("id");
  record("ALLOW - incharge1's dashboard-visible report set equals its live assignments", (inc1Visible ?? []).length === inc1Ids.length && (inc1Visible ?? []).every((r) => inc1Ids.includes(r.id)), `${(inc1Visible ?? []).length}`);

  // ---- Part 2: fixtures ----
  const citizen1 = await asUser(citizen1Auth.email);
  const gov1 = await asUser(gov1Auth.email);
  const anon = createClient(url, anonKey, noPersist);
  const otherCitizen = await asUser((await throwawayUser("citizen")).email);

  // One routable-shaped in-charge per stale scenario, each with its own report.
  const active = await incharge("active", roads.id, NARASARAOPET, true);
  const deactivated = await incharge("deactivated", roads.id, NARASARAOPET, true);
  const moved = await incharge("moved", roads.id, NARASARAOPET, true);
  const rescoped = await incharge("rescoped", roads.id, NARASARAOPET, true);
  const demoted = await incharge("demoted", roads.id, NARASARAOPET, true);
  const sameDeptOther = await incharge("same-dept-other", roads.id, NARASARAOPET, true);
  const otherDept = await incharge("other-dept", water.id, NARASARAOPET, true);
  const otherJurisdiction = await incharge("other-jurisdiction", roads.id, TENALI, true);

  const rActive = await routedReport(citizen1.userId, roads.id, active.userId, "active");
  const rDeactivated = await routedReport(citizen1.userId, roads.id, deactivated.userId, "deactivated");
  const rMoved = await routedReport(citizen1.userId, roads.id, moved.userId, "moved");
  const rRescoped = await routedReport(citizen1.userId, roads.id, rescoped.userId, "rescoped");
  const rDemoted = await routedReport(citizen1.userId, roads.id, demoted.userId, "demoted");

  // Everyone starts with full access to their own fixture.
  const startsOk = (await Promise.all([[active, rActive], [deactivated, rDeactivated], [moved, rMoved], [rescoped, rRescoped], [demoted, rDemoted]].map(([u, r]) => reads(u.client, r)))).every(all);
  record("SETUP - each fixture in-charge can read its own assignment before the change", startsOk);

  // Stale transitions (service role; fixture rows only).
  await admin.from("department_incharges").update({ is_active: false }).eq("profile_id", deactivated.userId);
  await admin.from("profiles").update({ department_id: water.id }).eq("id", moved.userId);
  await admin.from("department_incharges").update(scope(TENALI)).eq("profile_id", rescoped.userId);
  await admin.from("profiles").update({ role: "citizen", department_id: null }).eq("id", demoted.userId);

  let s;
  s = await reads(active.client, rActive);
  record("ALLOW - active, correct in-charge -> assigned report", all(s), show(s));
  s = await reads(deactivated.client, rDeactivated);
  record("DENY  - deactivated in-charge -> old assigned report", none(s), show(s));
  s = await reads(moved.client, rMoved);
  record("DENY  - in-charge moved to another department -> old report", none(s), show(s));
  s = await reads(rescoped.client, rRescoped);
  record("DENY  - jurisdiction no longer covers the report -> old report", none(s), show(s));
  s = await reads(demoted.client, rDemoted);
  record("DENY  - in-charge demoted to citizen -> old report", none(s), show(s));
  s = await reads(sameDeptOther.client, rActive);
  record("DENY  - different in-charge (same department + jurisdiction) -> report", none(s), show(s));
  s = await reads(otherDept.client, rActive);
  record("DENY  - different department -> report", none(s), show(s));
  s = await reads(otherJurisdiction.client, rActive);
  record("DENY  - different jurisdiction -> report", none(s), show(s));
  const otherCitizenSees = await otherCitizen.client.from("reports").select("id").eq("id", rActive).maybeSingle();
  record("DENY  - citizen who didn't report it -> department report", !otherCitizenSees.data);
  const anonSees = await anon.from("reports").select("id").eq("id", rActive).maybeSingle();
  const anonRpc = await anon.rpc("report_assigned_to_me", { r_id: rActive });
  record("DENY  - unauthenticated -> protected report", !anonSees.data && anonRpc.data !== true);

  // The reporting citizen and the jurisdiction's government user keep read access (unchanged paths).
  const [c1, g1] = await Promise.all([citizen1, gov1].map((u) => u.client.from("reports").select("id").eq("id", rActive).maybeSingle()));
  record("ALLOW - reporting citizen and Narasaraopet government user still read it", !!c1.data && !!g1.data);

  // No role can mutate workflow state directly, even with read access.
  let writesBlocked = true;
  for (const u of [active, citizen1, gov1, deactivated]) {
    const { data } = await u.client.from("reports").update({ status: "resolved" }).eq("id", rActive).select("id");
    if ((data ?? []).length > 0) writesBlocked = false;
  }
  const { data: anonWrite } = await anon.from("reports").update({ status: "resolved" }).eq("id", rActive).select("id");
  const { data: finalStatus } = await admin.from("reports").select("status").eq("id", rActive).single();
  record("DENY  - in-charge / citizen / government / stale in-charge / unauthenticated cannot mutate status directly", writesBlocked && (anonWrite ?? []).length === 0 && finalStatus.status === "routed");

  // Restoring standing restores access (the rule is live, not a one-way flag).
  await admin.from("department_incharges").update({ is_active: true }).eq("profile_id", deactivated.userId);
  s = await reads(deactivated.client, rDeactivated);
  record("ALLOW - re-activated in-charge regains its assignment", all(s), show(s));
} catch (err) {
  record("script completed without error", false, err.message);
} finally {
  for (const id of cleanupReports) await admin.from("reports").delete().eq("id", id);
  let skipped = 0;
  for (const id of cleanupUsers) {
    const { count } = await admin.from("report_assignments").select("*", { count: "exact", head: true }).eq("incharge_id", id);
    if (count) {
      skipped += 1;
      console.log(`CLEANUP SKIPPED for user ${id}: still referenced by ${count} assignment(s)`);
      continue;
    }
    await admin.from("department_incharges").delete().eq("profile_id", id);
    await admin.auth.admin.deleteUser(id);
  }
  const { count: leftover } = await admin.from("reports").select("*", { count: "exact", head: true }).like("title", "G4 RLS Test:%");
  console.log(`\ncleaned up ${cleanupReports.length} test report(s) and ${cleanupUsers.length - skipped} throwaway user(s); leftover G4 RLS test reports: ${leftover}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}
