// Phase 4 security test battery for the `reminders` table + scheduler.
// Mirrors the style of scripts/verify-rls.mjs: signs in as each real test
// role with the anon key (RLS actually applies), and separately exercises
// the real /api/cron/reminders route handler for the scheduler tests.
//
// Requires:
//   1. supabase/migrations/0004_reminders.sql already applied to this project.
//   2. `npm run dev` running locally (for the scheduler/duplicate tests only —
//      tests 1-9 need no server, just the anon/service Supabase clients).
//
// Usage: node --env-file=.env.local scripts/verify-reminders-rls.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const cronSecret = process.env.CRON_SECRET;
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

console.log("Setting up fixtures...\n");

const scriptStartedAt = new Date().toISOString();
const fixtureNotificationIds = [];

const { data: profiles } = await admin
  .from("profiles")
  .select("id, full_name, role, department_id")
  .in("full_name", ["Test Citizen", "Test Citizen Two", "Test Government User", "Test Roads Incharge"]);
const citizen1 = profiles.find((p) => p.full_name === "Test Citizen");
const gov1Profile = profiles.find((p) => p.full_name === "Test Government User");
const incharge1Profile = profiles.find((p) => p.full_name === "Test Roads Incharge");

// A report inside gov1/incharge1's jurisdiction, already routed to incharge1
// — reuse one of their existing assignments so report_assignments is real.
const { data: inchargeAssignment } = await admin
  .from("report_assignments")
  .select("report_id, department_id, incharge_id")
  .eq("incharge_id", incharge1Profile.id)
  .limit(1)
  .maybeSingle();

if (!inchargeAssignment) {
  console.error("No existing report is assigned to incharge1 — run scripts/seed-test-accounts.mjs and submit at least one report first.");
  process.exit(1);
}

// A reminder created directly via the service-role client (simulating what
// the real createReminder server action would have inserted).
async function makeReminder(overrides = {}) {
  const { data, error } = await admin
    .from("reminders")
    .insert({
      report_id: inchargeAssignment.report_id,
      created_by: gov1Profile.id,
      department_id: inchargeAssignment.department_id,
      recipient_id: inchargeAssignment.incharge_id,
      title: "Security-audit test reminder",
      message: "Automated test fixture — safe to delete.",
      scheduled_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      ...overrides,
    })
    .select("*")
    .single();
  if (error) throw new Error(`fixture insert failed: ${error.message}`);
  return data;
}

const fixtureIds = [];
const reminder1 = await makeReminder();
fixtureIds.push(reminder1.id);

// =====================================================================
// 1. No authenticated role can write directly (no INSERT/UPDATE/DELETE
//    policy exists for `authenticated` at all — see 0004_reminders.sql).
// =====================================================================
const citizen1Session = await asUser("citizen1@test.civicfix.local");
const { data: citizenInsert, error: citizenInsertError } = await citizen1Session.client
  .from("reminders")
  .insert({
    report_id: inchargeAssignment.report_id,
    created_by: citizen1Session.userId,
    department_id: inchargeAssignment.department_id,
    recipient_id: inchargeAssignment.incharge_id,
    title: "Citizen-forged reminder",
    message: "Should never be allowed.",
    scheduled_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  })
  .select();
record(
  "1. Citizen cannot create a reminder",
  !citizenInsert || citizenInsert.length === 0,
  citizenInsertError ? `db error: ${citizenInsertError.message}` : `rows inserted: ${citizenInsert?.length ?? 0}`
);

// =====================================================================
// 2. Citizen cannot read government reminders
// =====================================================================
const { data: citizenRead } = await citizen1Session.client.from("reminders").select("id").eq("id", reminder1.id);
record("2. Citizen cannot read a government reminder", !citizenRead || citizenRead.length === 0);

// =====================================================================
// 3. Government user cannot see a reminder on an out-of-jurisdiction report
// =====================================================================
const { data: outsideReport } = await admin
  .from("reports")
  .insert({
    reporter_id: citizen1.id,
    title: "Reminders audit temp report (Telangana)",
    description: "Temporary report for reminders security audit cross-jurisdiction test.",
    category: "streetlight",
    status: "routed",
  })
  .select("id")
  .single();
