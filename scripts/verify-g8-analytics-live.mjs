// G8 Government Analytics — live database/RLS/EXECUTE checks against the
// LOCAL Docker Supabase stack. Requires migration 0018_g8_area_breakdown.sql
// to be applied. Every principal calls the analytics RPCs through the anon
// key + its own signed-in session, so Postgres RLS and function grants —
// never application code — decide each outcome:
//   A. RPC security — anon cannot EXECUTE any Government-dashboard analytics
//      RPC; signed-in callers can; security invoker (each caller gets only
//      what its own RLS allows),
//   B. jurisdiction isolation — gov1 (jurisdiction A) and gov2 (jurisdiction
//      B) each see only their own jurisdiction, never the other's,
//   C. area breakdown — grouping by state/district/constituency/area with
//      exact total/pending/critical_open/resolved for known fixtures,
//   D. reconciliation — per caller, breakdown totals equal the reports RLS
//      lets it read directly and get_area_overview()/get_insight_metrics();
//      per row pending + resolved = total; critical_open = unresolved
//      critical only,
//   E. a government user with no matching reports gets zero rows,
//   F. citizens see only their own reports,
//   G. the department in-charge sees only its effective assignments,
//   H. client-supplied parameters/filters/profile edits cannot widen scope,
//   I/J. cleanup back to the exact baseline, with final row counts.
//
// Permanent local accounts (seeded by scripts/seed-test-accounts.mjs
// --local) are used read-only: citizen1, gov1, gov2, incharge1. Fixtures are
// "G8 Test:" reports filed by a throwaway citizen, plus a throwaway
// government user in an empty synthetic jurisdiction; all are deleted at
// the end and baseline counts are compared before/after. Sends NO email.
//
// Safety: LOCAL Docker Supabase only. Aborts before creating any client
// unless NEXT_PUBLIC_SUPABASE_URL is exactly http://127.0.0.1:54321 or
// http://localhost:54321 and both keys are the local CLI's
// (scripts/lib/local-supabase-guard.mjs) — every hosted *.supabase.co
// project is rejected, and there is no .env.local fallback.
// Usage: node --env-file=.env.g8-local scripts/verify-g8-analytics-live.mjs
import { createClient } from "@supabase/supabase-js";
import { exitUnlessLocalSupabaseEnv } from "./lib/local-supabase-guard.mjs";

// URL + both keys must be the local CLI's; aborts before any client exists.
const { url, anonKey, serviceRoleKey: serviceKey } = exitUnlessLocalSupabaseEnv();

const noPersist = { auth: { autoRefreshToken: false, persistSession: false } };
const admin = createClient(url, serviceKey, noPersist);
const PASSWORD = "CivicFixTest2026!";
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const PERMANENT = ["citizen1", "citizen2", "gov1", "gov2", "incharge1"].map((n) => `${n}@test.civicfix.local`);

const ANALYTICS_RPCS = [
  ["get_area_breakdown"],
  ["get_area_overview"],
  ["get_department_performance"],
  ["get_insight_metrics"],
  ["get_area_concentration"],
  ["get_aging_buckets"],
  ["get_resolution_quality"],
  ["get_department_workload"],
  ["get_department_trend", { p_days: 30 }],
  ["get_category_trends", { p_days: 30 }],
];

const results = [];
function record(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} - ${name}${detail ? ` (${detail})` : ""}`);
}

const cleanupUsers = [];
const cleanupReports = [];

const COUNT_TABLES = [
  "reports",
  "report_locations",
  "report_assignments",
  "profiles",
  "departments",
  "department_incharges",
  "notifications",
  "reminders",
  "follow_ups",
  "status_history",
  "resolution_evidence",
  "resolution_feedback",
];
async function counts() {
  const out = {};
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  out.auth_users = users.users.length;
  for (const t of COUNT_TABLES) out[t] = (await admin.from(t).select("*", { count: "exact", head: true })).count;
  return out;
}

async function throwawayUser(tag) {
  const email = `g8-${tag}-${RUN}@test.civicfix.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: `G8 ${tag}` } });
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

async function fixtureReport({ reporterId, tag, jurisdiction, status = "routed", priority = "medium", assignment = null }) {
  const title = `G8 Test: ${tag} ${RUN}`;
  const { data: report, error } = await admin
    .from("reports")
    .insert({ reporter_id: reporterId, title, description: `${title} — disposable, deleted by this script.`, category: "road", status, priority, severity: priority })
    .select("id")
    .single();
  if (error) throw new Error(`report insert failed: ${error.message}`);
  cleanupReports.push(report.id);
  if (jurisdiction) {
    const loc = await admin.from("report_locations").insert({ report_id: report.id, display_name: `G8 fixture location ${RUN}`, ...jurisdiction, location_source: "manual" });
    if (loc.error) throw new Error(`location insert failed: ${loc.error.message}`);
  }
  if (assignment) {
    const asg = await admin.from("report_assignments").insert({ report_id: report.id, ...assignment, assignment_method: "auto" });
    if (asg.error) throw new Error(`assignment insert failed: ${asg.error.message}`);
  }
  return report.id;
}

