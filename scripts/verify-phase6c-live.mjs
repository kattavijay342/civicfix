// Phase 6C post-migration live verification — schema/constraint/data-
// integrity checks (read-only + disposable self-cleaning fixtures) plus RLS
// authorization checks using real anon-key sessions for the seeded test
// accounts. Mirrors the style of verify-phase6a-live.mjs / verify-phase6b-
// live.mjs / verify-reminders-rls.mjs.
//
// Usage: node --env-file=.env.local scripts/verify-phase6c-live.mjs
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
  .select("id, full_name, role, gov_state, gov_district, gov_constituency, gov_area")
  .in("full_name", ["Test Citizen", "Test Government User", "Test Roads Incharge"]);
const citizen1 = profiles.find((p) => p.full_name === "Test Citizen");
const gov1 = profiles.find((p) => p.full_name === "Test Government User");
const incharge1 = profiles.find((p) => p.full_name === "Test Roads Incharge");

// =====================================================================
// 1. Schema — new columns exist.
// =====================================================================
{
  const { error } = await admin.from("notifications").select("priority, read_at, action_url, metadata, channel").limit(1);
  record("notifications: priority/read_at/action_url/metadata/channel all exist", !error, error?.message);
}
{
  const { error } = await admin.from("profiles").select("notification_preferences").limit(1);
  record("profiles.notification_preferences exists", !error, error?.message);
}

// =====================================================================
// 2. Existing rows preserved — defaults applied to pre-migration rows.
// =====================================================================
{
  const { data, error } = await admin.from("notifications").select("id, type, priority, channel").limit(200);
  const bad = (data ?? []).filter((n) => n.priority == null || n.channel == null);
  record(
    "Every existing notification row got the new NOT NULL defaults (priority/channel), none left null",
    !error && bad.length === 0,
    `checked ${data?.length ?? 0} rows, ${bad.length} missing defaults`
  );
}

// =====================================================================
// 3. Behavioral constraint proof — disposable, self-cleaning fixtures.
// =====================================================================
async function withDisposableNotification(fn) {
  const { data: row, error } = await admin
    .from("notifications")
    .insert({ recipient_id: citizen1.id, type: "report_created", title: "verify-phase6c fixture" })
    .select("id")
    .single();
  if (error) throw new Error(`fixture notification insert failed: ${error.message}`);
  try {
    return await fn(row.id);
  } finally {
    await admin.from("notifications").delete().eq("id", row.id);
  }
}

{
  const { error } = await admin
    .from("notifications")
    .insert({ recipient_id: citizen1.id, type: "not_a_real_type", title: "bad type" });
  record(
    "Invalid notification type is rejected by notifications_type_check",
    !!error && /notifications_type_check|check constraint/i.test(error.message ?? ""),
    error?.message
  );
}
{
  await withDisposableNotification(async (id) => {
    const { error } = await admin.from("notifications").update({ priority: "urgent" }).eq("id", id);
    record(
      "Invalid priority value is rejected by the priority CHECK constraint",
      !!error && /check constraint/i.test(error.message ?? ""),
      error?.message
    );
  });
}
{
  await withDisposableNotification(async (id) => {
    const { error } = await admin.from("notifications").update({ channel: "email" }).eq("id", id);
    record(
      "Invalid channel value ('email', not yet supported) is rejected by the channel CHECK constraint",
      !!error && /check constraint/i.test(error.message ?? ""),
      error?.message
    );
  });
}
{
  await withDisposableNotification(async (id) => {
    const { data, error } = await admin
      .from("notifications")
      .update({ priority: "high", channel: "in_app", action_url: "/reports/test", metadata: { foo: "bar" } })
      .eq("id", id)
      .select("priority, channel, action_url, metadata")
      .single();
    record(
      "Valid priority/channel/action_url/metadata values persist correctly",
      !error && data?.priority === "high" && data?.action_url === "/reports/test" && data?.metadata?.foo === "bar",
      JSON.stringify(data)
    );
  });
}

// =====================================================================
// 4. RLS — a citizen cannot read or modify another user's notifications.
// =====================================================================
{
  await withDisposableNotification(async (govNotifId) => {
    // Re-target this fixture at gov1 instead of citizen1 for this check.
    await admin.from("notifications").update({ recipient_id: gov1.id }).eq("id", govNotifId);

    const citizenSession = await asUser("citizen1@test.civicfix.local");
    const { data: readAttempt } = await citizenSession.client.from("notifications").select("id").eq("id", govNotifId);
    record("A citizen cannot read another user's notification (RLS select)", !readAttempt || readAttempt.length === 0);

    const { data: updateAttempt, error: updateError } = await citizenSession.client
      .from("notifications")
      .update({ is_read: true })
      .eq("id", govNotifId)
      .select();
    const { data: unchanged } = await admin.from("notifications").select("is_read").eq("id", govNotifId).single();
    record(
      "A citizen cannot modify another user's notification (RLS: no update policy at all for authenticated)",
      unchanged.is_read === false && (!updateAttempt || updateAttempt.length === 0),
      updateError ? `db error: ${updateError.message}` : `rows affected: ${updateAttempt?.length ?? 0}`
    );
  });
}
{
  // Sanity check: gov1 CAN read their own notification (RLS isn't blocking everything).
  await withDisposableNotification(async (notifId) => {
    await admin.from("notifications").update({ recipient_id: gov1.id }).eq("id", notifId);
    const govSession = await asUser("gov1@test.civicfix.local");
    const { data } = await govSession.client.from("notifications").select("id").eq("id", notifId);
    record("Sanity check: a user CAN read their own notification", (data?.length ?? 0) === 1);
  });
}

