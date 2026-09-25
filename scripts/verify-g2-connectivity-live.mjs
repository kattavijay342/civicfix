// G2 Citizen Report -> Government connectivity — live RLS checks against the
// real Supabase project (real policies, real report_in_my_jurisdiction(),
// real security-invoker aggregate RPCs). Nothing here trusts app code: every
// read goes through the anon key + a signed-in session, so Postgres RLS is
// the only thing deciding what each role sees.
//
// Fixtures: the seeded test accounts (scripts/seed-test-accounts.mjs:
// citizen1 + gov1 scoped to Narasaraopet Municipality), plus ONE throwaway
// government user scoped to Tenali Municipality and ONE throwaway citizen,
// both on the @test.civicfix.local domain. The two test reports and both
// throwaway users are deleted before exit (notifications cascade with the
// report). Sends NO email.
// Usage: node --env-file=.env.local scripts/verify-g2-connectivity-live.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const noPersist = { auth: { autoRefreshToken: false, persistSession: false } };
const admin = createClient(url, serviceKey, noPersist);
const PASSWORD = "CivicFixTest2026!";

const NARASARAOPET = { state: "Andhra Pradesh", district: "Palnadu", constituency: "Narasaraopet", area: "Narasaraopet Municipality" };
const TENALI = { state: "Andhra Pradesh", district: "Guntur", constituency: "Tenali", area: "Tenali Municipality" };

const results = [];
function record(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} - ${name}${detail ? ` (${detail})` : ""}`);
}

const cleanupUsers = [];
const cleanupReports = [];

async function throwawayUser(tag) {
  const email = `g2-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.civicfix.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: `G2 ${tag}` },
  });
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

/** Same writes src/lib/actions/reports.ts performs (service role, after the
 * server action authenticated the citizen and resolved the jurisdiction). */
async function createTestReport(reporterId, jurisdiction, coords, title) {
  const { data: report, error } = await admin
    .from("reports")
    .insert({ reporter_id: reporterId, title, description: `${title} — G2 live connectivity check.`, category: "road", status: "ai_analyzed", priority: "high", severity: "medium" })
    .select("id")
    .single();
  if (error) throw new Error(`report insert failed: ${error.message}`);
  cleanupReports.push(report.id);
  const { error: locError } = await admin.from("report_locations").insert({
    report_id: report.id,
    display_name: `Main Road, ${jurisdiction.area}`,
    ...jurisdiction,
    latitude: coords.lat,
    longitude: coords.lng,
    location_source: "manual",
  });
  if (locError) throw new Error(`location insert failed: ${locError.message}`);
  return report.id;
}

async function overview(client) {
  const { data, error } = await client.rpc("get_area_overview").maybeSingle();
  if (error) throw new Error(`get_area_overview failed: ${error.message}`);
  return data;
}

async function visibleIds(client, table = "reports", column = "id") {
  const { data } = await client.from(table).select(column);
  return new Set((data ?? []).map((r) => r[column]));
}

