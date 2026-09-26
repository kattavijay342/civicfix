// G4 Department In-charge workflow — live database/RLS checks against the
// real Supabase project. Every principal reads/writes through the anon key
// + its own signed-in session, so Postgres RLS and grants decide the
// outcome. The server actions' own authorization (assignment + live
// in-charge standing + transitions) is covered by
// src/lib/actions/department.test.ts and e2e/g4-department-workflow.spec.ts;
// this script proves the database boundary underneath them:
//   - no role (not even the assigned in-charge) can write workflow state
//     directly — every mutation must go through the server actions,
//   - the compare-and-set status write lets exactly one racer win,
//   - status changes are visible to the citizen and government read paths,
//   - known DB-layer gaps are reported as INFO, never counted as passes.
//
// Fixtures: seeded citizen1, gov1, incharge1 (scripts/seed-test-accounts.mjs)
// plus throwaway @test.civicfix.local in-charges. One disposable report is
// created and deleted (cascades location/assignment/history/notifications).
// Existing reports (incl. INC-0002/INC-0003) are never touched. Sends NO email.
// Usage: node --env-file=.env.local scripts/verify-g4-workflow-live.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const noPersist = { auth: { autoRefreshToken: false, persistSession: false } };
const admin = createClient(url, serviceKey, noPersist);
const PASSWORD = "CivicFixTest2026!";

const NARASARAOPET = { state: "Andhra Pradesh", district: "Palnadu", constituency: "Narasaraopet", area: "Narasaraopet Municipality" };
const TENALI = { state: "Andhra Pradesh", district: "Guntur", constituency: "Tenali", area: "Tenali Municipality" };
const scope = (j) => ({ gov_state: j.state, gov_district: j.district, gov_constituency: j.constituency, gov_area: j.area });

const results = [];
const infos = [];
function record(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} - ${name}${detail ? ` (${detail})` : ""}`);
}
function info(name, detail) {
  infos.push(name);
  console.log(`INFO - ${name}${detail ? ` (${detail})` : ""}`);
}

const cleanupUsers = [];
const cleanupReports = [];

async function throwawayUser(tag) {
  const email = `g4-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.civicfix.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: `G4 ${tag}` } });
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