// =====================================================================
// 5. critical_issue jurisdiction targeting — mirrors src/lib/notifications/
//    targeting.ts's exact null-or-match predicate, evaluated here against
//    real live profile data (gov1's real configured jurisdiction).
// =====================================================================
function matchesJurisdiction(govUser, location) {
  const hasAnyScope = govUser.gov_state || govUser.gov_district || govUser.gov_constituency || govUser.gov_area;
  if (!hasAnyScope) return false;
  if (govUser.gov_state && govUser.gov_state !== location.state) return false;
  if (govUser.gov_district && govUser.gov_district !== location.district) return false;
  if (govUser.gov_constituency && govUser.gov_constituency !== location.constituency) return false;
  if (govUser.gov_area && govUser.gov_area !== location.area) return false;
  return true;
}
{
  const inJurisdiction = matchesJurisdiction(gov1, {
    state: "Andhra Pradesh",
    district: "Palnadu",
    constituency: "Narasaraopet",
    area: "Narasaraopet Municipality",
  });
  record("gov1 (real configured jurisdiction) matches a report in their own area", inJurisdiction, JSON.stringify(gov1));
}
{
  const outOfJurisdiction = matchesJurisdiction(gov1, {
    state: "Andhra Pradesh",
    district: "Guntur",
    constituency: "Tenali",
    area: "Tenali Municipality",
  });
  record("gov1 does NOT match a report outside their configured jurisdiction", !outOfJurisdiction);
}

// =====================================================================
// 6. Reminder scheduler — atomic claim + notification creation still work,
//    and a concurrent double-run of the scheduler never creates two
//    notifications for the same reminder (Phase 4/5 guarantee, unchanged).
// =====================================================================
const cronSecret = process.env.CRON_SECRET;
if (!cronSecret) {
  record("Reminder scheduler due-processing + duplicate-run safety", false, "skipped — CRON_SECRET not set");
} else {
  const { data: assignment } = await admin
    .from("report_assignments")
    .select("report_id, department_id, incharge_id")
    .eq("incharge_id", incharge1.id)
    .limit(1)
    .maybeSingle();

  if (!assignment) {
    record("Reminder scheduler due-processing + duplicate-run safety", false, "no existing report assigned to incharge1 to attach a reminder to");
  } else {
    const { data: reminder } = await admin
      .from("reminders")
      .insert({
        report_id: assignment.report_id,
        created_by: gov1.id,
        department_id: assignment.department_id,
        recipient_id: assignment.incharge_id,
        title: "Phase 6C verification reminder",
        message: "Disposable fixture — safe to ignore/delete.",
        scheduled_at: new Date(Date.now() - 60 * 1000).toISOString(),
      })
      .select("*")
      .single();

    async function callCron() {
      const res = await fetch("http://localhost:3000/api/cron/reminders", {
        method: "POST",
        headers: { Authorization: `Bearer ${cronSecret}` },
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }

    try {
      const [r1, r2] = await Promise.all([callCron(), callCron()]);
      record(
        "Reminder scheduler endpoint reachable and processes the due reminder",
        r1.status === 200 && r2.status === 200,
        JSON.stringify({ r1: r1.body, r2: r2.body })
      );

      const { data: finalRow } = await admin.from("reminders").select("status, notification_id").eq("id", reminder.id).single();
      const { data: notifs } = await admin
        .from("notifications")
        .select("id, type, priority")
        .eq("related_report_id", assignment.report_id)
        .eq("type", "reminder_due")
        .eq("title", "Phase 6C verification reminder");
      record(
        "Concurrent duplicate scheduler runs still create exactly one notification (atomic claim preserved)",
        finalRow.status === "sent" && !!finalRow.notification_id && (notifs ?? []).length === 1,
        `status=${finalRow.status}, notifications found=${(notifs ?? []).length}`
      );
      if (notifs?.[0]) {
        record("reminder_due notification has priority 'high' as designed", notifs[0].priority === "high", notifs[0].priority);
      }
    } catch (err) {
      record("Reminder scheduler due-processing + duplicate-run safety", false, `request failed: ${err.message} — is 'npm run dev' running on :3000?`);
    } finally {
      await admin.from("reminders").delete().eq("id", reminder.id);
      // Clean up the notification(s) this fixture created.
      await admin
        .from("notifications")
        .delete()
        .eq("related_report_id", assignment.report_id)
        .eq("type", "reminder_due")
        .eq("title", "Phase 6C verification reminder");
    }
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed.`);
if (failed.length > 0) process.exit(1);
