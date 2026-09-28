// G7 Resolution -> Citizen Verification — live database/RLS/Storage checks
// against the real Supabase project. Every principal reads/writes through
// the anon key + its own signed-in session, so Postgres RLS decides each
// outcome.
//
// The server actions (submitResolution, submitResolutionFeedback), their
// authorization (effective in-charge / admin override; reporting citizen
// only), decision rules and notification recipients are unit-tested
// (src/lib/actions/department.test.ts, resolution-feedback.test.ts,
// src/lib/resolution-verification.test.ts) and the real UI flow by
// e2e/g7-resolution-verification.spec.ts. This script proves the database
// boundary they rely on:
//   - resolution evidence, the after-photo media row, status history and
//     the citizen's decision are readable by the reporting citizen, the
//     jurisdiction government user and the EFFECTIVE in-charge only —
//     never by an unrelated citizen, another department / jurisdiction,
//     a stale (deactivated / moved / re-scoped / replaced) in-charge, or a
//     signed-out caller; no cross-report leakage by predictable ids,
//   - nobody (not even the owner, government or the in-charge) can write a
//     decision, reopen/verify a report, forge history/evidence or forge a
//     notification directly — only the server actions (service role) can,
//   - the private report-media bucket is unreachable directly and a signed
//     URL is bound to its one object,
//   - decision notifications are readable only by their recipient,
//   - the Postgres behaviors the atomic guard in
//     src/lib/actions/resolution-feedback.ts depends on: the unique
//     report_id lets exactly one concurrent insert win; the conditional
//     update on (updated_at = read value AND updated_at < resolved_at)
//     matches for exactly one of several concurrent claims (set_updated_at
//     trigger); the resolved -> reopened compare-and-set wins once.
//
// Fixtures: seeded gov1/incharge1 plus throwaway @test.civicfix.local users
// and "G7 Test:" reports + storage objects, all deleted at the end;
// baseline counts compared before/after. Sends NO email. No Gemini calls.
// Usage: node --env-file=.env.local scripts/verify-g7-resolution-live.mjs
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const noPersist = { auth: { autoRefreshToken: false, persistSession: false } };
const admin = createClient(url, serviceKey, noPersist);
const PASSWORD = "CivicFixTest2026!";
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const BUCKET = "report-media";

const NARASARAOPET = { state: "Andhra Pradesh", district: "Palnadu", constituency: "Narasaraopet", area: "Narasaraopet Municipality" };
const TENALI = { state: "Andhra Pradesh", district: "Guntur", constituency: "Tenali", area: "Tenali Municipality" };
const scope = (j) => ({ gov_state: j.state, gov_district: j.district, gov_constituency: j.constituency, gov_area: j.area });
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
  "base64"
);

const results = [];
function record(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} - ${name}${detail ? ` (${detail})` : ""}`);
}

const cleanupUsers = [];
const cleanupReports = [];
const cleanupObjects = [];

async function counts() {
  const c = async (t) => (await admin.from(t).select("*", { count: "exact", head: true })).count;
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const { data: resolutionDirs } = await admin.storage.from(BUCKET).list("resolution", { limit: 1000 });
  return {
    reports: await c("reports"),
    profiles: await c("profiles"),
    auth_users: users.users.length,
    department_incharges: await c("department_incharges"),
    report_assignments: await c("report_assignments"),
    report_media: await c("report_media"),
    resolution_evidence: await c("resolution_evidence"),
    resolution_feedback: await c("resolution_feedback"),
    status_history: await c("status_history"),
    notifications: await c("notifications"),
    reminders: await c("reminders"),
    storage_resolution_dirs: (resolutionDirs ?? []).length,
  };
}

async function throwawayUser(tag) {
  const email = `g7-${tag}-${RUN}@test.civicfix.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: `G7 ${tag}` } });
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

/** A resolved report exactly as submitResolution leaves it: status
 * resolved, an "after" photo in Storage + report_media, a resolution_evidence
 * row (resolved_at stamped by the app clock) and the history entry. */