async function createRoutedReport(reporterId, departmentId, inchargeId) {
  const title = `G4 Test: pothole workflow fixture ${Date.now()}`;
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

const statusOf = async (id) => (await admin.from("reports").select("status").eq("id", id).single()).data.status;

/** Every direct write a client could attempt against workflow state. */
async function directWritesAllDenied(client, reportId, actorId) {
  const before = await statusOf(reportId);
  const { data: upd } = await client.from("reports").update({ status: "resolved" }).eq("id", reportId).select("id");
  const { error: histErr } = await client.from("status_history").insert({ report_id: reportId, old_status: before, new_status: "resolved", changed_by: actorId });
  const { error: evErr } = await client.from("resolution_evidence").insert({ report_id: reportId, resolution_notes: "forged", resolved_by: actorId ?? "00000000-0000-0000-0000-000000000000" });
  const { error: notifErr } = await client.from("notifications").insert({ recipient_id: actorId ?? "00000000-0000-0000-0000-000000000000", type: "report_resolved", title: "forged" });
  const after = await statusOf(reportId);
  const { count: forgedHist } = await admin.from("status_history").select("*", { count: "exact", head: true }).eq("report_id", reportId).eq("new_status", "resolved");
  const { count: forgedEv } = await admin.from("resolution_evidence").select("*", { count: "exact", head: true }).eq("report_id", reportId);
  return (upd ?? []).length === 0 && !!histErr && !!evErr && !!notifErr && after === before && forgedHist === 0 && forgedEv === 0;
}

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

  const incharge1 = await asUser(incharge1Auth.email);
  const citizen1 = await asUser(citizen1Auth.email);
  const gov1 = await asUser(gov1Auth.email);
  const anon = createClient(url, anonKey, noPersist);

  // Throwaway in-charges with NO department_incharges row — never routable.
  const roadsB = await throwawayUser("roads-b");
  await admin.from("profiles").update({ role: "department_incharge", department_id: roads.id, ...scope(NARASARAOPET) }).eq("id", roadsB.id);
  const waterNrt = await throwawayUser("water-nrt");
  await admin.from("profiles").update({ role: "department_incharge", department_id: water.id, ...scope(NARASARAOPET) }).eq("id", waterNrt.id);
  const roadsTenali = await throwawayUser("roads-tenali");
  await admin.from("profiles").update({ role: "department_incharge", department_id: roads.id, ...scope(TENALI) }).eq("id", roadsTenali.id);
  const roadsBSession = await asUser(roadsB.email);
  const waterSession = await asUser(waterNrt.email);
  const tenaliSession = await asUser(roadsTenali.email);

  const reportId = await createRoutedReport(citizen1.userId, roads.id, incharge1.userId);

  // 1. ALLOW read: assigned in-charge; DENY read: the three wrong in-charges
  const { data: own } = await incharge1.client.from("reports").select("id, status").eq("id", reportId).maybeSingle();
  record("TEST 1 - assigned in-charge can read its assigned report", own?.id === reportId);
  const denied = await Promise.all([roadsBSession, waterSession, tenaliSession].map((s) => s.client.from("reports").select("id").eq("id", reportId).maybeSingle()));
  record("TEST 2 - same-department other in-charge / other department / other jurisdiction cannot read it (direct id)", denied.every((r) => !r.data));

  // 3. No direct writes for ANY role — including the assigned in-charge
  record("TEST 3 - assigned in-charge cannot write status/history/evidence/notifications directly (server actions only)", await directWritesAllDenied(incharge1.client, reportId, incharge1.userId));
  record("TEST 4 - different in-charge cannot mutate the workflow", await directWritesAllDenied(roadsBSession.client, reportId, roadsB.id));
  record("TEST 5 - different-department in-charge cannot mutate the workflow", await directWritesAllDenied(waterSession.client, reportId, waterNrt.id));
  record("TEST 6 - different-jurisdiction in-charge cannot mutate the workflow", await directWritesAllDenied(tenaliSession.client, reportId, roadsTenali.id));
  record("TEST 7 - reporting citizen cannot mutate the workflow", await directWritesAllDenied(citizen1.client, reportId, citizen1.userId));
  record("TEST 8 - government user cannot mutate the workflow", await directWritesAllDenied(gov1.client, reportId, gov1.userId));
  record("TEST 9 - unauthenticated caller cannot mutate the workflow", await directWritesAllDenied(anon, reportId, null));

  // 10. Compare-and-set: the exact write updateReportStatus performs, raced.
  const race = await Promise.all(
    [1, 2, 3].map(() => admin.from("reports").update({ status: "acknowledged" }).eq("id", reportId).eq("status", "routed").select("id"))
  );
  const winners = race.filter((r) => (r.data ?? []).length === 1).length;
  record("TEST 10 - concurrent compare-and-set status writes: exactly one wins", winners === 1 && (await statusOf(reportId)) === "acknowledged", `winners=${winners}`);

  // 11. Visibility of the new status on the existing read paths
  await admin.from("reports").update({ status: "in_progress" }).eq("id", reportId).eq("status", "acknowledged");
  const [c, g, i] = await Promise.all([citizen1, gov1, incharge1].map((s) => s.client.from("reports").select("status").eq("id", reportId).maybeSingle()));
  record("TEST 11 - citizen, government and in-charge all read the updated status", [c, g, i].every((r) => r.data?.status === "in_progress"));

  // 12. resolution_evidence is one row per report: a re-resolve must UPDATE it.
  const { error: ev1 } = await admin.from("resolution_evidence").insert({ report_id: reportId, resolution_notes: "first", resolved_by: incharge1.userId });
  const { error: ev2 } = await admin.from("resolution_evidence").insert({ report_id: reportId, resolution_notes: "second", resolved_by: incharge1.userId });
  const { data: evUpd } = await admin.from("resolution_evidence").update({ resolution_notes: "second", resolved_at: new Date().toISOString() }).eq("report_id", reportId).select("resolution_notes");
  record(
    "TEST 12 - second evidence INSERT is rejected (unique report_id) and the UPDATE path submitResolution now uses succeeds",
    !ev1 && ev2?.code === "23505" && evUpd?.[0]?.resolution_notes === "second"
  );

  // 13. Stale assignment at the RLS layer (app layer is enforced — see unit/E2E tests)
  const stale = await throwawayUser("stale");
  await admin.from("profiles").update({ role: "department_incharge", department_id: roads.id, ...scope(NARASARAOPET) }).eq("id", stale.id);
  await admin.from("department_incharges").insert({ department_id: roads.id, profile_id: stale.id, ...scope(NARASARAOPET), is_active: false });
  const staleReport = await createRoutedReport(citizen1.userId, roads.id, stale.id);
  const staleSession = await asUser(stale.email);
  const { data: staleRead } = await staleSession.client.from("reports").select("id").eq("id", staleReport).maybeSingle();
  record("TEST 13 - deactivated in-charge still cannot write directly", await directWritesAllDenied(staleSession.client, staleReport, stale.id));
  if (staleRead) {
    info(
      "RLS report_assigned_to_me still lets a DEACTIVATED in-charge READ its old assignment via the API",
      "app pages/actions deny it (checkInchargeAccess); DB-level fix needs a migration — pending approval"
    );
  } else {
    record("TEST 13b - deactivated in-charge cannot read its old assignment at the RLS layer", true);
  }
  // Release the stale fixture before user cleanup (assignment FK has no ON DELETE).
  await admin.from("reports").delete().eq("id", staleReport);
  await admin.from("department_incharges").delete().eq("profile_id", stale.id);

  // 14. Carried-forward G3 item: citizen can read the assignment's incharge_id
  const { data: citizenAsg } = await citizen1.client.from("report_assignments").select("incharge_id").eq("report_id", reportId).maybeSingle();
  if (citizenAsg?.incharge_id) info("citizen can read report_assignments.incharge_id (a user id, not a name) for their own report", "G3 carried-forward item — unchanged");
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
  const { count: leftover } = await admin.from("reports").select("*", { count: "exact", head: true }).like("title", "G4 Test:%");
  console.log(`\ncleaned up ${cleanupReports.length} test report(s) and ${cleanupUsers.length - skipped} throwaway user(s); leftover G4 test reports: ${leftover}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`${results.length - failed}/${results.length} passed, ${infos.length} info`);
  process.exit(failed === 0 ? 0 : 1);
}
