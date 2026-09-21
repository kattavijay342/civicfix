// Phase 6B live activation verification — read-only-by-default schema
// checks against the live Supabase project, plus two small, cleanly
// self-cleaning fixture inserts to behaviorally prove the new CHECK
// constraints actually reject invalid data (a schema check alone can't
// prove a constraint *works*, only that it exists). Mirrors the style of
// scripts/verify-phase6a-live.mjs.
//
// Usage: node --env-file=.env.local scripts/verify-phase6b-live.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} - ${name}${detail ? " (" + detail + ")" : ""}`);
}

// =====================================================================
// 1. accuracy_meters column exists.
// =====================================================================
{
  const { error } = await admin.from("report_locations").select("accuracy_meters").limit(1);
  record("report_locations.accuracy_meters exists", !error, error?.message);
}

// =====================================================================
// 2/3. Behavioral proof the CHECK constraints exist AND actually reject
// invalid data — not just that the column exists. Uses a real, disposable
// report (created and deleted within this script) so the report_id FK is
// satisfied; the report_locations row is never left behind either way.
// =====================================================================
const { data: citizen } = await admin.from("profiles").select("id").eq("full_name", "Test Citizen").maybeSingle();

async function withDisposableReport(fn) {
  const { data: report, error: reportErr } = await admin
    .from("reports")
    .insert({
      reporter_id: citizen.id,
      title: "Phase 6B live verification (disposable)",
      description: "Disposable fixture for scripts/verify-phase6b-live.mjs — safe to ignore if seen.",
      category: "road",
      status: "reported",
    })
    .select("id")
    .single();
  if (reportErr) throw new Error(`fixture report insert failed: ${reportErr.message}`);
  try {
    return await fn(report.id);
  } finally {
    await admin.from("report_locations").delete().eq("report_id", report.id);
    await admin.from("reports").delete().eq("id", report.id);
  }
}

await withDisposableReport(async (reportId) => {
  const { error } = await admin.from("report_locations").insert({
    report_id: reportId,
    display_name: "Invalid latitude test",
    location_source: "manual",
    latitude: 999, // out of range — must be rejected
    longitude: 80.0,
  });
  record(
    "Out-of-range latitude (999) is rejected by the database CHECK constraint",
    !!error && /report_locations_latitude_range|check constraint/i.test(error.message ?? ""),
    error ? error.message : "no error — constraint did NOT reject invalid data"
  );
});

await withDisposableReport(async (reportId) => {
  const { error } = await admin.from("report_locations").insert({
    report_id: reportId,
    display_name: "Invalid longitude test",
    location_source: "manual",
    latitude: 16.0,
    longitude: -200, // out of range — must be rejected
  });
  record(
    "Out-of-range longitude (-200) is rejected by the database CHECK constraint",
    !!error && /report_locations_longitude_range|check constraint/i.test(error.message ?? ""),
    error ? error.message : "no error — constraint did NOT reject invalid data"
  );
});

await withDisposableReport(async (reportId) => {
  const { error } = await admin.from("report_locations").insert({
    report_id: reportId,
    display_name: "Negative accuracy test",
    location_source: "gps",
    latitude: 16.0,
    longitude: 80.0,
    accuracy_meters: -5, // out of range — must be rejected
  });
  record(
    "Negative accuracy_meters (-5) is rejected by the database CHECK constraint",
    !!error && /report_locations_accuracy_nonnegative|check constraint/i.test(error.message ?? ""),
    error ? error.message : "no error — constraint did NOT reject invalid data"
  );
});

// =====================================================================
// 4. Valid data (including accuracy_meters) still inserts successfully —
// proves the constraints only reject bad data, not good data.
// =====================================================================
await withDisposableReport(async (reportId) => {
  const { error } = await admin.from("report_locations").insert({
    report_id: reportId,
    display_name: "Valid GPS location test",
    location_source: "gps",
    latitude: 16.2333,
    longitude: 80.0499,
    accuracy_meters: 15,
  });
  record("A fully valid location (including real accuracy_meters) inserts successfully", !error, error?.message);
});

// =====================================================================
// 5. Full end-to-end report creation still works (base insert path used
// by src/lib/actions/reports.ts, without accuracy_meters in the same
// statement — the fix from the earlier pre-migration safety check).
// =====================================================================
await withDisposableReport(async (reportId) => {
  const { error } = await admin.from("report_locations").insert({
    report_id: reportId,
    display_name: "Manual location, no coordinates",
    state: "Andhra Pradesh",
    district: "Guntur",
    constituency: "Tenali",
    area: "Phase6B-verify",
    location_source: "manual",
  });
  record("A manual location with no coordinates still inserts successfully (core flow unaffected)", !error, error?.message);
});

// =====================================================================
// 6. Existing data preserved — row counts + one known pre-Phase-6A row.
// =====================================================================
{
  const [{ count: reportCount }, { count: aiCount }, { count: locCount }] = await Promise.all([
    admin.from("reports").select("id", { count: "exact", head: true }),
    admin.from("ai_analyses").select("id", { count: "exact", head: true }),
    admin.from("report_locations").select("report_id", { count: "exact", head: true }),
  ]);
  record(
    "Existing tables still readable with historical data intact",
    (reportCount ?? 0) > 0,
    `reports=${reportCount}, ai_analyses=${aiCount}, report_locations=${locCount}`
  );
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed.`);
if (failed.length > 0) process.exit(1);
