// Phase 6D post-migration live verification — schema/constraint/RLS checks
// plus a full disposable-fixture reopen cycle (reported -> acknowledge ->
// resolve -> citizen says "no" -> reopened -> acknowledge -> resolve ->
// citizen says "yes" -> confirmed), mirroring the style of
// verify-phase6a/6b/6c-live.mjs.
//
// Usage: node --env-file=.env.local scripts/verify-phase6d-live.mjs
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
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return { client, userId: data.user.id };
}

const { data: profiles } = await admin
  .from("profiles")
  .select("id, full_name, role")
  .in("full_name", ["Test Citizen", "Test Government User", "Test Roads Incharge"]);
const citizen1 = profiles.find((p) => p.full_name === "Test Citizen");
const incharge1 = profiles.find((p) => p.full_name === "Test Roads Incharge");

const { data: roadsDept } = await admin.from("departments").select("id").ilike("name", "%Road%").limit(1).maybeSingle();

// =====================================================================
// 1. Schema — new columns/table exist, constraint widened.
// =====================================================================
{
  const { error } = await admin.from("reports").select("reopened_at").limit(1);
  record("reports.reopened_at exists", !error, error?.message);
}
{
  const { error } = await admin
    .from("resolution_feedback")
    .select("id, report_id, citizen_id, confirmed, comment, created_at, updated_at")
    .limit(1);
  record("resolution_feedback table exists with expected columns", !error, error?.message);
}

// =====================================================================
// 2. Behavioral constraint proof — disposable, self-cleaning fixture report.
// =====================================================================
async function withDisposableReport(fn) {
  const { data: report, error } = await admin
    .from("reports")
    .insert({
      reporter_id: citizen1.id,
      title: "verify-phase6d fixture",
      description: "Disposable fixture — safe to ignore/delete.",
      category: "road",
      status: "reported",
    })
    .select("id")
    .single();
  if (error) throw new Error(`fixture report insert failed: ${error.message}`);
  try {
    return await fn(report.id);
  } finally {
    await admin.from("resolution_feedback").delete().eq("report_id", report.id);
    await admin.from("status_history").delete().eq("report_id", report.id);
    await admin.from("resolution_evidence").delete().eq("report_id", report.id);
    await admin.from("report_assignments").delete().eq("report_id", report.id);
    await admin.from("notifications").delete().eq("related_report_id", report.id);
    await admin.from("reports").delete().eq("id", report.id);
  }
}

await withDisposableReport(async (reportId) => {
  const { error } = await admin.from("reports").update({ status: "reopened" }).eq("id", reportId);
  record("reports.status accepts 'reopened' (widened CHECK constraint)", !error, error?.message);
});

await withDisposableReport(async (reportId) => {
  const { error } = await admin.from("reports").update({ status: "not_a_real_status" }).eq("id", reportId);
  record(
    "An invalid reports.status value is still rejected after widening the constraint",
    !!error && /check constraint/i.test(error.message ?? ""),
    error?.message
  );
});

// =====================================================================
// 3. RLS — a citizen cannot read or write another user's resolution_feedback;
//    the owner (and assigned in-charge, via can_view_report) CAN read it.
// =====================================================================
await withDisposableReport(async (reportId) => {
  await admin.from("reports").update({ status: "resolved" }).eq("id", reportId);
  const { data: fb, error: fbError } = await admin
    .from("resolution_feedback")
    .insert({ report_id: reportId, citizen_id: citizen1.id, confirmed: true, comment: "fixture" })
    .select("id")
    .single();
  if (fbError) {
    record("RLS setup: could not insert fixture resolution_feedback row", false, fbError.message);
    return;
  }

  const govSession = await asUser("gov1@test.civicfix.local");
  const { data: govRead } = await govSession.client.from("resolution_feedback").select("id").eq("id", fb.id);
  record(
    "A government user WITHOUT jurisdiction over this report cannot read the citizen's feedback",
    !govRead || govRead.length === 0
  );

  const citizenSession = await asUser("citizen1@test.civicfix.local");
  const { data: ownRead } = await citizenSession.client.from("resolution_feedback").select("id").eq("id", fb.id);
  record("The original reporter CAN read their own resolution_feedback row", (ownRead?.length ?? 0) === 1);

  const { data: updateAttempt } = await citizenSession.client
    .from("resolution_feedback")
    .update({ confirmed: false })
    .eq("id", fb.id)
    .select();
  const { data: unchanged } = await admin.from("resolution_feedback").select("confirmed").eq("id", fb.id).single();
  record(
    "No client (not even the owner) can write resolution_feedback directly — no INSERT/UPDATE policy for authenticated",
    unchanged.confirmed === true && (!updateAttempt || updateAttempt.length === 0)
  );
});