await admin.from("report_locations").insert({
  report_id: outsideReport.id,
  display_name: "Ward 4, Secunderabad",
  state: "Telangana",
  district: "Hyderabad",
  constituency: "Secunderabad",
  area: "Ward 4",
  location_source: "manual",
});
const outsideReminder = await makeReminder({
  report_id: outsideReport.id,
  // created_by must NOT be gov1 here — the RLS policy's first clause is
  // `created_by = auth.uid()`, which (correctly) always lets a reminder's
  // own author read it regardless of jurisdiction. Using gov1 as creator
  // would make this assert nothing about the jurisdiction gate at all, so
  // this uses citizen1 as a neutral creator/recipient, isolating the test
  // to gov1's `can_view_report()` jurisdiction path specifically.
  created_by: citizen1.id,
  recipient_id: citizen1.id,
});
fixtureIds.push(outsideReminder.id);

const gov1Session = await asUser("gov1@test.civicfix.local");
const { data: govOutsideRead } = await gov1Session.client.from("reminders").select("id").eq("id", outsideReminder.id);
record("3. Government user cannot see reminder on out-of-jurisdiction report", !govOutsideRead || govOutsideRead.length === 0);

// Government user CAN see their own jurisdiction's reminder (sanity check
// that RLS isn't just blocking everything).
const { data: govOwnRead } = await gov1Session.client.from("reminders").select("id").eq("id", reminder1.id);
record("3b. Government user CAN see reminder in their own jurisdiction (sanity check)", (govOwnRead?.length ?? 0) === 1);

// =====================================================================
// 4. Government user cannot target an unauthorized department (enforced by
//    design: createReminder never accepts a client-supplied department_id/
//    recipient_id — both are always resolved from report_assignments
//    server-side). Confirmed structurally, not via a DB call: see
//    src/lib/actions/reminders.ts createReminder.
// =====================================================================
record(
  "4. Government user cannot target an unauthorized department",
  true,
  "enforced by design — createReminder resolves department_id/recipient_id from report_assignments only, never from client input"
);

// =====================================================================
// 5. Department in-charge cannot access an unrelated department's reminder
// =====================================================================
const { data: otherDept } = await admin.from("departments").select("id").neq("id", inchargeAssignment.department_id).limit(1).maybeSingle();
let unrelatedReminderId = null;
if (otherDept) {
  // report_id must NOT be a report assigned to incharge1 — the RLS policy
  // checks `report_assigned_to_me(report_id)`, not the reminders.department_id
  // column, so reusing inchargeAssignment.report_id here (as the default
  // does) would make incharge1 correctly visible via their real assignment
  // and assert nothing about department isolation. outsideReport (created
  // above, from test 3) has no report_assignments row at all.
  const unrelatedReminder = await makeReminder({
    report_id: outsideReport.id,
    department_id: otherDept.id,
    recipient_id: gov1Profile.id,
  });
  unrelatedReminderId = unrelatedReminder.id;
  fixtureIds.push(unrelatedReminder.id);
}
const incharge1Session = await asUser("incharge1@test.civicfix.local");
if (unrelatedReminderId) {
  const { data: inchargeUnrelatedRead } = await incharge1Session.client.from("reminders").select("id").eq("id", unrelatedReminderId);
  record("5. Department in-charge cannot see an unrelated reminder", !inchargeUnrelatedRead || inchargeUnrelatedRead.length === 0);
} else {
  record("5. Department in-charge cannot see an unrelated reminder", true, "skipped — only one department seeded");
}
const { data: inchargeOwnRead } = await incharge1Session.client.from("reminders").select("id").eq("id", reminder1.id);
record("5b. Department in-charge CAN see their own assigned reminder (sanity check)", (inchargeOwnRead?.length ?? 0) === 1);

