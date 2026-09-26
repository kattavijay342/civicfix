// G3 AI -> Department routing — live RLS checks against the real Supabase
// project. Every read goes through the anon key + a signed-in session, so
// Postgres RLS (report_assigned_to_me / can_view_report) is the only thing
// deciding what each role sees. Routing itself (which in-charge is chosen)
// is covered by unit tests and e2e/g3-routing.spec.ts; this script proves
// the database boundary around the assignment it produces.
//
// Fixtures: seeded citizen1, gov1 and incharge1 (Roads & Infrastructure,
// Narasaraopet Municipality — scripts/seed-test-accounts.mjs), plus
// throwaway @test.civicfix.local users: a Roads in-charge scoped to Tenali,
// a Water Supply in-charge scoped to Narasaraopet, a second citizen and an
// admin. The throwaway in-charges get NO department_incharges row, so real
// routing can never assign a real report to them while this runs. The
// admin gets a random per-run password that is never printed. Every test
// report and throwaway user is deleted before exit. Sends NO email.
// Usage: node --env-file=.env.local scripts/verify-g3-routing-live.mjs
import { randomBytes } from "node:crypto";
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
function record(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} - ${name}${detail ? ` (${detail})` : ""}`);
}

const cleanupUsers = [];
const cleanupReports = [];

async function throwawayUser(tag, password = PASSWORD) {
  const email = `g3-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.civicfix.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `G3 ${tag}` },
  });
  if (error) throw new Error(`createUser(${tag}) failed: ${error.message}`);
  cleanupUsers.push(data.user.id);
  return { email, id: data.user.id, password };
}

async function asUser(email, password = PASSWORD) {
  const client = createClient(url, anonKey, noPersist);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return { client, userId: data.user.id };
}

/** Same writes src/lib/actions/reports.ts + routeReport() perform (service
 * role), producing a routed report with the given assignment. */
async function createRoutedReport(reporterId, jurisdiction, title, departmentId, inchargeId) {
  const { data: report, error } = await admin
    .from("reports")
    .insert({ reporter_id: reporterId, title, description: `${title} — G3 live routing check.`, category: "road", status: "routed", priority: "high", severity: "high" })
    .select("id")
    .single();
  if (error) throw new Error(`report insert failed: ${error.message}`);
  cleanupReports.push(report.id);
  const { error: locError } = await admin.from("report_locations").insert({
    report_id: report.id,
    display_name: `RTC Bus Stand, ${jurisdiction.area}`,
    ...jurisdiction,
    location_source: "manual",
  });
  if (locError) throw new Error(`location insert failed: ${locError.message}`);
  const { error: asgError } = await admin
    .from("report_assignments")
    .insert({ report_id: report.id, department_id: departmentId, incharge_id: inchargeId, assignment_method: "auto" });
  if (asgError) throw new Error(`assignment insert failed: ${asgError.message}`);
  return report.id;
}

