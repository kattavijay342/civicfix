// AI-2 worker — PostgreSQL integration checks against the LOCAL Docker
// Supabase stack ONLY (prepared in CP2; to be run in CP3 after separate
// approval). Requires migrations 0001–0020 applied to a fresh LOCAL database,
// e.g. `npx supabase start` then `npx supabase db reset` (local only).
//
// Checks (real Postgres semantics the unit tests' in-memory fake can't prove):
//   A. claim_due_ai_jobs / claim_due_incident_jobs: 20 parallel callers,
//      every due job claimed exactly once (FOR UPDATE SKIP LOCKED), attempts
//      incremented, lease set from the database clock; jobs at max_attempts
//      or not yet due are never claimed;
//   B. acquire/release_ai_worker_lease: 20 parallel acquirers -> exactly one
//      holder; release only by the holder; takeover only after expiry;
//   C. CHECK constraints on both job tables and the lease table;
//   D. ON DELETE CASCADE from reports (both sides of incident jobs);
//   E. RLS + grants: anon and authenticated can neither read the new tables
//      nor EXECUTE the new functions; service_role can;
//   F. find_reports_missing_ai_job: 48h ceiling, p_since, E2E- exclusion,
//      analyzed/queued reports excluded;
//   G. reports.status and report_assignments are byte-identical afterwards;
//   H. cleanup back to baseline;
//   I. (CP3.1) renew_ai_worker_lease — only if migration 0021 is applied:
//      correct holder renews and gets a positive, consistent remaining
//      duration; wrong holder/wrong name cannot renew; a holder who lost
//      the lease to a takeover (simulating "expired, then reclaimed") can
//      no longer renew it; 20 parallel wrong-holder renewals never let a
//      different holder take over mid-flight. If 0021 is NOT applied, this
//      section is SKIPPED with an explicit message — it is never silently
//      treated as a pass or a fail.
//
// Safety: aborts before creating any client unless NEXT_PUBLIC_SUPABASE_URL
// is exactly http://127.0.0.1:54321 or http://localhost:54321 and both keys
// are the local CLI's (scripts/lib/local-supabase-guard.mjs) — every hosted
// *.supabase.co project is rejected and there is no .env.local fallback.
// Never calls Gemini. Sends no email (the throwaway user is created with
// email_confirm, no invite).
// Usage: node --env-file=.env.g8-local scripts/verify-ai-worker-local.mjs
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { exitUnlessLocalSupabaseEnv } from "./lib/local-supabase-guard.mjs";

const { url, anonKey, serviceRoleKey } = exitUnlessLocalSupabaseEnv();
const service = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const must = (r, what) => {
  if (r.error) throw new Error(`${what}: ${r.error.code ?? ""} ${r.error.message}`);
  return r.data;
};

const RUN = randomUUID().slice(0, 8);
const email = `ai2-verify-${RUN}@example.test`;
const password = `Local-only-${randomUUID()}`;
const created = { reports: [], userId: null };
// Every ai_worker_lease row this run may create — exact names, never a pattern.
const LEASE_NAMES = [`verify_${RUN}`, `bad_${RUN}`, `probe_${RUN}`, `probe0021_${RUN}`, `verify21_${RUN}`, `verify21_${RUN}_nope`];

async function snapshotInvariants() {
  const reports = must(await service.from("reports").select("id, status, reporter_id").order("id"), "snapshot reports");
  const assignments = must(
    await service.from("report_assignments").select("report_id, department_id, incharge_id").order("report_id"),
    "snapshot assignments"
  );
  return JSON.stringify({ reports: reports.filter((r) => !created.reports.includes(r.id)), assignments });
}

/** Pre-existing local data that must survive untouched (ids only, no PII). */
async function snapshotPreserved() {
  const profiles = must(await service.from("profiles").select("id, role, department_id").order("id"), "snapshot profiles");
  const departments = must(await service.from("departments").select("id, name").order("id"), "snapshot departments");
  const incharges = must(
    await service.from("department_incharges").select("profile_id, department_id, is_active").order("profile_id"),
    "snapshot incharges"
  );
  const leases = must(await service.from("ai_worker_lease").select("name, holder, locked_until").order("name"), "snapshot leases");
  return JSON.stringify({
    profiles: profiles.filter((p) => p.id !== created.userId),
    departments,
    incharges,
    leases: leases.filter((l) => !LEASE_NAMES.includes(l.name)),
  });
}

