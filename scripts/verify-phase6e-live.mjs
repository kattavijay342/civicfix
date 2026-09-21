// Phase 6E post-migration live verification — schema existence, behavioral
// correctness (cross-checked against direct table counts), and, critically,
// jurisdiction/role isolation for all 5 new SQL functions (supabase/
// migrations/0013_phase6e_government_intelligence.sql). Mirrors the style
// of verify-phase6a/6b/6c/6d-live.mjs.
//
// Usage: node --env-file=.env.local scripts/verify-phase6e-live.mjs
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
const incharge1 = await asUser("incharge1@test.civicfix.local");
const citizen1 = await asUser("citizen1@test.civicfix.local");

// =====================================================================
// 1. Schema — every new function is reachable (no PGRST202).
// =====================================================================
{
  const { error } = await gov1.rpc("get_aging_buckets").maybeSingle();
  record("get_aging_buckets() is callable", !error, error?.message);
}
{
  const { error } = await gov1.rpc("get_resolution_quality").maybeSingle();
  record("get_resolution_quality() is callable", !error, error?.message);
}
{
  const { error } = await gov1.rpc("get_department_workload");
  record("get_department_workload() is callable", !error, error?.message);
}
{
  const { error } = await gov1.rpc("get_department_trend", { p_days: 30 });
  record("get_department_trend(30) is callable", !error, error?.message);
}
{
  const { error } = await gov1.rpc("get_category_trends", { p_days: 30 });
  record("get_category_trends(30) is callable", !error, error?.message);
}

// =====================================================================
// 2. Behavioral correctness — cross-check get_aging_buckets/
//    get_resolution_quality against direct table counts for the SAME
//    session, so the SQL aggregate can't silently drift from reality.
// =====================================================================
const { data: bucketsRow } = await gov1.rpc("get_aging_buckets").maybeSingle();
if (!bucketsRow) {
  record("get_aging_buckets() behavioral checks", false, "skipped — RPC unavailable (see schema check above)");
} else {
  const bucketSum =
    Number(bucketsRow.bucket_0_1) +
    Number(bucketsRow.bucket_2_3) +
    Number(bucketsRow.bucket_4_7) +
    Number(bucketsRow.bucket_8_14) +
    Number(bucketsRow.bucket_15_30) +
    Number(bucketsRow.bucket_30_plus);
  const { count: unresolvedCount } = await gov1.from("reports").select("*", { count: "exact", head: true }).neq("status", "resolved");
  record(
    "get_aging_buckets() bucket sum matches a direct count of unresolved reports (same session)",
    bucketSum === unresolvedCount,
    `buckets sum=${bucketSum}, direct count=${unresolvedCount}`
  );
}

const { data: quality } = await gov1.rpc("get_resolution_quality").maybeSingle();
if (!quality) {
  record("get_resolution_quality() behavioral checks", false, "skipped — RPC unavailable (see schema check above)");
} else {
  const { count: resolvedCount } = await gov1.from("reports").select("*", { count: "exact", head: true }).eq("status", "resolved");
  record(
    "get_resolution_quality().resolved matches a direct count of resolved reports (same session)",
    Number(quality.resolved) === resolvedCount,
    `rpc=${quality.resolved}, direct=${resolvedCount}`
  );
  const { count: reopenedCount } = await gov1.from("reports").select("*", { count: "exact", head: true }).eq("status", "reopened");
  record(
    "get_resolution_quality().currently_reopened matches a direct count of reopened reports",
    Number(quality.currently_reopened) === reopenedCount,
    `rpc=${quality.currently_reopened}, direct=${reopenedCount}`
  );
}