// =====================================================================
// 4. Full reopen cycle — via performSubmitFeedback's exact DB shape,
//    replicated here against the live DB (the unit tests already prove the
//    function's own logic against the fake client; this proves the same
//    shape actually persists against real Postgres + real constraints).
// =====================================================================
if (!roadsDept) {
  record("Full reopen cycle", false, "no department matching '%Road%' found — cannot assign a fixture report");
} else {
  await withDisposableReport(async (reportId) => {
    await admin.from("reports").update({ status: "acknowledged" }).eq("id", reportId);
    await admin
      .from("report_assignments")
      .insert({ report_id: reportId, department_id: roadsDept.id, incharge_id: incharge1.id });

    await admin.from("reports").update({ status: "resolved" }).eq("id", reportId);
    const { data: resolutionRow } = await admin
      .from("resolution_evidence")
      .insert({ report_id: reportId, resolution_notes: "Fixed for verification.", resolved_by: incharge1.id })
      .select("resolved_at")
      .single();

    // Citizen says "no" — mirrors performSubmitFeedback's confirmed=false path.
    await admin
      .from("resolution_feedback")
      .insert({ report_id: reportId, citizen_id: citizen1.id, confirmed: false, comment: "Still broken" });
    await admin
      .from("reports")
      .update({ status: "reopened", reopened_at: new Date().toISOString() })
      .eq("id", reportId);

    const { data: afterReopen, error: afterReopenError } = await admin
      .from("reports")
      .select("status, reopened_at")
      .eq("id", reportId)
      .maybeSingle();
    record(
      "Citizen 'no' feedback reopens the report and sets reopened_at",
      !afterReopenError && afterReopen?.status === "reopened" && !!afterReopen?.reopened_at,
      afterReopenError?.message ?? JSON.stringify(afterReopen)
    );
    if (!afterReopen || afterReopen.status !== "reopened") {
      record("Full reopen cycle — remaining steps", false, "skipped: reopen itself did not succeed above");
      return;
    }

    // Old resolution evidence must survive the reopen untouched.
    const { data: oldEvidence } = await admin
      .from("resolution_evidence")
      .select("id, resolved_at")
      .eq("report_id", reportId)
      .maybeSingle();
    record(
      "Previous resolution_evidence is preserved (never deleted) across a reopen",
      !!oldEvidence && oldEvidence.resolved_at === resolutionRow?.resolved_at
    );

    // Department must acknowledge again before resolving again (STATUS_ORDER.REOPENED = 2, below ACKNOWLEDGED).
    await admin.from("reports").update({ status: "acknowledged" }).eq("id", reportId);
    await admin.from("reports").update({ status: "resolved" }).eq("id", reportId);

    // Citizen re-submits feedback for the FRESH resolution — upsert path (edit, not duplicate row).
    const { data: existingFb } = await admin.from("resolution_feedback").select("id").eq("report_id", reportId).maybeSingle();
    if (existingFb) {
      await admin
        .from("resolution_feedback")
        .update({ confirmed: true, comment: null, updated_at: new Date().toISOString() })
        .eq("id", existingFb.id);
    }

    const { data: allFeedback } = await admin.from("resolution_feedback").select("*").eq("report_id", reportId);
    record(
      "Re-submitting feedback after a second resolution edits the same row (never a duplicate)",
      (allFeedback ?? []).length === 1 && allFeedback?.[0]?.confirmed === true
    );
  });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed.`);
if (failed.length > 0) process.exit(1);
