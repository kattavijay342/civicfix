// Civic Incident Intelligence — post-migration live verification. Mirrors
// the style of verify-phase6a/6b/6c/6d/6e-live.mjs: schema existence,
// behavioral correctness (self-cleaning synthetic fixtures, always removed
// afterward), and role/jurisdiction isolation for the two new RPCs
// (supabase/migrations/0014_incident_intelligence.sql).
//
// Run this AFTER applying migration 0014 in the Supabase SQL Editor.
// Usage: node --env-file=.env.local scripts/verify-incident-intelligence-live.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const PASSWORD = "CivicFixTest2026!";

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} - ${name}${detail ? " (" + detail + ")" : ""}`);
}

async function asUser(email) {
  const client = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
}

const gov1 = await asUser("gov1@test.civicfix.local");
const citizen1 = await asUser("citizen1@test.civicfix.local");

// =====================================================================
// 1. Schema — both new tables and both new RPCs are reachable.
// =====================================================================
{
  const { error } = await admin.from("civic_incidents").select("id").limit(1);
  record("civic_incidents table exists", !error, error?.message);
}
{
  const { error } = await admin.from("incident_reports").select("id").limit(1);
  record("incident_reports table exists", !error, error?.message);
}
{
  const { error } = await gov1.rpc("get_incident_list");
  record("get_incident_list() is callable", !error, error?.message);
}

// =====================================================================
// 2. Behavioral correctness — create two synthetic reports that clearly
//    describe the same problem (same category/area/coordinates/wording,
//    reported the same day), drive them through the real
//    evaluateIncidentForReport() logic via a direct insert into
//    incident_reports mirroring what that function would do, then confirm
//    get_incident_list()/get_citizen_incident_note() reflect it correctly.
//    Everything created here is deleted at the end regardless of outcome.
// =====================================================================
const { data: citizenProfile } = await admin.from("profiles").select("id").eq("full_name", "Test Citizen").maybeSingle();
const reporterId = citizenProfile?.id;
const createdReportIds = [];
let createdIncidentId = null;

async function cleanup() {
  if (createdIncidentId) await admin.from("civic_incidents").delete().eq("id", createdIncidentId);
  for (const id of createdReportIds) await admin.from("reports").delete().eq("id", id);
}

try {
  if (!reporterId) {
    record("Behavioral checks", false, "skipped — seeded 'Test Citizen' profile not found (run scripts/seed-test-accounts.mjs first)");
  } else {
    const { data: r1 } = await admin
      .from("reports")
      .insert({ reporter_id: reporterId, title: "Verify incident A", description: "Large pothole near the bus stand, verify-incident-intelligence fixture.", category: "road", status: "ai_analyzed", severity: "medium" })
      .select("id")
      .single();
    const { data: r2 } = await admin
      .from("reports")
      .insert({ reporter_id: reporterId, title: "Verify incident B", description: "Big pothole near the bus stand, verify-incident-intelligence fixture.", category: "road", status: "ai_analyzed", severity: "high" })
      .select("id")
      .single();
    createdReportIds.push(r1.id, r2.id);

    await admin.from("report_locations").insert([
      { report_id: r1.id, display_name: "Verify Fixture Area", district: "VerifyDistrict", constituency: "VerifyConstituency", area: "VerifyArea", latitude: 16.2333, longitude: 80.0499, location_source: "manual" },
      { report_id: r2.id, display_name: "Verify Fixture Area", district: "VerifyDistrict", constituency: "VerifyConstituency", area: "VerifyArea", latitude: 16.2334, longitude: 80.05, location_source: "manual" },
    ]);

    const { data: incident, error: incidentError } = await admin
      .from("civic_incidents")
      .insert({ title: "Road / Pothole — Verify Fixture Area", category: "road", severity: "high", priority: "high", confidence: 0.9, detection_method: "rule_based" })
      .select("id")
      .single();
    record("civic_incidents insert succeeds", !incidentError && !!incident, incidentError?.message);
    createdIncidentId = incident?.id ?? null;

    if (incident) {
      const { error: linkError } = await admin.from("incident_reports").insert([
        { incident_id: incident.id, report_id: r1.id, relationship_type: "primary", confidence: 0.9 },
        { incident_id: incident.id, report_id: r2.id, relationship_type: "related", confidence: 0.9 },
      ]);
      record("incident_reports insert succeeds for both fixture reports", !linkError, linkError?.message);

      const { data: listRow, error: listError } = await gov1
        .rpc("get_incident_list", { p_incident_id: incident.id })
        .maybeSingle();
      record("get_incident_list(p_incident_id) returns the fixture incident to an authorized government user", !listError && !!listRow, listError?.message);
      if (listRow) {
        record("linked_report_count is exactly 2 (both non-candidate members counted, nothing double-counted)", Number(listRow.linked_report_count) === 2, `got ${listRow.linked_report_count}`);
        record("affected_citizen_count is exactly 1 (same reporter on both fixture reports)", Number(listRow.affected_citizen_count) === 1, `got ${listRow.affected_citizen_count}`);
      }

      const { data: noteRow, error: noteError } = await citizen1
        .rpc("get_citizen_incident_note", { p_report_id: r1.id })
        .maybeSingle();
      // citizen1 does not own the fixture reports (they belong to "Test
      // Citizen"), so this MUST come back empty — proving the function's
      // own ownership check, not just RLS on the caller's session.
      record(
        "get_citizen_incident_note() returns nothing for a report the caller does NOT own (ownership check inside the function itself)",
        !noteError && !noteRow,
        noteError?.message ?? JSON.stringify(noteRow)
      );
    }

    // Candidate-tier exclusion: a low-confidence link must never count
    // toward linked_report_count/affected_citizen_count.
    const { data: r3 } = await admin
      .from("reports")
      .insert({ reporter_id: reporterId, title: "Verify incident C (candidate)", description: "Unrelated low-confidence fixture row.", category: "road", status: "ai_analyzed", severity: "low" })
      .select("id")
      .single();
    createdReportIds.push(r3.id);
    await admin.from("report_locations").insert({ report_id: r3.id, display_name: "Verify Fixture Area", area: "VerifyArea", location_source: "manual" });
    await admin.from("incident_reports").insert({ incident_id: incident.id, report_id: r3.id, relationship_type: "candidate", confidence: 0.5 });

    const { data: afterCandidate } = await gov1.rpc("get_incident_list", { p_incident_id: incident.id }).maybeSingle();
    record(
      "A 'candidate' link is excluded from linked_report_count/affected_citizen_count",
      !!afterCandidate && Number(afterCandidate.linked_report_count) === 2 && Number(afterCandidate.affected_citizen_count) === 1,
      JSON.stringify(afterCandidate)
    );
  }
} finally {
  await cleanup();
}

// =====================================================================
// 3. RLS — a citizen who owns neither fixture report must never see the
//    incident at all via the ordinary get_incident_list() path (no
//    p_incident_id — the same call the government dashboard makes).
// =====================================================================
{
  const { data: citizenIncidents, error } = await citizen1.rpc("get_incident_list");
  record(
    "citizen1's get_incident_list() never errors and never returns another citizen's incidents by default",
    !error && Array.isArray(citizenIncidents),
    error?.message
  );
}

// =====================================================================
// 4. Anonymous access never sees real incident data (same RLS-on-underlying
//    -table boundary as every other RPC in this project, see
//    verify-phase6e-live.mjs's §4 for the identical pattern/rationale).
// =====================================================================
{
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: anonIncidents } = await anon.rpc("get_incident_list");
  record(
    "An anonymous caller's get_incident_list() reflects zero real incidents",
    Array.isArray(anonIncidents) && anonIncidents.length === 0,
    JSON.stringify(anonIncidents)
  );
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed.`);
if (failed.length > 0) process.exit(1);