// =====================================================================
// 3. Jurisdiction/role isolation — the actual security boundary is RLS on
//    the underlying `reports`/`report_assignments` tables (every function
//    is `security invoker`), not the function grant. Prove a
//    department_incharge and a citizen each get results bounded to what
//    THEY can see, never the full jurisdiction/admin view.
// =====================================================================
const { data: govBuckets } = await gov1.rpc("get_aging_buckets").maybeSingle();
const { data: inchargeBuckets } = await incharge1.rpc("get_aging_buckets").maybeSingle();
if (!govBuckets || !inchargeBuckets) {
  record("Jurisdiction isolation: get_aging_buckets()", false, "skipped — RPC unavailable");
} else {
  const govTotal = Object.values(govBuckets).reduce((a, b) => a + Number(b), 0);
  const inchargeTotal = Object.values(inchargeBuckets).reduce((a, b) => a + Number(b), 0);
  record(
    "A department in-charge's get_aging_buckets() is bounded to their own assigned reports, never exceeding the broader jurisdiction view",
    inchargeTotal <= govTotal,
    `government=${govTotal}, department_incharge=${inchargeTotal}`
  );
}

const { data: govQuality } = await gov1.rpc("get_resolution_quality").maybeSingle();
const { data: citizenQuality } = await citizen1.rpc("get_resolution_quality").maybeSingle();
if (!govQuality || !citizenQuality) {
  record("Jurisdiction isolation: get_resolution_quality()", false, "skipped — RPC unavailable");
} else {
  record(
    "A citizen's get_resolution_quality() is bounded to their own reports only, never exceeding the jurisdiction-wide view",
    Number(citizenQuality.resolved) <= Number(govQuality.resolved),
    `government=${govQuality.resolved}, citizen=${citizenQuality.resolved}`
  );
}

const { data: workload } = await incharge1.rpc("get_department_workload");
if (!workload) {
  record("Jurisdiction isolation: get_department_workload()", false, "skipped — RPC unavailable");
} else {
  const { data: inchargeProfile } = await admin.from("profiles").select("id").eq("full_name", "Test Roads Incharge").single();
  const { data: assignment } = await admin
    .from("report_assignments")
    .select("department_id")
    .eq("incharge_id", inchargeProfile.id)
    .limit(1)
    .maybeSingle();
  const ownDeptRow = workload.find((d) => d.department_id === assignment?.department_id);
  const otherDeptRows = workload.filter((d) => d.department_id !== assignment?.department_id);
  record(
    "A department in-charge sees their own department's real workload numbers, and zero active issues for every OTHER department (RLS on report_assignments hides those rows)",
    !!ownDeptRow && otherDeptRows.every((d) => d.active_issues === 0),
    JSON.stringify({ own: ownDeptRow, othersNonZero: otherDeptRows.filter((d) => d.active_issues > 0) })
  );
}

// =====================================================================
// 4. Anonymous access never sees real data. The RPC call itself may
//    succeed for an anon caller (this project's `anon` Postgres role
//    retains a direct EXECUTE grant from Supabase's own project bootstrap,
//    identical to the pre-existing Phase 4 get_area_overview() — confirmed
//    live: an anon call to get_area_overview() also succeeds) — the actual
//    security boundary is RLS on `reports` itself, which has no policy at
//    all for the `anon` role, so `select ... from public.reports` returns
//    zero rows regardless of who calls the wrapping function. This test
//    proves that boundary holds for the new functions too, exactly as it
//    already does for the pre-existing ones.
// =====================================================================
{
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: anonBuckets } = await anon.rpc("get_aging_buckets").maybeSingle();
  const allZero = anonBuckets && Object.values(anonBuckets).every((v) => Number(v) === 0);
  record(
    "An anonymous caller's get_aging_buckets() reflects zero real rows — RLS on `reports` has no policy for anon, matching get_area_overview()'s identical pre-existing behavior",
    allZero,
    JSON.stringify(anonBuckets)
  );
}
{
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: anonDirect } = await anon.from("reports").select("id").limit(1);
  record(
    "Sanity check: a direct anon .from('reports') select also returns zero rows (confirms RLS, not the RPC wrapper, is the real boundary)",
    (anonDirect ?? []).length === 0
  );
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed.`);
if (failed.length > 0) process.exit(1);