async function resolvedReport({ reporterId, tag, jurisdiction, departmentId, inchargeId }) {
  const title = `G7 Test: ${tag} ${RUN}`;
  const { data: report, error } = await admin
    .from("reports")
    .insert({ reporter_id: reporterId, title, description: `${title} — disposable, deleted by this script.`, category: "road", status: "resolved", priority: "high", severity: "high" })
    .select("id")
    .single();
  if (error) throw new Error(`report insert failed: ${error.message}`);
  cleanupReports.push(report.id);
  await admin.from("report_locations").insert({ report_id: report.id, display_name: `G7 fixture location ${RUN}`, ...jurisdiction, location_source: "manual" });
  await admin.from("report_assignments").insert({ report_id: report.id, department_id: departmentId, incharge_id: inchargeId, assignment_method: "auto" });

  const path = `resolution/${report.id}/${randomUUID()}.jpg`;
  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, TINY_JPEG, { contentType: "image/jpeg" });
  if (upErr) throw new Error(`upload failed: ${upErr.message}`);
  cleanupObjects.push(path);
  const { data: media } = await admin
    .from("report_media")
    .insert({ report_id: report.id, uploaded_by: inchargeId, kind: "after", file_path: path, file_type: "image", mime_type: "image/jpeg" })
    .select("id")
    .single();
  const resolvedAt = new Date().toISOString();
  const { data: evidence } = await admin
    .from("resolution_evidence")
    .insert({ report_id: report.id, after_media_id: media.id, resolution_notes: "G7 fixture: filled and compacted.", resolved_by: inchargeId, resolved_at: resolvedAt })
    .select("id, resolved_at")
    .single();
  await admin.from("status_history").insert({ report_id: report.id, old_status: "in_progress", new_status: "resolved", changed_by: inchargeId, notes: "G7 fixture resolution" });
  return { id: report.id, path, mediaId: media.id, evidenceId: evidence.id, resolvedAt: evidence.resolved_at };
}

const rows = async (c, table, column, value) => (await c.from(table).select("id").eq(column, value)).data ?? [];

/** Everything a viewer of this report's resolution reads. */
async function readsResolution(c, r) {
  const [rep, ev, media, hist, fb] = await Promise.all([
    rows(c, "reports", "id", r.id),
    rows(c, "resolution_evidence", "report_id", r.id),
    rows(c, "report_media", "id", r.mediaId),
    rows(c, "status_history", "report_id", r.id),
    rows(c, "resolution_feedback", "report_id", r.id),
  ]);
  return { report: rep.length === 1, evidence: ev.length === 1, media: media.length === 1, history: hist.length > 0, feedback: fb.length === 1 };
}
const all = (o) => Object.values(o).every(Boolean);
const none = (o) => Object.values(o).every((v) => !v);