async function breakdown(client) {
  const { data, error } = await client.rpc("get_area_breakdown");
  if (error) throw new Error(`get_area_breakdown failed: ${error.message}`);
  return data.map((r) => ({
    ...r,
    total_issues: Number(r.total_issues),
    pending_issues: Number(r.pending_issues),
    critical_open: Number(r.critical_open),
    resolved_issues: Number(r.resolved_issues),
  }));
}
const sum = (rows, key) => rows.reduce((s, r) => s + r[key], 0);
const sameLoc = (r, j) => r.state === j.state && r.district === j.district && r.constituency === j.constituency && r.area === j.area;
const rowFor = (rows, j) => rows.find((r) => sameLoc(r, j));
const inScope = (row, p) =>
  (!p.gov_state || row.state === p.gov_state) &&
  (!p.gov_district || row.district === p.gov_district) &&
  (!p.gov_constituency || row.constituency === p.gov_constituency) &&
  (!p.gov_area || row.area === p.gov_area);
const jurisdictionOf = (p) => ({ state: p.gov_state, district: p.gov_district, constituency: p.gov_constituency, area: p.gov_area });
const metrics = (r) => r && { total: r.total_issues, pending: r.pending_issues, critical_open: r.critical_open, resolved: r.resolved_issues };

/** D — everything that must reconcile for one caller. */
async function reconcile(label, client) {
  const rows = await breakdown(client);
  const { data: visible } = await client.from("reports").select("id, status, priority");
  const direct = {
    total: visible.length,
    pending: visible.filter((r) => r.status !== "resolved").length,
    critical_open: visible.filter((r) => r.priority === "critical" && r.status !== "resolved").length,
    resolved: visible.filter((r) => r.status === "resolved").length,
  };
  const got = { total: sum(rows, "total_issues"), pending: sum(rows, "pending_issues"), critical_open: sum(rows, "critical_open"), resolved: sum(rows, "resolved_issues") };
  record(`D - ${label}: breakdown totals equal the reports RLS lets it read directly`, JSON.stringify(got) === JSON.stringify(direct), `breakdown=${JSON.stringify(got)} direct=${JSON.stringify(direct)}`);
  record(`D - ${label}: every row has pending + resolved = total`, rows.every((r) => r.pending_issues + r.resolved_issues === r.total_issues), `${rows.length} rows`);
  const { data: ov } = await client.rpc("get_area_overview").maybeSingle();
  const { data: im } = await client.rpc("get_insight_metrics").maybeSingle();
  const agg = { total: Number(ov.total_issues), pending: Number(ov.pending), critical_open: Number(im.critical_unresolved), resolved: Number(ov.resolved) };
  record(`D - ${label}: totals reconcile with get_area_overview() and get_insight_metrics().critical_unresolved`, JSON.stringify(got) === JSON.stringify(agg), `aggregates=${JSON.stringify(agg)}`);
  return { rows, visibleIds: visible.map((r) => r.id) };
}