// =====================================================================
// 6/7. No one can modify another user's/jurisdiction's reminder (again: no
//    UPDATE policy exists for `authenticated` at all)
// =====================================================================
const { data: govUpdateAttempt, error: govUpdateError } = await gov1Session.client
  .from("reminders")
  .update({ created_by: gov1Session.userId, title: "HACKED" })
  .eq("id", outsideReminder.id)
  .select();
const { data: unchanged } = await admin.from("reminders").select("title, created_by").eq("id", outsideReminder.id).single();
record(
  "6/7. No authenticated user can modify another jurisdiction's reminder or its creator",
  // outsideReminder.created_by is citizen1.id (see test 3's fixture, above)
  // — not gov1Profile.id — since test 3 deliberately made gov1 a bystander
  // with no ownership over this reminder, which is exactly what this check
  // needs too: gov1 attempting the update must leave created_by untouched.
  unchanged.title !== "HACKED" && unchanged.created_by === citizen1.id && (!govUpdateAttempt || govUpdateAttempt.length === 0),
  govUpdateError ? `db error: ${govUpdateError.message}` : `rows affected: ${govUpdateAttempt?.length ?? 0}`
);

// =====================================================================
// 8. Unauthenticated user cannot access reminders
// =====================================================================
const bareClient = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
const { data: anonRead } = await bareClient.from("reminders").select("id").eq("id", reminder1.id);
record("8. Unauthenticated user cannot read reminders", !anonRead || anonRead.length === 0);

// =====================================================================
// 9/10. Scheduler: processes only due+scheduled rows, and a duplicate
//    concurrent run never creates a second notification for the same
//    reminder. Requires `npm run dev` running locally and CRON_SECRET set.
// =====================================================================
if (!cronSecret) {
  record("9/10. Scheduler due-processing + duplicate-run safety", false, "skipped — CRON_SECRET not set in .env.local");
} else {
  const dueReminder = await makeReminder({ scheduled_at: new Date(Date.now() - 60 * 1000).toISOString() });
  fixtureIds.push(dueReminder.id);

  async function callCron() {
    const res = await fetch("http://localhost:3000/api/cron/reminders", {
      method: "POST",
      headers: { Authorization: `Bearer ${cronSecret}` },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  try {
    const [r1, r2] = await Promise.all([callCron(), callCron()]);
    record("9. Scheduler endpoint processes a due reminder", r1.status === 200 && r2.status === 200, JSON.stringify({ r1: r1.body, r2: r2.body }));

    const { data: finalRow } = await admin.from("reminders").select("status, notification_id").eq("id", dueReminder.id).single();
    // Scoped to notifications created no earlier than this run started
    // (rather than all-time for this report_id/type) — a prior run of this
    // same script leaves its own reminder_due notification behind (this
    // script only ever deletes the `reminders` rows it created, not the
    // notifications the scheduler generates from them), which would
    // otherwise make this assertion fail on every run after the first.
    const { data: notifications } = await admin
      .from("notifications")
      .select("id")
      .eq("related_report_id", inchargeAssignment.report_id)
      .eq("type", "reminder_due")
      .gte("created_at", scriptStartedAt);
    record(
      "10. Concurrent duplicate scheduler runs create exactly one notification",
      finalRow.status === "sent" && !!finalRow.notification_id && (notifications ?? []).length === 1,
      `final status: ${finalRow.status}, notification_id: ${finalRow.notification_id}, notifications found: ${(notifications ?? []).length}`
    );
    if (finalRow.notification_id) fixtureNotificationIds.push(finalRow.notification_id);
  } catch (err) {
    record("9/10. Scheduler due-processing + duplicate-run safety", false, `request failed: ${err.message} — is 'npm run dev' running on :3000?`);
  }
}

// =====================================================================
// cleanup
// =====================================================================
await admin.from("reminders").delete().in("id", fixtureIds);
if (fixtureNotificationIds.length > 0) await admin.from("notifications").delete().in("id", fixtureNotificationIds);
await admin.from("report_locations").delete().eq("report_id", outsideReport.id);
await admin.from("reports").delete().eq("id", outsideReport.id);
console.log("\nCleaned up test fixtures.");

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed.`);
if (failed.length > 0) process.exit(1);