let baseline;
try {
  baseline = await counts();
  console.log("Baseline:", JSON.stringify(baseline));

  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const byEmail = (e) => users.users.find((u) => u.email === e);
  const [gov1Auth, incharge1Auth] = ["gov1", "incharge1"].map((n) => byEmail(`${n}@test.civicfix.local`));
  if (!gov1Auth || !incharge1Auth) throw new Error("Seeded accounts missing — run scripts/seed-test-accounts.mjs first.");

  const { data: departments } = await admin.from("departments").select("id, name");
  const roads = departments.find((d) => d.name === "Roads & Infrastructure");
  const other = departments.find((d) => d.id !== roads.id);

  // Principals.
  const owner = await throwawayUser("owner");
  const otherCitizen = await throwawayUser("other-citizen");
  const govTenali = await throwawayUser("gov-tenali");
  await admin.from("profiles").update({ role: "government", ...scope(TENALI) }).eq("id", govTenali.id);
  const otherDept = await throwawayUser("other-dept");
  await admin.from("profiles").update({ role: "department_incharge", department_id: other.id }).eq("id", otherDept.id);
  await admin.from("department_incharges").insert({ department_id: other.id, profile_id: otherDept.id, ...scope(NARASARAOPET), is_active: true });
  const tenaliRoads = await throwawayUser("tenali-roads");
  await admin.from("profiles").update({ role: "department_incharge", department_id: roads.id }).eq("id", tenaliRoads.id);
  await admin.from("department_incharges").insert({ department_id: roads.id, profile_id: tenaliRoads.id, ...scope(TENALI), is_active: true });
  const stale = {};
  for (const tag of ["deactivated", "moved", "rescoped", "replaced"]) {
    stale[tag] = await throwawayUser(tag);
    await admin.from("profiles").update({ role: "department_incharge", department_id: roads.id }).eq("id", stale[tag].id);
    await admin.from("department_incharges").insert({ department_id: roads.id, profile_id: stale[tag].id, ...scope(NARASARAOPET), is_active: true });
  }

  const gov1 = await asUser(gov1Auth.email);
  const incharge1 = await asUser(incharge1Auth.email);
  const ownerC = await asUser(owner.email);
  const otherCitizenC = await asUser(otherCitizen.email);
  const tenaliC = await asUser(govTenali.email);
  const otherDeptC = await asUser(otherDept.email);
  const tenaliRoadsC = await asUser(tenaliRoads.email);
  const staleC = {};
  for (const tag of Object.keys(stale)) staleC[tag] = await asUser(stale[tag].email);
  const anon = createClient(url, anonKey, noPersist);

  const main = await resolvedReport({ reporterId: owner.id, tag: "main", jurisdiction: NARASARAOPET, departmentId: roads.id, inchargeId: incharge1.userId });
  const foreign = await resolvedReport({ reporterId: otherCitizen.id, tag: "other-citizen", jurisdiction: NARASARAOPET, departmentId: roads.id, inchargeId: incharge1.userId });
  const staleReports = {};
  for (const tag of Object.keys(stale)) {
    staleReports[tag] = await resolvedReport({ reporterId: owner.id, tag: `stale-${tag}`, jurisdiction: NARASARAOPET, departmentId: roads.id, inchargeId: stale[tag].id });
  }
  // The citizen's decision, exactly as performSubmitFeedback stores it.
  const now = new Date().toISOString();
  await admin.from("resolution_feedback").insert({ report_id: main.id, citizen_id: owner.id, confirmed: true, comment: null, created_at: now, updated_at: now });
  await admin.from("resolution_feedback").insert({ report_id: foreign.id, citizen_id: otherCitizen.id, confirmed: true, comment: null, created_at: now, updated_at: now });

  // ---- ALLOW -------------------------------------------------------------
  let r = await readsResolution(ownerC.client, main);
  record("TEST 1 - ALLOW: the reporting citizen reads their resolution, after photo, history and decision", all(r), JSON.stringify(r));
  r = await readsResolution(gov1.client, main);
  record("TEST 2 - ALLOW: the jurisdiction government user reads the resolution", all(r), JSON.stringify(r));
  r = await readsResolution(incharge1.client, main);
  record("TEST 3 - ALLOW: the current effective in-charge reads the resolution", all(r), JSON.stringify(r));

  // ---- DENY (read) -------------------------------------------------------
  const denyRead = [
    ["TEST 4 - DENY: an unrelated citizen", otherCitizenC.client],
    ["TEST 5 - DENY: another department's in-charge (same jurisdiction)", otherDeptC.client],
    ["TEST 6 - DENY: same department, another jurisdiction's in-charge", tenaliRoadsC.client],
    ["TEST 7 - DENY: another jurisdiction's government user", tenaliC.client],
    ["TEST 8 - DENY: a signed-out caller", anon],
  ];
  for (const [name, c] of denyRead) {
    r = await readsResolution(c, main);
    record(`${name} cannot read the resolution, evidence, history or decision`, none(r), JSON.stringify(r));
  }

  // Stale in-charges: effective first (sanity), then made stale.
  const before = {};
  for (const tag of Object.keys(stale)) before[tag] = (await readsResolution(staleC[tag].client, staleReports[tag])).evidence;
  record("TEST 9a - sanity: each soon-to-be-stale in-charge can read their resolution while effective", Object.values(before).every(Boolean), JSON.stringify(before));
  await admin.from("department_incharges").update({ is_active: false }).eq("profile_id", stale.deactivated.id);
  await admin.from("profiles").update({ department_id: other.id }).eq("id", stale.moved.id);
  await admin.from("department_incharges").update(scope(TENALI)).eq("profile_id", stale.rescoped.id);
  await admin.from("report_assignments").update({ incharge_id: incharge1.userId }).eq("report_id", staleReports.replaced.id);
  const leaks = [];
  for (const tag of Object.keys(stale)) {
    const s = await readsResolution(staleC[tag].client, staleReports[tag]);
    if (!none(s)) leaks.push(`${tag}:${JSON.stringify(s)}`);
  }
  record("TEST 9b - DENY: deactivated / moved / re-scoped / replaced in-charges lose the resolution and evidence", leaks.length === 0, leaks.join("; "));

  // ---- Cross-report leakage by predictable ids ----------------------------
  const cross = await readsResolution(ownerC.client, foreign);
  const crossObj = await ownerC.client.storage.from(BUCKET).download(foreign.path);
  record("TEST 10 - DENY: the owner of one report cannot read another citizen's resolution/evidence/decision by id", none(cross) && !crossObj.data, JSON.stringify(cross));

  // ---- DENY (mutation) — every principal, including the owner -------------
  const { data: fbRow } = await admin.from("resolution_feedback").select("id, confirmed, updated_at").eq("report_id", main.id).single();
  const mutationPrincipals = [
    ["owner citizen", ownerC],
    ["government", gov1],
    ["effective in-charge", incharge1],
    ["unrelated citizen", otherCitizenC],
    ["signed-out", { client: anon, userId: null }],
  ];
  const mutationLeaks = [];
  for (const [name, p] of mutationPrincipals) {
    const c = p.client;
    const actor = p.userId ?? owner.id;
    await c.from("resolution_feedback").insert({ report_id: foreign.id, citizen_id: actor, confirmed: false, comment: "forged decision" });
    await c.from("resolution_feedback").update({ confirmed: false, comment: "forged" }).eq("report_id", main.id);
    await c.from("reports").update({ status: "reopened", reopened_at: new Date().toISOString() }).eq("id", main.id);
    await c.from("status_history").insert({ report_id: main.id, old_status: "resolved", new_status: "reopened", changed_by: actor, notes: "forged" });
    await c.from("resolution_evidence").update({ resolution_notes: "forged" }).eq("report_id", main.id);
    await c.from("notifications").insert({ recipient_id: incharge1.userId, type: "issue_reopened", title: "forged", related_report_id: main.id });
    const [{ data: rep }, { data: fb }, { count: forgedHist }, { data: ev }, { count: forgedNotif }, { count: forgedFb }] = await Promise.all([
      admin.from("reports").select("status, reopened_at").eq("id", main.id).single(),
      admin.from("resolution_feedback").select("confirmed, comment, updated_at").eq("id", fbRow.id).single(),
      admin.from("status_history").select("*", { count: "exact", head: true }).eq("report_id", main.id).eq("notes", "forged"),
      admin.from("resolution_evidence").select("resolution_notes").eq("id", main.evidenceId).single(),
      admin.from("notifications").select("*", { count: "exact", head: true }).eq("related_report_id", main.id).eq("title", "forged"),
      admin.from("resolution_feedback").select("*", { count: "exact", head: true }).eq("report_id", foreign.id).eq("comment", "forged decision"),
    ]);
    const intact =
      rep.status === "resolved" && !rep.reopened_at && fb.confirmed === true && fb.comment === null && fb.updated_at === fbRow.updated_at &&
      forgedHist === 0 && ev.resolution_notes === "G7 fixture: filled and compacted." && forgedNotif === 0 && forgedFb === 0;
    if (!intact) mutationLeaks.push(name);
  }
  record(
    "TEST 11 - DENY: no principal (owner, government, in-charge, unrelated, signed-out) can write a decision, reopen, forge history/evidence or a notification directly",
    mutationLeaks.length === 0,
    mutationLeaks.join(", ")
  );

  // ---- Storage -------------------------------------------------------------
  const storageLeaks = [];
  for (const [name, c] of [["owner", ownerC.client], ["government", gov1.client], ["in-charge", incharge1.client], ["signed-out", anon]]) {
    const dl = await c.storage.from(BUCKET).download(main.path);
    const signed = await c.storage.from(BUCKET).createSignedUrl(main.path, 60);
    const list = await c.storage.from(BUCKET).list(`resolution/${main.id}`);
    const up = await c.storage.from(BUCKET).upload(`resolution/${main.id}/${randomUUID()}.jpg`, TINY_JPEG, { contentType: "image/jpeg" });
    if (dl.data || signed.data?.signedUrl || (list.data ?? []).length > 0 || !up.error) storageLeaks.push(name);
  }
  record("TEST 12 - DENY: the private bucket is unreachable directly (download, sign, list, upload) for every principal", storageLeaks.length === 0, storageLeaks.join(", "));

  const { data: signedMain } = await admin.storage.from(BUCKET).createSignedUrl(main.path, 900);
  const okMain = (await fetch(signedMain.signedUrl)).ok;
  const tampered = signedMain.signedUrl.replace(encodeURI(main.path), encodeURI(foreign.path));
  const tamperedRes = await fetch(tampered);
  record("TEST 13 - a signed URL serves only its own object (path swap to another report is rejected)", okMain && tampered !== signedMain.signedUrl && !tamperedRes.ok, `own=${okMain} swapped=${tamperedRes.status}`);

  // ---- Notifications (as the server actions create them) -------------------
  const insertN = async (recipientId, type, title) =>
    (await admin.from("notifications").insert({ recipient_id: recipientId, type, title, body: "G7 disposable", related_report_id: main.id }).select("id").single()).data.id;
  const nResolved = await insertN(owner.id, "report_resolved", "G7 Test: your report was resolved");
  const nIncharge = await insertN(incharge1.userId, "issue_reopened", "G7 Test: resolution rejected");
  const nGov = await insertN(gov1.userId, "resolution_feedback_recorded", "G7 Test: resolution verified by citizen");
  const sees = async (c, id) => (await rows(c, "notifications", "id", id)).length === 1;
  const everyone = [ownerC.client, gov1.client, incharge1.client, otherCitizenC.client, otherDeptC.client, tenaliC.client, anon];
  const onlyRecipient = async (id, recipientClient) => {
    for (const c of everyone) if ((await sees(c, id)) !== (c === recipientClient)) return false;
    return true;
  };
  record("TEST 14 - the citizen's resolution notification is readable only by the citizen", await onlyRecipient(nResolved, ownerC.client));
  record("TEST 15 - the in-charge's decision notification is readable only by that in-charge", await onlyRecipient(nIncharge, incharge1.client));
  record("TEST 16 - the government user's decision notification is readable only by that government user", await onlyRecipient(nGov, gov1.client));

  // ---- Atomic-guard behaviors of real Postgres/PostgREST -------------------
  // (a) unique report_id: exactly one of several concurrent first decisions wins.
  const race = await resolvedReport({ reporterId: owner.id, tag: "race-insert", jurisdiction: NARASARAOPET, departmentId: roads.id, inchargeId: incharge1.userId });
  const inserts = await Promise.all(
    [true, false, true, false, true].map((confirmed) => {
      const ts = new Date().toISOString();
      return admin.from("resolution_feedback").insert({ report_id: race.id, citizen_id: owner.id, confirmed, comment: confirmed ? null : "G7 race reason text", created_at: ts, updated_at: ts }).select("id");
    })
  );
  const wins = inserts.filter((x) => !x.error).length;
  const conflicts = inserts.filter((x) => x.error?.code === "23505").length;
  record("TEST 17 - concurrent first decisions: exactly one insert wins, the rest get unique_violation 23505", wins === 1 && conflicts === 4, `wins=${wins} 23505=${conflicts}`);

  // (b) earlier-cycle row: the conditional claim matches for exactly one.
  const cycle = await resolvedReport({ reporterId: owner.id, tag: "race-update", jurisdiction: NARASARAOPET, departmentId: roads.id, inchargeId: incharge1.userId });
  const earlier = new Date(Date.parse(cycle.resolvedAt) - 60_000).toISOString();
  const { data: oldFb } = await admin
    .from("resolution_feedback")
    .insert({ report_id: cycle.id, citizen_id: owner.id, confirmed: false, comment: "earlier cycle", created_at: earlier, updated_at: earlier })
    .select("id, updated_at")
    .single();
  const claims = await Promise.all(
    [true, false, true, false].map((confirmed) =>
      admin
        .from("resolution_feedback")
        .update({ confirmed, comment: confirmed ? null : "G7 race reason text", updated_at: new Date().toISOString() })
        .eq("id", oldFb.id)
        .eq("updated_at", oldFb.updated_at)
        .lt("updated_at", cycle.resolvedAt)
        .select("id")
    )
  );
  const claimed = claims.reduce((n, x) => n + (x.data?.length ?? 0), 0);
  const { data: afterClaim } = await admin.from("resolution_feedback").select("updated_at").eq("id", oldFb.id).single();
  const staleRetry = await admin
    .from("resolution_feedback")
    .update({ confirmed: true })
    .eq("id", oldFb.id)
    .eq("updated_at", oldFb.updated_at)
    .lt("updated_at", cycle.resolvedAt)
    .select("id");
  record(
    "TEST 18 - earlier-cycle row: exactly one concurrent conditional claim wins; updated_at moves past resolved_at; a stale retry matches nothing",
    claimed === 1 && Date.parse(afterClaim.updated_at) >= Date.parse(cycle.resolvedAt) && (staleRetry.data ?? []).length === 0 && !claims.some((x) => x.error),
    `claimed=${claimed}`
  );

  // (c) the reopen compare-and-set wins once.
  const reopenRace = await Promise.all(
    [0, 1, 2].map(() => admin.from("reports").update({ status: "reopened", reopened_at: new Date().toISOString() }).eq("id", race.id).eq("status", "resolved").select("id"))
  );
  const reopened = reopenRace.reduce((n, x) => n + (x.data?.length ?? 0), 0);
  record("TEST 19 - resolved -> reopened compare-and-set: exactly one of three concurrent reopens applies", reopened === 1, `applied=${reopened}`);

  // After a reopen the effective in-charge still sees the report and its
  // (previous) evidence — the workflow can continue.
  const afterReopen = await readsResolution(incharge1.client, race);
  record("TEST 20 - ALLOW: after a reopen the effective in-charge still reads the report and its previous evidence", afterReopen.report && afterReopen.evidence);
} catch (err) {
  record("script completed without error", false, err instanceof Error ? err.message : String(err));
} finally {
  // Cascades from reports: locations, assignments, media rows, evidence,
  // feedback, status_history, notifications(related_report_id).
  if (cleanupObjects.length) await admin.storage.from(BUCKET).remove(cleanupObjects);
  if (cleanupReports.length) await admin.from("reports").delete().in("id", cleanupReports);
  if (cleanupUsers.length) await admin.from("department_incharges").delete().in("profile_id", cleanupUsers);
  for (const id of cleanupUsers) await admin.auth.admin.deleteUser(id);

  if (baseline) {
    const final = await counts();
    const same = JSON.stringify(final) === JSON.stringify(baseline);
    record("CLEANUP - baseline counts restored (reports, users, in-charges, assignments, media, evidence, feedback, history, notifications, reminders, storage)", same, same ? "" : `after=${JSON.stringify(final)}`);
    const { count: leftover } = await admin.from("reports").select("*", { count: "exact", head: true }).ilike("title", "G7 Test:%");
    record("CLEANUP - no leftover G7 fixture reports", leftover === 0);
  }
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