let baseline;
try {
  baseline = await counts();
  console.log(`Target: ${url} (local only)`);
  console.log("Baseline:", JSON.stringify(baseline));

  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const byEmail = (e) => users.users.find((u) => u.email === e);
  const missing = PERMANENT.filter((e) => !byEmail(e));
  if (missing.length) throw new Error(`Seeded accounts missing: ${missing.join(", ")} — run scripts/seed-test-accounts.mjs --local first.`);
  const profileOf = async (email) => (await admin.from("profiles").select("id, role, gov_state, gov_district, gov_constituency, gov_area").eq("id", byEmail(email).id).single()).data;
  const gov1Profile = await profileOf("gov1@test.civicfix.local");
  const gov2Profile = await profileOf("gov2@test.civicfix.local");
  const A = jurisdictionOf(gov1Profile);
  const B = jurisdictionOf(gov2Profile);
  if (gov1Profile.role !== "government" || gov2Profile.role !== "government" || JSON.stringify(A) === JSON.stringify(B)) {
    throw new Error("gov1/gov2 must be government users in two different jurisdictions.");
  }
  console.log(`Jurisdiction A (gov1): ${Object.values(A).join(" / ")}`);
  console.log(`Jurisdiction B (gov2): ${Object.values(B).join(" / ")}`);

  const { data: departments } = await admin.from("departments").select("id, name");
  const roads = departments.find((d) => d.name === "Roads & Infrastructure");

  const gov1 = await asUser("gov1@test.civicfix.local");
  const gov2 = await asUser("gov2@test.civicfix.local");
  const citizen1 = await asUser("citizen1@test.civicfix.local");
  const incharge1 = await asUser("incharge1@test.civicfix.local");
  const anon = createClient(url, anonKey, noPersist);

  // ---- A. RPC security --------------------------------------------------
  for (const [fn, args] of ANALYTICS_RPCS) {
    const { data, error } = await anon.rpc(fn, args);
    record(`A - anon DENIED ${fn}()`, !!error && /permission denied/i.test(error.message), error ? error.message : `executed, returned ${JSON.stringify(data).slice(0, 80)}`);
  }
  for (const [fn, args] of ANALYTICS_RPCS) {
    const { error } = await gov1.client.rpc(fn, args);
    record(`A - authenticated (gov1) ALLOWED ${fn}()`, !error, error?.message ?? "");
  }

  // ---- Fixtures -----------------------------------------------------------
  const reporter = await throwawayUser("citizen");
  const govEmptyAuth = await throwawayUser("gov-empty");
  const EMPTY = { state: `G8 Empty State ${RUN}`, district: "G8 Empty District", constituency: "G8 Empty Constituency", area: "G8 Empty Area" };
  await admin.from("profiles").update({ role: "government", gov_state: EMPTY.state, gov_district: EMPTY.district, gov_constituency: EMPTY.constituency, gov_area: EMPTY.area }).eq("id", govEmptyAuth.id);

  const gov1Before = await breakdown(gov1.client);
  const gov2Before = await breakdown(gov2.client);
  const inchargeBefore = (await incharge1.client.from("reports").select("id")).data.map((r) => r.id);

  // Jurisdiction A: +4 total, +2 resolved, +2 pending (incl. reopened), +1 open critical.
  const toIncharge1 = { department_id: roads.id, incharge_id: incharge1.userId };
  const a1 = await fixtureReport({ reporterId: reporter.id, tag: "A critical open", jurisdiction: A, priority: "critical", assignment: toIncharge1 });
  const a2 = await fixtureReport({ reporterId: reporter.id, tag: "A critical resolved", jurisdiction: A, priority: "critical", status: "resolved", assignment: toIncharge1 });
  const a3 = await fixtureReport({ reporterId: reporter.id, tag: "A low resolved", jurisdiction: A, priority: "low", status: "resolved" });
  const a4 = await fixtureReport({ reporterId: reporter.id, tag: "A high reopened", jurisdiction: A, priority: "high", status: "reopened" });
  // Jurisdiction B: +3 total, +1 resolved, +2 pending, +1 open critical (the resolved critical must NOT count).
  const b1 = await fixtureReport({ reporterId: reporter.id, tag: "B critical open", jurisdiction: B, priority: "critical" });
  const b2 = await fixtureReport({ reporterId: reporter.id, tag: "B low open", jurisdiction: B, priority: "low" });
  const b3 = await fixtureReport({ reporterId: reporter.id, tag: "B critical resolved", jurisdiction: B, priority: "critical", status: "resolved" });
  // No stored location: counted only for its reporter, in an all-NULL row.
  const u1 = await fixtureReport({ reporterId: reporter.id, tag: "unlocated", jurisdiction: null, status: "reported", priority: null });
  const aIds = [a1, a2, a3, a4];
  const bIds = [b1, b2, b3];

  const citizen = await asUser(reporter.email);
  const govEmpty = await asUser(govEmptyAuth.email);

  // ---- B. Jurisdiction isolation -----------------------------------------
  const gov1Rec = await reconcile("gov1 (jurisdiction A)", gov1.client);
  const gov2Rec = await reconcile("gov2 (jurisdiction B)", gov2.client);
  record("B - every gov1 row lies inside jurisdiction A", gov1Rec.rows.every((r) => inScope(r, gov1Profile)), `${gov1Rec.rows.length} rows`);
  record("B - every gov2 row lies inside jurisdiction B", gov2Rec.rows.every((r) => inScope(r, gov2Profile)), `${gov2Rec.rows.length} rows`);
  record("B - gov1 breakdown has no jurisdiction-B row", !rowFor(gov1Rec.rows, B));
  record("B - gov2 breakdown has no jurisdiction-A row", !rowFor(gov2Rec.rows, A));
  record("B - gov1 can read every A fixture and no B fixture", aIds.every((id) => gov1Rec.visibleIds.includes(id)) && !bIds.some((id) => gov1Rec.visibleIds.includes(id)) && !gov1Rec.visibleIds.includes(u1));
  record("B - gov2 can read every B fixture and no A fixture", bIds.every((id) => gov2Rec.visibleIds.includes(id)) && !aIds.some((id) => gov2Rec.visibleIds.includes(id)) && !gov2Rec.visibleIds.includes(u1));

  // ---- C. Area breakdown ----------------------------------------------------
  const delta = (after, before) => {
    const a = metrics(after) ?? { total: 0, pending: 0, critical_open: 0, resolved: 0 };
    const b = metrics(before) ?? { total: 0, pending: 0, critical_open: 0, resolved: 0 };
    return { total: a.total - b.total, pending: a.pending - b.pending, critical_open: a.critical_open - b.critical_open, resolved: a.resolved - b.resolved };
  };
  const dA = delta(rowFor(gov1Rec.rows, A), rowFor(gov1Before, A));
  record("C - gov1 jurisdiction-A row grows by exactly the fixtures (+4 total, +2 pending incl. reopened, +1 open critical, +2 resolved)", JSON.stringify(dA) === JSON.stringify({ total: 4, pending: 2, critical_open: 1, resolved: 2 }), JSON.stringify(dA));
  const dB = delta(rowFor(gov2Rec.rows, B), rowFor(gov2Before, B));
  record("C - gov2 jurisdiction-B row grows by exactly the fixtures (+3 total, +2 pending, +1 open critical — resolved critical excluded, +1 resolved)", JSON.stringify(dB) === JSON.stringify({ total: 3, pending: 2, critical_open: 1, resolved: 1 }), JSON.stringify(dB));
  record("C - gov1/gov2 rows carry all four location levels (state/district/constituency/area)", [...gov1Rec.rows, ...gov2Rec.rows].every((r) => r.state && r.district && r.constituency && r.area));

  // ---- F. Citizen scope (also C: grouping across several places) ----------
  const citizenRec = await reconcile("fixture citizen", citizen.client);
  record(
    "C - fixture citizen's breakdown is grouped into exactly three rows: A (4), B (3), and an all-NULL row for the unlocated report (1)",
    citizenRec.rows.length === 3 &&
      JSON.stringify(metrics(rowFor(citizenRec.rows, A))) === JSON.stringify({ total: 4, pending: 2, critical_open: 1, resolved: 2 }) &&
      JSON.stringify(metrics(rowFor(citizenRec.rows, B))) === JSON.stringify({ total: 3, pending: 2, critical_open: 1, resolved: 1 }) &&
      JSON.stringify(metrics(rowFor(citizenRec.rows, { state: null, district: null, constituency: null, area: null }))) === JSON.stringify({ total: 1, pending: 1, critical_open: 0, resolved: 0 }),
    JSON.stringify(citizenRec.rows.map((r) => [r.area, metrics(r)]))
  );
  const allFixtures = [...aIds, ...bIds, u1];
  record("F - fixture citizen reads exactly its own 8 reports", citizenRec.visibleIds.length === 8 && allFixtures.every((id) => citizenRec.visibleIds.includes(id)));
  const citizen1Rec = await reconcile("citizen1", citizen1.client);
  record("F - citizen1 sees none of another citizen's reports in analytics or directly", !allFixtures.some((id) => citizen1Rec.visibleIds.includes(id)) && sum(citizen1Rec.rows, "total_issues") === citizen1Rec.visibleIds.length, `citizen1 total=${sum(citizen1Rec.rows, "total_issues")}`);

  // ---- G. Department in-charge scope ---------------------------------------
  const inchargeRec = await reconcile("incharge1", incharge1.client);
  const newForIncharge = inchargeRec.visibleIds.filter((id) => !inchargeBefore.includes(id));
  record(
    "G - incharge1 gains exactly its two effective assignments (a1, a2) and nothing unassigned or out of scope",
    newForIncharge.length === 2 && newForIncharge.includes(a1) && newForIncharge.includes(a2),
    `new visible=${newForIncharge.length}`
  );
  record("G - incharge1's breakdown never exceeds the jurisdiction-wide view and has no B row", sum(inchargeRec.rows, "total_issues") <= sum(gov1Rec.rows, "total_issues") && !rowFor(inchargeRec.rows, B));

  // ---- E. Government user with no matching reports -------------------------
  const emptyRows = await breakdown(govEmpty.client);
  const { data: emptyOverview } = await govEmpty.client.rpc("get_area_overview").maybeSingle();
  const { count: emptyDirect } = await govEmpty.client.from("reports").select("*", { count: "exact", head: true });
  record("E - government user in an empty jurisdiction gets zero breakdown rows, zero overview, zero readable reports", emptyRows.length === 0 && Number(emptyOverview.total_issues) === 0 && emptyDirect === 0, `rows=${emptyRows.length} overview=${emptyOverview.total_issues} direct=${emptyDirect}`);

  // ---- H. Parameter tampering / jurisdiction manipulation -------------------
  const withParams = await gov2.client.rpc("get_area_breakdown", { p_state: A.state, p_district: A.district, p_area: A.area });
  record("H - get_area_breakdown rejects client-supplied jurisdiction parameters", !!withParams.error, withParams.error?.message ?? "call with params succeeded");
  const filtered = await gov2.client.rpc("get_area_breakdown").eq("area", A.area);
  record("H - gov2 filtering the RPC response to jurisdiction A returns nothing", !filtered.error && (filtered.data ?? []).length === 0, JSON.stringify(filtered.data));
  const orFilter = await gov2.client.rpc("get_area_breakdown").or(`area.eq.${A.area},area.eq.${B.area}`);
  record("H - an OR filter naming both jurisdictions still returns only gov2's own rows", !orFilter.error && (orFilter.data ?? []).every((r) => r.area === B.area), JSON.stringify((orFilter.data ?? []).map((r) => r.area)));
  const trendTamper = await gov2.client.rpc("get_category_trends", { p_days: 36500, p_state: A.state });
  record("H - extra jurisdiction parameter on an existing analytics RPC is rejected", !!trendTamper.error, trendTamper.error?.message ?? "accepted");
  // A throwaway government user tries to move its own jurisdiction to A.
  await govEmpty.client.from("profiles").update({ gov_state: A.state, gov_district: A.district, gov_constituency: A.constituency, gov_area: A.area, role: "admin" }).eq("id", govEmpty.userId);
  const { data: emptyAfter } = await admin.from("profiles").select("role, gov_state, gov_area").eq("id", govEmptyAuth.id).single();
  const emptyRowsAfter = await breakdown(govEmpty.client);
  record(
    "H - a government user cannot change its own jurisdiction/role to gain access (protect_profile_fields); breakdown stays empty",
    emptyAfter.role === "government" && emptyAfter.gov_state === EMPTY.state && emptyAfter.gov_area === EMPTY.area && emptyRowsAfter.length === 0,
    JSON.stringify(emptyAfter)
  );

  // ---- A (cont). Security invoker: same function, per-caller results ----------
  const service = await breakdown(admin);
  record(
    "A - security invoker: one function returns different, caller-scoped results (service role ≥ every caller; gov1 ≠ gov2)",
    sum(service, "total_issues") >= sum(gov1Rec.rows, "total_issues") + sum(gov2Rec.rows, "total_issues") &&
      JSON.stringify(gov1Rec.rows) !== JSON.stringify(gov2Rec.rows),
    `service=${sum(service, "total_issues")} gov1=${sum(gov1Rec.rows, "total_issues")} gov2=${sum(gov2Rec.rows, "total_issues")}`
  );
} catch (err) {
  record("script completed without error", false, err instanceof Error ? err.message : String(err));
} finally {
  // ---- I. Cleanup ---------------------------------------------------------
  // Cascades: report_locations, report_assignments, status_history, notifications(related_report_id).
  if (cleanupReports.length) await admin.from("reports").delete().in("id", cleanupReports);
  for (const id of cleanupUsers) await admin.auth.admin.deleteUser(id);

  if (baseline) {
    const final = await counts();
    const same = JSON.stringify(final) === JSON.stringify(baseline);
    record("I - baseline counts restored for every table", same, same ? "" : `baseline=${JSON.stringify(baseline)} after=${JSON.stringify(final)}`);
    const { count: leftover } = await admin.from("reports").select("*", { count: "exact", head: true }).ilike("title", "G8 Test:%");
    const { data: after } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const leftoverUsers = after.users.filter((u) => u.email?.startsWith("g8-")).length;
    const permanentKept = PERMANENT.every((e) => after.users.some((u) => u.email === e));
    record("I - no leftover G8 fixture reports or throwaway users; all five permanent accounts kept", leftover === 0 && leftoverUsers === 0 && permanentKept, `reports=${leftover} users=${leftoverUsers} permanentKept=${permanentKept}`);
    console.log("\nJ - Final counts:", JSON.stringify(final));
  }
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
