// Phase 6A live activation verification — read-only schema/function checks
// against the live Supabase project. Mirrors the style of the other
// scripts/verify-*.mjs files: uses the service-role client, records
// pass/fail, never writes/deletes real data.
//
// Usage: node --env-file=.env.local scripts/verify-phase6a-live.mjs
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
// 1. Column existence — checked by attempting a real, harmless select
//    (LIMIT 1, no filter) rather than information_schema, which isn't
//    exposed through PostgREST. A "column does not exist" error from
//    PostgREST is an unambiguous, reliable signal either way.
// =====================================================================
async function columnExists(table, column) {
  const { error } = await admin.from(table).select(column).limit(1);
  if (!error) return true;
  if (error.message?.includes(`column ${table}.${column} does not exist`) || error.code === "42703") return false;
  throw new Error(`Unexpected error checking ${table}.${column}: ${error.message}`);
}

record("ai_analyses.extended exists", await columnExists("ai_analyses", "extended"));
record("report_duplicate_flags.relation_type exists", await columnExists("report_duplicate_flags", "relation_type"));
record("report_duplicate_flags.reason exists", await columnExists("report_duplicate_flags", "reason"));

// =====================================================================
// 2. get_insight_metrics() must still be the ORIGINAL 7-column shape —
//    confirms migration 0009's corrected version never touched it.
// =====================================================================
const ORIGINAL_INSIGHT_KEYS = [
  "top_category",
  "top_category_count",
  "total_reports",
  "critical_unresolved",
  "aging_count",
  "last_7_days",
  "prior_7_days",
].sort();

{
  const { data, error } = await admin.rpc("get_insight_metrics").maybeSingle();
  if (error) {
    record("get_insight_metrics() executes", false, error.message);
  } else {
    const keys = Object.keys(data ?? {}).sort();
    const matches = JSON.stringify(keys) === JSON.stringify(ORIGINAL_INSIGHT_KEYS);
    record(
      "get_insight_metrics() still returns exactly its original 7 columns",
      matches,
      matches ? undefined : `got: ${JSON.stringify(keys)}`
    );
  }
}

// =====================================================================
// 3. get_area_concentration() exists and executes.
// =====================================================================
{
  const { data, error } = await admin.rpc("get_area_concentration").maybeSingle();
  if (error) {
    record("get_area_concentration() executes", false, error.message);
  } else {
    const keys = Object.keys(data ?? {}).sort();
    const expected = ["top_area", "top_area_count"].sort();
    const matches = JSON.stringify(keys) === JSON.stringify(expected);
    record(
      "get_area_concentration() returns the expected shape",
      matches,
      `data: ${JSON.stringify(data)}`
    );
  }
}

// =====================================================================
// 4. Existing data preserved — spot-check row counts (non-destructive) and
//    one known pre-Phase-6A report (from earlier E2E runs) is still intact.
// =====================================================================
{
  const [{ count: reportCount }, { count: aiCount }, { count: dupCount }] = await Promise.all([
    admin.from("reports").select("id", { count: "exact", head: true }),
    admin.from("ai_analyses").select("id", { count: "exact", head: true }),
    admin.from("report_duplicate_flags").select("id", { count: "exact", head: true }),
  ]);
  record(
    "Existing tables still readable with non-zero historical data",
    (reportCount ?? 0) > 0,
    `reports=${reportCount}, ai_analyses=${aiCount}, report_duplicate_flags=${dupCount}`
  );
}

{
  const { data: knownReport, error } = await admin
    .from("reports")
    .select("id, title, description, status")
    .ilike("title", "%deep pothole blocking the left lane%")
    .limit(1)
    .maybeSingle();
  if (error || !knownReport) {
    record("Known pre-Phase-6A report still exists", false, error?.message ?? "not found");
  } else {
    const { data: aiRow } = await admin
      .from("ai_analyses")
      .select("reasoning, severity, priority, extended")
      .eq("report_id", knownReport.id)
      .maybeSingle();
    record(
      "Known pre-Phase-6A report's ai_analyses row intact (old flat columns unchanged, extended still null)",
      !!aiRow && aiRow.reasoning?.includes("RTC bus stand") && aiRow.extended === null,
      `reasoning: ${aiRow?.reasoning?.slice(0, 60)}..., extended: ${JSON.stringify(aiRow?.extended)}`
    );
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed.`);
if (failed.length > 0) process.exit(1);