async function makeReport({ area = `AI2-${RUN}`, createdAt } = {}) {
  const row = must(
    await service
      .from("reports")
      .insert({
        reporter_id: created.userId,
        title: `AI2 verify ${RUN}`,
        description: "AI-2 local verification fixture.",
        category: "road",
        status: "reported",
        ...(createdAt ? { created_at: createdAt } : {}),
      })
      .select("id")
      .single(),
    "insert report"
  );
  created.reports.push(row.id);
  must(
    await service.from("report_locations").insert({
      report_id: row.id,
      display_name: "AI2 local fixture",
      state: "Andhra Pradesh",
      district: "Palnadu",
      constituency: "Narasaraopet",
      area,
      location_source: "manual",
    }),
    "insert location"
  );
  return row.id;
}

let preservedBefore = null;

/** Detects migration 0021 by probing the function itself (no raw SQL/
 * schema-table access needed): a missing function fails with PostgREST's
 * "could not find the function" error (PGRST202); any other response means
 * it exists. Uses a run-scoped lease name, so the probe touches nothing
 * else even if the function did unexpectedly do something. */
async function probeMigration0021() {
  const probeName = `probe0021_${RUN}`;
  const r = await service.rpc("renew_ai_worker_lease", { p_name: probeName, p_holder: randomUUID(), p_seconds: 60 });
  if (r.error?.code === "PGRST202") return false;
  if (r.error) throw new Error(`renew_ai_worker_lease probe failed unexpectedly: ${r.error.code ?? ""} ${r.error.message}`);
  return true;
}