try {
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const citizen1Auth = users.users.find((u) => u.email === "citizen1@test.civicfix.local");
  const gov1Auth = users.users.find((u) => u.email === "gov1@test.civicfix.local");
  if (!citizen1Auth || !gov1Auth) throw new Error("Seeded accounts missing — run scripts/seed-test-accounts.mjs first.");

  const { data: gov1Profile } = await admin.from("profiles").select("role, gov_state, gov_district, gov_constituency, gov_area").eq("id", gov1Auth.id).single();
  const gov1Scoped =
    gov1Profile.role === "government" &&
    gov1Profile.gov_state === NARASARAOPET.state &&
    gov1Profile.gov_district === NARASARAOPET.district &&
    gov1Profile.gov_constituency === NARASARAOPET.constituency &&
    gov1Profile.gov_area === NARASARAOPET.area;
  record("precondition: gov1 is a government user scoped to Narasaraopet Municipality", gov1Scoped, JSON.stringify(gov1Profile));

  // Throwaway: a second government user in a DIFFERENT jurisdiction, and a second citizen.
  const govTenaliUser = await throwawayUser("gov-tenali");
  await admin.from("profiles").update({ role: "government", gov_state: TENALI.state, gov_district: TENALI.district, gov_constituency: TENALI.constituency, gov_area: TENALI.area }).eq("id", govTenaliUser.id);
  const citizenOtherUser = await throwawayUser("citizen-other");

  const citizen1 = await asUser("citizen1@test.civicfix.local");
  const gov1 = await asUser("gov1@test.civicfix.local");
  const govTenali = await asUser(govTenaliUser.email);
  const citizenOther = await asUser(citizenOtherUser.email);
  const anon = createClient(url, anonKey, noPersist);

  const gov1Before = await overview(gov1.client);
  const tenaliBefore = await overview(govTenali.client);

  // ---- TEST 1: citizen creates report ----
  const reportA = await createTestReport(citizen1.userId, NARASARAOPET, { lat: 16.2354, lng: 80.0479 }, "G2 Test: Pothole on Main Road (Narasaraopet)");
  const reportB = await createTestReport(citizenOther.userId, TENALI, { lat: 16.2379, lng: 80.6444 }, "G2 Test: Pothole on Main Road (Tenali)");
  const { data: ownRead } = await citizen1.client.from("reports").select("id").eq("id", reportA).maybeSingle();
  record("TEST 1 - citizen's report is stored and visible in their own My Reports", ownRead?.id === reportA);

  const { error: directInsertError } = await citizen1.client
    .from("reports")
    .insert({ reporter_id: citizen1.userId, title: "forged", description: "forged direct insert", category: "road" });
  record("TEST 1b - a citizen cannot bypass the server action by inserting directly (no INSERT policy)", !!directInsertError, directInsertError?.message);

  // ---- TEST 2: same-jurisdiction government user sees it ----
  const gov1Ids = await visibleIds(gov1.client);
  record("TEST 2 - Narasaraopet government user sees the Narasaraopet report", gov1Ids.has(reportA));
  const { data: gov1Detail } = await gov1.client.from("report_locations").select("report_id, area").eq("report_id", reportA).maybeSingle();
  record("TEST 2b - ...and its location row (report detail)", gov1Detail?.area === NARASARAOPET.area);

  // ---- TEST 3: different-jurisdiction government user cannot ----
  const tenaliIds = await visibleIds(govTenali.client);
  record("TEST 3 - Tenali government user does NOT see the Narasaraopet report", !tenaliIds.has(reportA));
  record("TEST 3b - Tenali government user DOES see the Tenali report", tenaliIds.has(reportB));
  record("TEST 3c - Narasaraopet government user does NOT see the Tenali report", !gov1Ids.has(reportB));

  // ---- TEST 4: direct report id ----
  const direct = await Promise.all([
    govTenali.client.from("reports").select("id").eq("id", reportA).maybeSingle(),
    govTenali.client.from("report_locations").select("report_id").eq("report_id", reportA).maybeSingle(),
    govTenali.client.from("status_history").select("id").eq("report_id", reportA),
    govTenali.client.from("report_media").select("id").eq("report_id", reportA),
    govTenali.client.from("ai_analyses").select("id").eq("report_id", reportA).maybeSingle(),
  ]);
  const leaked = direct.some((r) => (Array.isArray(r.data) ? r.data.length > 0 : !!r.data));
  record("TEST 4 - direct id lookup of another jurisdiction's report (+ location/history/media/AI) returns nothing", !leaked);

  // ---- TEST 5: query-parameter manipulation ----
  const { data: inList } = await govTenali.client.from("reports").select("id").in("id", [reportA, reportB]);
  const { data: orFilter } = await govTenali.client.from("reports").select("id").or(`id.eq.${reportA},reporter_id.eq.${citizen1.userId}`);
  const { count: tenaliCount } = await govTenali.client.from("reports").select("*", { count: "exact", head: true }).eq("id", reportA);
  record(
    "TEST 5 - id lists / OR filters / count queries can't reach the other jurisdiction",
    (inList ?? []).every((r) => r.id !== reportA) && (orFilter ?? []).length === 0 && tenaliCount === 0,
    `in=${(inList ?? []).length} or=${(orFilter ?? []).length} count=${tenaliCount}`
  );

  // ---- TEST 6: jurisdiction filter manipulation ----
  const { data: filtered } = await govTenali.client
    .from("report_locations")
    .select("report_id")
    .eq("state", NARASARAOPET.state)
    .eq("district", NARASARAOPET.district)
    .eq("constituency", NARASARAOPET.constituency);
  const { data: filteredReports } = await govTenali.client.from("reports").select("id").eq("category", "road").eq("priority", "high");
  record(
    "TEST 6 - filtering by another jurisdiction returns no unauthorized reports",
    (filtered ?? []).length === 0 && (filteredReports ?? []).every((r) => r.id !== reportA),
    `narasaraopet-filter rows=${(filtered ?? []).length}`
  );

  // ---- TEST 7: unauthenticated ----
  const [anonReports, anonLocations, anonOverview] = await Promise.all([
    anon.from("reports").select("id").limit(5),
    anon.from("report_locations").select("report_id").limit(5),
    anon.rpc("get_area_overview").maybeSingle(),
  ]);
  const anonTotal = Number(anonOverview.data?.total_issues ?? 0);
  record(
    "TEST 7 - unauthenticated caller sees no reports, locations or counts",
    (anonReports.data ?? []).length === 0 && (anonLocations.data ?? []).length === 0 && anonTotal === 0,
    `reports=${(anonReports.data ?? []).length} locations=${(anonLocations.data ?? []).length} rpc=${anonOverview.error ? "denied" : anonTotal}`
  );

  // ---- TEST 8: citizen privacy ----
  const otherIds = await visibleIds(citizenOther.client);
  const c1Ids = await visibleIds(citizen1.client);
  record("TEST 8 - a citizen cannot see another citizen's report", !otherIds.has(reportA) && !c1Ids.has(reportB));

  // ---- TEST 9: map markers ----
  const { data: gov1Markers } = await gov1.client.from("report_locations").select("report_id, latitude, longitude").not("latitude", "is", null);
  const { data: tenaliMarkers } = await govTenali.client.from("report_locations").select("report_id, latitude, longitude").not("latitude", "is", null);
  const gov1MarkerIds = new Set((gov1Markers ?? []).map((m) => m.report_id));
  const tenaliMarkerIds = new Set((tenaliMarkers ?? []).map((m) => m.report_id));
  record(
    "TEST 9 - map coordinates returned only for authorized reports",
    gov1MarkerIds.has(reportA) && !gov1MarkerIds.has(reportB) && tenaliMarkerIds.has(reportB) && !tenaliMarkerIds.has(reportA)
  );
  const allGov1MarkersAuthorized = [...gov1MarkerIds].every((id) => gov1Ids.has(id));
  record("TEST 9b - every marker gov1 receives belongs to a report gov1 is authorized for", allGov1MarkersAuthorized);

  // ---- TEST 10: dashboard aggregates ----
  const gov1After = await overview(gov1.client);
  const tenaliAfter = await overview(govTenali.client);
  record(
    "TEST 10 - get_area_overview: Narasaraopet total +1, Tenali total +1 (each only counts its own new report)",
    Number(gov1After.total_issues) === Number(gov1Before.total_issues) + 1 &&
      Number(tenaliAfter.total_issues) === Number(tenaliBefore.total_issues) + 1,
    `gov1 ${gov1Before.total_issues}->${gov1After.total_issues}, tenali ${tenaliBefore.total_issues}->${tenaliAfter.total_issues}`
  );
  const gov1VisibleCount = (await visibleIds(gov1.client)).size;
  record(
    "TEST 10b - gov1's total equals exactly the reports RLS lets gov1 read",
    Number(gov1After.total_issues) === gov1VisibleCount,
    `rpc=${gov1After.total_issues} rows=${gov1VisibleCount}`
  );
  record(
    "TEST 10c - pending = total - resolved, and critical/rate are consistent",
    Number(gov1After.pending) === Number(gov1After.total_issues) - Number(gov1After.resolved) &&
      Number(gov1After.critical) <= Number(gov1After.total_issues)
  );

  // ---- Notifications are per-recipient ----
  const { data: n } = await admin
    .from("notifications")
    .insert({ recipient_id: gov1.userId, type: "report_created", title: "G2 probe", related_report_id: reportA })
    .select("id")
    .single();
  const { data: tenaliSeesNotif } = await govTenali.client.from("notifications").select("id").eq("id", n.id).maybeSingle();
  const { data: gov1SeesNotif } = await gov1.client.from("notifications").select("id").eq("id", n.id).maybeSingle();
  record("NOTIFY - gov1 reads its own notification; another jurisdiction's user cannot", !!gov1SeesNotif && !tenaliSeesNotif);
} catch (err) {
  record("script completed without error", false, err.message);
} finally {
  for (const id of cleanupReports) await admin.from("reports").delete().eq("id", id);
  for (const id of cleanupUsers) await admin.auth.admin.deleteUser(id);
  console.log(`\ncleaned up ${cleanupReports.length} test report(s) and ${cleanupUsers.length} throwaway user(s)`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}