async function sees(client, reportId) {
  const [r, loc, asg, hist] = await Promise.all([
    client.from("reports").select("id").eq("id", reportId).maybeSingle(),
    client.from("report_locations").select("report_id").eq("report_id", reportId).maybeSingle(),
    client.from("report_assignments").select("report_id").eq("report_id", reportId).maybeSingle(),
    client.from("status_history").select("id").eq("report_id", reportId),
  ]);
  return { report: !!r.data, location: !!loc.data, assignment: !!asg.data, history: (hist.data ?? []).length > 0 };
}
const seesNothing = (s) => !s.report && !s.location && !s.assignment && !s.history;
const seesAll = (s) => s.report && s.location && s.assignment && s.history;

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
  if (!roads || !water) throw new Error("Configured departments Roads & Infrastructure / Water Supply missing.");

  const { data: inc1Row } = await admin
    .from("department_incharges")
    .select("department_id, is_active, gov_state, gov_district, gov_constituency, gov_area")
    .eq("profile_id", incharge1Auth.id)
    .eq("department_id", roads.id)
    .maybeSingle();
  record(
    "precondition: incharge1 is an active Roads & Infrastructure in-charge for Narasaraopet Municipality",
    !!inc1Row?.is_active && inc1Row.gov_area === NARASARAOPET.area && inc1Row.gov_constituency === NARASARAOPET.constituency,
    JSON.stringify(inc1Row)
  );

  // Throwaway principals (in-charges WITHOUT department_incharges rows — never routable).
  const roadsTenaliUser = await throwawayUser("roads-tenali");
  await admin.from("profiles").update({ role: "department_incharge", department_id: roads.id, ...scope(TENALI) }).eq("id", roadsTenaliUser.id);
  const waterNrtUser = await throwawayUser("water-narasaraopet");
  await admin.from("profiles").update({ role: "department_incharge", department_id: water.id, ...scope(NARASARAOPET) }).eq("id", waterNrtUser.id);
  const citizenOtherUser = await throwawayUser("citizen-other");
  const adminUser = await throwawayUser("admin", randomBytes(24).toString("base64url"));
  await admin.from("profiles").update({ role: "admin" }).eq("id", adminUser.id);

  const citizen1 = await asUser(citizen1Auth.email);
  const gov1 = await asUser(gov1Auth.email);
  const incharge1 = await asUser(incharge1Auth.email);
  const roadsTenali = await asUser(roadsTenaliUser.email);
  const waterNrt = await asUser(waterNrtUser.email);
  const citizenOther = await asUser(citizenOtherUser.email);
  const adminSession = await asUser(adminUser.email, adminUser.password);
  const anon = createClient(url, anonKey, noPersist);

  const waterOverviewBefore = (await waterNrt.client.rpc("get_area_overview").maybeSingle()).data;

  // Report A: Roads, Narasaraopet -> incharge1 (what routing produces). Report B: Roads, Tenali, no in-charge.
  const reportA = await createRoutedReport(citizen1.userId, NARASARAOPET, "G3 Test: Large pothole near RTC Bus Stand (Narasaraopet)", roads.id, incharge1.userId);
  const reportB = await createRoutedReport(citizenOther.userId, TENALI, "G3 Test: Pothole (Tenali, unassigned)", roads.id, null);

  // 1. Correct in-charge sees it
  record("TEST 1 - Roads in-charge for Narasaraopet sees the assigned report (+ location, assignment, history)", seesAll(await sees(incharge1.client, reportA)));

  // 2. Same department, wrong jurisdiction
  record("TEST 2 - Roads in-charge for Tenali (same department, other jurisdiction) sees nothing of it", seesNothing(await sees(roadsTenali.client, reportA)));

  // 3. Same jurisdiction, wrong department
  record("TEST 3 - Water Supply in-charge for Narasaraopet (same jurisdiction, other department) sees nothing of it", seesNothing(await sees(waterNrt.client, reportA)));

  // 4. Another in-charge's / unassigned issue
  record("TEST 4 - incharge1 cannot see a report not assigned to it (Tenali, unassigned)", seesNothing(await sees(incharge1.client, reportB)));
  const { data: inc1Reports } = await incharge1.client.from("reports").select("id");
  const { data: inc1Assignments } = await admin.from("report_assignments").select("report_id").eq("incharge_id", incharge1.userId);
  const assignedToInc1 = new Set((inc1Assignments ?? []).map((a) => a.report_id));
  record(
    "TEST 4b - every report incharge1 can read is assigned to incharge1",
    (inc1Reports ?? []).length > 0 && (inc1Reports ?? []).every((r) => assignedToInc1.has(r.id)),
    `visible=${(inc1Reports ?? []).length}`
  );

  // 5. Direct URL (id lookup) across every report-keyed table
  const direct = await Promise.all([
    roadsTenali.client.from("ai_analyses").select("id").eq("report_id", reportA),
    roadsTenali.client.from("report_media").select("id").eq("report_id", reportA),
    waterNrt.client.from("ai_analyses").select("id").eq("report_id", reportA),
    waterNrt.client.from("report_media").select("id").eq("report_id", reportA),
    waterNrt.client.from("follow_ups").select("id").eq("report_id", reportA),
  ]);
  record("TEST 5 - direct id lookups (AI analysis, media, follow-ups) by unauthorized in-charges return nothing", direct.every((r) => (r.data ?? []).length === 0));

  // 6. Query-parameter manipulation
  const [inList, orFilter, byDept, countRes] = await Promise.all([
    roadsTenali.client.from("reports").select("id").in("id", [reportA, reportB]),
    waterNrt.client.from("reports").select("id").or(`id.eq.${reportA},category.eq.road`),
    roadsTenali.client.from("report_assignments").select("report_id").eq("department_id", roads.id),
    waterNrt.client.from("reports").select("*", { count: "exact", head: true }).eq("id", reportA),
  ]);
  record(
    "TEST 6 - id lists / OR filters / department filters / counts can't reach unassigned reports",
    (inList.data ?? []).length === 0 && (orFilter.data ?? []).length === 0 && (byDept.data ?? []).length === 0 && countRes.count === 0,
    `in=${(inList.data ?? []).length} or=${(orFilter.data ?? []).length} dept=${(byDept.data ?? []).length} count=${countRes.count}`
  );
  const waterOverviewAfter = (await waterNrt.client.rpc("get_area_overview").maybeSingle()).data;
  record(
    "TEST 6b - dashboard aggregate for the Water in-charge does not count the Roads report",
    Number(waterOverviewAfter?.total_issues ?? 0) === Number(waterOverviewBefore?.total_issues ?? 0),
    `${waterOverviewBefore?.total_issues} -> ${waterOverviewAfter?.total_issues}`
  );

  // 6c. Write protection: nobody can (re)assign through the API
  const { data: hijack } = await roadsTenali.client.from("report_assignments").update({ incharge_id: roadsTenali.userId }).eq("report_id", reportA).select("report_id");
  const { error: forgedInsert } = await citizen1.client
    .from("report_assignments")
    .insert({ report_id: reportA, department_id: water.id, incharge_id: waterNrt.userId });
  const { data: stillA } = await admin.from("report_assignments").select("department_id, incharge_id").eq("report_id", reportA).single();
  record(
    "TEST 6c - in-charges/citizens cannot reassign or forge an assignment (no write policy)",
    (hijack ?? []).length === 0 && !!forgedInsert && stillA.incharge_id === incharge1.userId && stillA.department_id === roads.id
  );
  await citizen1.client.from("profiles").update({ department_id: water.id, role: "department_incharge" }).eq("id", citizen1.userId);
  const { data: c1Profile } = await admin.from("profiles").select("role, department_id").eq("id", citizen1.userId).single();
  record("TEST 6d - a citizen cannot grant itself a department/in-charge role", c1Profile.role === "citizen" && c1Profile.department_id === null);
  if (c1Profile.role !== "citizen" || c1Profile.department_id !== null) {
    await admin.from("profiles").update({ role: "citizen", department_id: null }).eq("id", citizen1.userId);
  }

  // 7. Citizen access to internal assignment data
  const [c1Incharges, c1InchargeProfile, otherSeesA] = await Promise.all([
    citizen1.client.from("department_incharges").select("profile_id"),
    citizen1.client.from("profiles").select("id, full_name").eq("id", incharge1.userId).maybeSingle(),
    sees(citizenOther.client, reportA),
  ]);
  record(
    "TEST 7 - citizen cannot read the in-charge roster or the in-charge's profile; another citizen sees nothing of the report",
    (c1Incharges.data ?? []).length === 0 && !c1InchargeProfile.data && seesNothing(otherSeesA)
  );

  // 8. Government still sees it (jurisdiction-based), with the department
  const govA = await sees(gov1.client, reportA);
  const { data: govAssignment } = await gov1.client.from("report_assignments").select("department_id, incharge_id").eq("report_id", reportA).maybeSingle();
  record(
    "TEST 8 - Narasaraopet government user still sees the routed report and its department assignment",
    seesAll(govA) && govAssignment?.department_id === roads.id
  );
  record("TEST 8b - ...but not the Tenali report", seesNothing(await sees(gov1.client, reportB)));

  // 9. Unauthenticated
  const [anonAsg, anonInc, anonReports] = await Promise.all([
    anon.from("report_assignments").select("report_id").limit(5),
    anon.from("department_incharges").select("profile_id").limit(5),
    anon.from("reports").select("id").limit(5),
  ]);
  record(
    "TEST 9 - unauthenticated caller reads no assignments, in-charge roster or reports",
    (anonAsg.data ?? []).length === 0 && (anonInc.data ?? []).length === 0 && (anonReports.data ?? []).length === 0
  );

  // 10. Admin
  record("TEST 10 - admin sees both reports and their assignments", seesAll(await sees(adminSession.client, reportA)) && seesAll(await sees(adminSession.client, reportB)));

  // 11. Assignment notification is private to its recipient
  const { data: n } = await admin
    .from("notifications")
    .insert({ recipient_id: incharge1.userId, type: "report_assigned", title: "G3 probe", related_report_id: reportA })
    .select("id")
    .single();
  const [own, other] = await Promise.all([
    incharge1.client.from("notifications").select("id").eq("id", n.id).maybeSingle(),
    roadsTenali.client.from("notifications").select("id").eq("id", n.id).maybeSingle(),
  ]);
  record("TEST 11 - assignment notification readable only by its in-charge", !!own.data && !other.data);
} catch (err) {
  record("script completed without error", false, err.message);
} finally {
  for (const id of cleanupReports) await admin.from("reports").delete().eq("id", id);
  let skipped = 0;
  for (const id of cleanupUsers) {
    // report_assignments.incharge_id has no ON DELETE action: never delete a
    // user something real still points at — report it instead.
    const { count } = await admin.from("report_assignments").select("*", { count: "exact", head: true }).eq("incharge_id", id);
    if (count) {
      skipped += 1;
      console.log(`CLEANUP SKIPPED for user ${id}: still referenced by ${count} assignment(s)`);
      continue;
    }
    await admin.auth.admin.deleteUser(id);
  }
  console.log(`\ncleaned up ${cleanupReports.length} test report(s) and ${cleanupUsers.length - skipped} throwaway user(s)`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}