async function main() {
  preservedBefore = await snapshotPreserved();
  // Throwaway local user (needed as reporter_id and for the authenticated-role checks).
  const user = must(await service.auth.admin.createUser({ email, password, email_confirm: true }), "create user");
  created.userId = user.user.id;
  const before = await snapshotInvariants();

  // ---------------- A. batch claims ----------------
  const due = [];
  for (let i = 0; i < 5; i++) due.push(await makeReport());
  const notDue = await makeReport();
  const exhausted = await makeReport();
  must(await service.from("ai_analysis_jobs").insert(due.map((report_id) => ({ report_id }))), "insert due jobs");
  must(await service.from("ai_analysis_jobs").insert({ report_id: notDue, next_attempt_at: new Date(Date.now() + 3600e3).toISOString() }), "insert not-due job");
  must(await service.from("ai_analysis_jobs").insert({ report_id: exhausted, attempts: 6, max_attempts: 6 }), "insert exhausted job");

  const claims = await Promise.all(
    Array.from({ length: 20 }, () => service.rpc("claim_due_ai_jobs", { p_limit: 1, p_lease_seconds: 180, p_model: "verify-model" }))
  );
  const claimed = claims.flatMap((r) => must(r, "claim").map((j) => j.report_id));
  check("A1 20 parallel claimers: each due AI job claimed exactly once", claimed.length === 5 && new Set(claimed).size === 5 && claimed.every((id) => due.includes(id)), `claimed=${claimed.length}`);
  const claimedRows = must(await service.from("ai_analysis_jobs").select("report_id, status, attempts, locked_until, last_model").in("report_id", due), "read claimed");
  // Lease is set by the DATABASE clock; a wide window tolerates Docker/host clock drift.
  check(
    "A2 claimed rows: processing, attempts=1, lease ~180s ahead (DB clock), model recorded",
    claimedRows.every((j) => {
      const ahead = Date.parse(j.locked_until) - Date.now();
      return j.status === "processing" && j.attempts === 1 && j.last_model === "verify-model" && ahead > 120e3 && ahead < 240e3;
    })
  );
  check("A3 not-due and exhausted jobs never claimed", !claimed.includes(notDue) && !claimed.includes(exhausted));
  must(await service.from("ai_analysis_jobs").update({ locked_until: new Date(Date.now() - 1000).toISOString() }).eq("report_id", due[0]), "expire lease");
  const reclaim = must(await service.rpc("claim_due_ai_jobs", { p_limit: 5, p_lease_seconds: 180, p_model: null }), "reclaim");
  check("A4 an expired processing lease is re-claimable (attempts -> 2)", reclaim.length === 1 && reclaim[0].report_id === due[0] && reclaim[0].attempts === 2);

  const incidentPairs = [];
  for (let i = 0; i < 3; i++) incidentPairs.push([await makeReport(), await makeReport()]);
  must(await service.from("incident_confirmation_jobs").insert(incidentPairs.map(([a, b]) => ({ report_id: a, candidate_report_id: b, match_score: 0.6 }))), "insert incident jobs");
  const iclaims = await Promise.all(Array.from({ length: 20 }, () => service.rpc("claim_due_incident_jobs", { p_limit: 1, p_lease_seconds: 180, p_model: "gemini-3.6-flash" })));
  const iclaimed = iclaims.flatMap((r) => must(r, "incident claim").map((j) => j.report_id));
  check("A5 20 parallel incident claimers: each job claimed exactly once", iclaimed.length === 3 && new Set(iclaimed).size === 3);

  // ---------------- B. worker lease ----------------
  const holders = Array.from({ length: 20 }, () => randomUUID());
  const acquires = await Promise.all(holders.map((h) => service.rpc("acquire_ai_worker_lease", { p_name: `verify_${RUN}`, p_holder: h, p_seconds: 270 })));
  const winners = holders.filter((_, i) => must(acquires[i], "acquire") === true);
  check("B1 20 parallel acquirers -> exactly one holder", winners.length === 1);
  const loser = holders.find((h) => h !== winners[0]);
  check("B2 release by a non-holder changes nothing", must(await service.rpc("release_ai_worker_lease", { p_name: `verify_${RUN}`, p_holder: loser }), "release loser") === false);
  check("B3 a second acquire while held is rejected", must(await service.rpc("acquire_ai_worker_lease", { p_name: `verify_${RUN}`, p_holder: loser, p_seconds: 270 }), "acquire held") === false);
  must(await service.from("ai_worker_lease").update({ locked_until: new Date(Date.now() - 1000).toISOString() }).eq("name", `verify_${RUN}`), "expire worker lease");
  check("B4 takeover allowed only after expiry", must(await service.rpc("acquire_ai_worker_lease", { p_name: `verify_${RUN}`, p_holder: loser, p_seconds: 270 }), "takeover") === true);
  check("B5 the old holder can no longer release it", must(await service.rpc("release_ai_worker_lease", { p_name: `verify_${RUN}`, p_holder: winners[0] }), "release stale") === false);
  check("B6 the current holder releases it", must(await service.rpc("release_ai_worker_lease", { p_name: `verify_${RUN}`, p_holder: loser }), "release holder") === true);

  // ---------------- C. CHECK constraints ----------------
  const c1 = await makeReport();
  const bad = [
    ["attempts > max_attempts", service.from("ai_analysis_jobs").insert({ report_id: c1, attempts: 7, max_attempts: 6 })],
    ["invalid status", service.from("ai_analysis_jobs").insert({ report_id: c1, status: "done" })],
    ["processing without lease", service.from("ai_analysis_jobs").insert({ report_id: c1, status: "processing", attempts: 1 })],
    ["unsanitized error kind", service.from("ai_analysis_jobs").insert({ report_id: c1, last_error_kind: "Error: secret text" })],
    ["incident job against itself", service.from("incident_confirmation_jobs").insert({ report_id: c1, candidate_report_id: c1, match_score: 0.5 })],
    ["incident score > 1", service.from("incident_confirmation_jobs").insert({ report_id: c1, candidate_report_id: due[1], match_score: 1.5 })],
    ["lease holder without expiry", service.from("ai_worker_lease").insert({ name: `bad_${RUN}`, holder: randomUUID() })],
  ];
  for (const [label, p] of bad) {
    const r = await p;
    check(`C ${label} rejected (23514)`, r.error?.code === "23514", r.error?.code ?? "no error");
  }

  // ---------------- D. cascades ----------------
  const [cascA, cascB] = incidentPairs[0];
  must(await service.from("reports").delete().eq("id", cascB), "delete candidate report");
  const leftIncident = must(await service.from("incident_confirmation_jobs").select("report_id").eq("report_id", cascA), "read cascaded incident job");
  check("D1 deleting the candidate report cascades its incident job", leftIncident.length === 0);
  must(await service.from("reports").delete().eq("id", due[4]), "delete report");
  const leftAi = must(await service.from("ai_analysis_jobs").select("report_id").eq("report_id", due[4]), "read cascaded ai job");
  check("D2 deleting a report cascades its AI job", leftAi.length === 0);

  // ---------------- E. RLS + grants ----------------
  const authed = createClient(url, anonKey, { auth: { persistSession: false } });
  must(await authed.auth.signInWithPassword({ email, password }), "sign in");
  for (const [who, client] of [["anon", anon], ["authenticated", authed]]) {
    for (const table of ["ai_analysis_jobs", "incident_confirmation_jobs", "ai_worker_lease"]) {
      const r = await client.from(table).select("*").limit(1);
      check(`E ${who} cannot read ${table}`, !!r.error || (Array.isArray(r.data) && r.data.length === 0), r.error?.code ?? "empty");
    }
    for (const [fn, args] of [
      ["claim_due_ai_jobs", { p_limit: 1, p_lease_seconds: 180, p_model: null }],
      ["claim_due_incident_jobs", { p_limit: 1, p_lease_seconds: 180, p_model: null }],
      ["find_reports_missing_ai_job", { p_since: new Date(0).toISOString(), p_limit: 1 }],
      // Run-scoped lease name: even if a grant were wrong, the real 'ai' lease is never touched.
      ["acquire_ai_worker_lease", { p_name: `probe_${RUN}`, p_holder: randomUUID(), p_seconds: 270 }],
      ["release_ai_worker_lease", { p_name: `probe_${RUN}`, p_holder: randomUUID() }],
    ]) {
      const r = await client.rpc(fn, args);
      check(`E ${who} cannot EXECUTE ${fn}`, !!r.error, r.error?.code ?? "EXECUTED");
    }
  }

  // ---------------- F. missing-job finder ----------------
  const fresh = await makeReport();
  const e2e = await makeReport({ area: `E2E-${RUN}` });
  const old = await makeReport({ createdAt: new Date(Date.now() - 72 * 3600e3).toISOString() });
  const queued = due[1];
  const analyzed = await makeReport();
  must(
    await service.from("ai_analyses").insert({
      report_id: analyzed,
      problem_summary: "AI-2 local fixture",
      category: "road",
      severity: "low",
      priority: "low",
      reasoning: "fixture",
      recommended_department: "Roads & Infrastructure",
      recommended_action: "fixture",
      confidence: 0.5,
      model: "verify-model",
    }),
    "insert analysis fixture"
  );
  const found = must(await service.rpc("find_reports_missing_ai_job", { p_since: new Date(Date.now() - 365 * 24 * 3600e3).toISOString(), p_limit: 100 }), "find missing").map((r) => r.report_id);
  check("F1 a fresh report with no job is found", found.includes(fresh));
  check("F2 an E2E- location is excluded", !found.includes(e2e));
  check("F3 a report older than 48h is excluded even with an old p_since", !found.includes(old));
  check("F4 an already-queued report is excluded", !found.includes(queued));
  check("F6 an already-analyzed report (no job) is excluded", !found.includes(analyzed));
  const later = must(await service.rpc("find_reports_missing_ai_job", { p_since: new Date(Date.now() + 60e3).toISOString(), p_limit: 100 }), "find later").map((r) => r.report_id);
  check("F5 p_since is honoured (future cutoff -> nothing)", !later.includes(fresh));

  // ---------------- G. invariants ----------------
  check("G existing reports.status/reporter_id and report_assignments unchanged", (await snapshotInvariants()) === before);

  // ---------------- I. renew_ai_worker_lease (CP3.1 / migration 0021) ----------------
  const has0021 = await probeMigration0021();
  if (!has0021) {
    console.log("\nSKIPPED section I: migration 0021_ai_worker_lease_renewal.sql is NOT applied to this local database.");
    console.log("Apply it with `npx supabase migration up --local` (never --linked) and re-run this script to cover renew_ai_worker_lease.");
  } else {
    const leaseName = `verify21_${RUN}`;
    const holderA = randomUUID();
    const holderB = randomUUID();
    must(await service.rpc("acquire_ai_worker_lease", { p_name: leaseName, p_holder: holderA, p_seconds: 270 }), "I setup: acquire");

    const renewOk = must(await service.rpc("renew_ai_worker_lease", { p_name: leaseName, p_holder: holderA, p_seconds: 90 }), "I1 renew");
    check(
      "I1 correct name+holder renews successfully with a positive, consistent remaining duration",
      typeof renewOk === "number" && renewOk > 0 && renewOk <= 90_000 && renewOk > 60_000,
      `remainingMs=${renewOk}`
    );
    const rowAfterOk = must(await service.from("ai_worker_lease").select("locked_until").eq("name", leaseName).single(), "I1 read lease");
    const aheadMs = Date.parse(rowAfterOk.locked_until) - Date.now();
    check("I1b the renewed locked_until is ~90s ahead (DB clock)", aheadMs > 60_000 && aheadMs < 120_000, `aheadMs=${aheadMs}`);

    const renewWrongHolder = must(await service.rpc("renew_ai_worker_lease", { p_name: leaseName, p_holder: holderB, p_seconds: 90 }), "I2 renew wrong holder");
    check("I2 wrong holder cannot renew (returns null, row untouched)", renewWrongHolder === null);

    // Must be a validly-formatted lease name (^[a-z0-9_]{1,40}$, same rule
    // the function itself enforces) that simply does not exist, so this
    // tests "wrong name" — not the separate name-format validation.
    const renewWrongName = must(await service.rpc("renew_ai_worker_lease", { p_name: `${leaseName}_nope`, p_holder: holderA, p_seconds: 90 }), "I3 renew wrong name");
    check("I3 wrong lease name cannot renew", renewWrongName === null);

    // I4: simulate "expired, then taken over" — expire the lease, let a
    // different holder (B) legitimately reclaim it via acquire, then
    // confirm the ORIGINAL holder (A) can no longer renew it.
    must(await service.from("ai_worker_lease").update({ locked_until: new Date(Date.now() - 1000).toISOString() }).eq("name", leaseName), "I4 expire");
    const takeover = must(await service.rpc("acquire_ai_worker_lease", { p_name: leaseName, p_holder: holderB, p_seconds: 270 }), "I4 takeover");
    check("I4 setup: the expired lease was retaken by holder B", takeover === true);
    const renewAfterExpiry = must(await service.rpc("renew_ai_worker_lease", { p_name: leaseName, p_holder: holderA, p_seconds: 90 }), "I4 renew after expiry/takeover");
    check("I4 the former holder cannot renew an expired lease that was retaken", renewAfterExpiry === null);

    // I5: consistency across a couple of requested durations.
    const r60 = must(await service.rpc("renew_ai_worker_lease", { p_name: leaseName, p_holder: holderB, p_seconds: 60 }), "I5 renew 60s");
    const r300 = must(await service.rpc("renew_ai_worker_lease", { p_name: leaseName, p_holder: holderB, p_seconds: 300 }), "I5 renew 300s");
    check(
      "I5 the returned duration scales with the requested seconds (both positive, 300s > 60s)",
      typeof r60 === "number" && r60 > 0 && r60 <= 60_000 && typeof r300 === "number" && r300 > 0 && r300 <= 300_000 && r300 > r60
    );

    // I6: 20 parallel renewals from the WRONG holder must never let any of
    // them take over — the lease stays holder B's throughout.
    const impostors = Array.from({ length: 20 }, () => randomUUID());
    const parallel = await Promise.all(impostors.map((h) => service.rpc("renew_ai_worker_lease", { p_name: leaseName, p_holder: h, p_seconds: 90 })));
    const parallelResults = parallel.map((r) => must(r, "I6 parallel renew"));
    check("I6 20 parallel wrong-holder renewals all return null", parallelResults.every((d) => d === null));
    const rowAfterParallel = must(await service.from("ai_worker_lease").select("holder").eq("name", leaseName).single(), "I6 read lease");
    check("I6 the lease's holder is still B — no impostor took over", rowAfterParallel.holder === holderB);

    must(await service.from("ai_worker_lease").delete().eq("name", leaseName), "I cleanup");
  }
}

async function cleanup() {
  try {
    if (created.reports.length) await service.from("reports").delete().in("id", created.reports); // cascades jobs/locations
    await service.from("ai_worker_lease").delete().in("name", LEASE_NAMES);
    if (created.userId) await service.auth.admin.deleteUser(created.userId);
    const ids = created.reports.length ? created.reports : [randomUUID()];
    const left = must(await service.from("reports").select("id").in("id", ids), "verify cleanup reports");
    const leftJobs = must(await service.from("ai_analysis_jobs").select("report_id").in("report_id", ids), "verify cleanup ai jobs");
    const leftIncident = must(await service.from("incident_confirmation_jobs").select("report_id").in("report_id", ids), "verify cleanup incident jobs");
    const leftLeases = must(await service.from("ai_worker_lease").select("name").in("name", LEASE_NAMES), "verify cleanup leases");
    const leftUser = created.userId ? (await service.auth.admin.getUserById(created.userId)).data?.user : null;
    check(
      "H1 cleanup removed every fixture (reports, jobs, leases, throwaway user)",
      left.length === 0 && leftJobs.length === 0 && leftIncident.length === 0 && leftLeases.length === 0 && !leftUser
    );
    if (preservedBefore) {
      check("H2 pre-existing profiles, departments, in-charge rows and leases are untouched", (await snapshotPreserved()) === preservedBefore);
    }
  } catch (err) {
    check("H cleanup", false, err.message);
  }
}

try {
  await main();
} catch (err) {
  check("unexpected error", false, err.message);
} finally {
  await cleanup();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
