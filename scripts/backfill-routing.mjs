// One-off production routing backfill for reports that never got a
// report_assignments row (submitted while routing still waited for Gemini).
//
// DRY RUN BY DEFAULT. Nothing is written unless --apply is passed.
//
//   node scripts/backfill-routing.mjs --project-ref=<ref>            # dry run
//   node scripts/backfill-routing.mjs --project-ref=<ref> --apply    # writes
//
// Reuses the app's own routing code (src/lib/actions/routing.ts) through
// jiti, so department/in-charge selection, jurisdiction matching and the
// idempotent insert are exactly what createReport/retryAiAnalysis do:
//   - dry run: resolveAssignment() (reads only) + evaluateInchargeAccess()
//     to show whether the picked in-charge would actually see the report;
//   - --apply: routeReport() — INSERT-only on report_assignments (the
//     UNIQUE(report_id) constraint turns an existing row into
//     "already_routed", never an update), compare-and-set status
//     reported/ai_analyzed -> routed, a status_history row, and the usual
//     in-app report_assigned notification to the in-charge.
// Gemini is never called: no AI module is loaded and GEMINI_API_KEY is
// removed from the environment before anything else runs.
//
// Excluded (never routed): reports by @test.civicfix.local accounts (every
// seeded/E2E account — scripts/seed-test-accounts.mjs, e2e/*.spec.ts),
// reports whose area carries the E2E fixture marker ("E2E-" from
// e2e/*.spec.ts), reporters that aren't citizens, and any report whose
// reporter, location or jurisdiction can't be verified (fail closed).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { createClient } from "@supabase/supabase-js";

delete process.env.GEMINI_API_KEY;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TEST_EMAIL_DOMAIN = "@test.civicfix.local";
const E2E_AREA_PREFIX = "E2E-";
const ELIGIBLE_STATUSES = ["reported", "ai_analyzed"];

function fail(message) {
  console.error(`ABORT: ${message}`);
  process.exit(1);
}

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2);
const known = new Set(["--apply"]);
for (const a of args) if (!known.has(a) && !a.startsWith("--project-ref=")) fail(`unknown argument ${a}`);
const APPLY = args.includes("--apply");
const expectedRef = args.find((a) => a.startsWith("--project-ref="))?.slice("--project-ref=".length);
if (!expectedRef || !/^[a-z0-9]{20}$/.test(expectedRef)) {
  fail("--project-ref=<20-char hosted Supabase project ref> is required");
}

// ---- env: only the two Supabase values, from process env or .env.local ----
function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return out;
}
const fileEnv = readEnvFile(path.join(ROOT, ".env.local"));
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || fileEnv.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY;

// ---- project identity guard (fail closed) ---------------------------------
function projectIdentityProblem() {
  if (!SUPABASE_URL) return "NEXT_PUBLIC_SUPABASE_URL is not set";
  if (!SERVICE_KEY) return "SUPABASE_SERVICE_ROLE_KEY is not set";
  let url;
  try {
    url = new URL(SUPABASE_URL);
  } catch {
    return "NEXT_PUBLIC_SUPABASE_URL is not a valid URL";
  }
  if (url.protocol !== "https:" || url.hostname !== `${expectedRef}.supabase.co` || url.port || (url.pathname !== "/" && url.pathname !== "")) {
    return `NEXT_PUBLIC_SUPABASE_URL is not https://${expectedRef}.supabase.co`;
  }
  // New-style secret keys carry no project ref; they're validated against
  // the pinned host by the server probe below. A legacy JWT must name the
  // same project and the service_role.
  if (SERVICE_KEY.startsWith("sb_secret_")) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(SERVICE_KEY.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return "service role key is neither an sb_secret_ key nor a JWT — project identity can't be verified";
  }
  if (claims.ref !== expectedRef) return "service role key belongs to a different Supabase project";
  if (claims.role !== "service_role") return `service role key has role "${claims.role}"`;
  return null;
}
const identityProblem = projectIdentityProblem();
if (identityProblem) fail(identityProblem);

// ---- app modules (same code the server runs) -------------------------------
const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": path.join(ROOT, "src") + "/",
    // The react-server export of server-only — what Next itself resolves for
    // server code. These modules are server-side; this is a server process.
    "server-only": path.join(ROOT, "node_modules/server-only/empty.js"),
  },
});
const { resolveAssignment, routeReport, loadConfiguredDepartments } = await jiti.import(
  path.join(ROOT, "src/lib/actions/routing.ts")
);
const { evaluateInchargeAccess } = await jiti.import(path.join(ROOT, "src/lib/incharge-access.ts"));
const { resolveReportJurisdiction } = await jiti.import(path.join(ROOT, "src/lib/report-jurisdiction.ts"));
const { categoryFromDb } = await jiti.import(path.join(ROOT, "src/lib/db-enums.ts"));
const { categoryLabels } = await jiti.import(path.join(ROOT, "src/lib/categories.ts"));

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// Server-side identity probe: keys are project-scoped, so the pinned
// <ref>.supabase.co host accepting this key for a service-role-only call
// proves the key is that project's secret key. Any failure aborts.
{
  const { error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (error) fail(`project ${expectedRef} did not accept the service role key (${error.message})`);
}

async function must(promise, what) {
  const { data, error } = await promise;
  if (error) fail(`${what}: ${error.message}`);
  return data;
}

async function selectAll(table, columns, build = (q) => q) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const page = await must(build(admin.from(table).select(columns)).range(from, from + 999), `read ${table}`);
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

const short = (id) => (id ? id.slice(0, 8) : "-");

// ---- candidates ------------------------------------------------------------
console.log(`Mode: ${APPLY ? "APPLY (writes enabled)" : "DRY RUN (no writes)"} · project ${expectedRef}\n`);

const unrouted = await selectAll("reports", "id, title, category, status, reporter_id, created_at", (q) =>
  q.in("status", ELIGIBLE_STATUSES).order("created_at", { ascending: true })
);
const assigned = new Set((await selectAll("report_assignments", "report_id")).map((a) => a.report_id));
const candidates = unrouted.filter((r) => !assigned.has(r.id));

const reporterIds = [...new Set(candidates.map((r) => r.reporter_id).filter(Boolean))];
const reporterProfiles = new Map(
  reporterIds.length
    ? (await must(admin.from("profiles").select("id, role").in("id", reporterIds), "read profiles")).map((p) => [p.id, p])
    : []
);
const reporterEmails = new Map();
for (const id of reporterIds) {
  const { data, error } = await admin.auth.admin.getUserById(id);
  reporterEmails.set(id, error ? null : (data.user?.email ?? null));
}

const locations = new Map(
  candidates.length
    ? (
        await must(
          admin
            .from("report_locations")
            .select("report_id, state, district, constituency, area")
            .in("report_id", candidates.map((r) => r.id)),
          "read report_locations"
        )
      ).map((l) => [l.report_id, l])
    : []
);

const departments = await loadConfiguredDepartments(admin);
const deptName = new Map(departments.map((d) => [d.id, d.name]));

// ---- classify ----------------------------------------------------------------
const skipped = [];
const eligible = [];
for (const r of candidates) {
  const email = r.reporter_id ? reporterEmails.get(r.reporter_id) : null;
  const loc = locations.get(r.id);
  const skip = (reason) => skipped.push({ r, reason });

  if (!r.reporter_id || email === null || email === undefined) { skip("reporter_unverifiable"); continue; }
  if (email.toLowerCase().endsWith(TEST_EMAIL_DOMAIN)) { skip("test_account_reporter"); continue; }
  if (loc?.area?.startsWith(E2E_AREA_PREFIX)) { skip("e2e_fixture_area"); continue; }
  if (reporterProfiles.get(r.reporter_id)?.role !== "citizen") { skip("reporter_not_citizen"); continue; }
  if (!loc) { skip("no_location"); continue; }
  const canon = resolveReportJurisdiction(loc);
  if (!canon.ok || ["state", "district", "constituency", "area"].some((k) => canon.jurisdiction[k] !== loc[k])) {
    skip("jurisdiction_not_canonical"); continue;
  }
  const category = categoryFromDb[r.category];
  if (!category) { skip("unknown_category"); continue; }
  eligible.push({ r, loc, category });
}

// Dashboard-visibility check for the picked in-charge: the same pure rule
// getEffectiveAssignments()/RLS apply, fed with live profile + scope rows.
async function wouldBeVisible(inchargeId, departmentId, loc) {
  const [{ data: profile }, { data: rows }] = await Promise.all([
    admin.from("profiles").select("role, department_id").eq("id", inchargeId).maybeSingle(),
    admin
      .from("department_incharges")
      .select("department_id, is_active, gov_state, gov_district, gov_constituency, gov_area")
      .eq("profile_id", inchargeId),
  ]);
  return evaluateInchargeAccess({
    userId: inchargeId,
    profile: profile ?? null,
    assignment: { incharge_id: inchargeId, department_id: departmentId },
    inchargeRows: rows ?? [],
    location: loc,
  }).ok;
}

const results = [];
for (const { r, loc, category } of eligible) {
  const resolution = await resolveAssignment(admin, { category, departments }, loc);
  const row = {
    id: short(r.id),
    created: r.created_at.slice(0, 10),
    status: r.status,
    category: r.category,
    jurisdiction: [loc.state, loc.district, loc.constituency, loc.area].join(" / "),
    department: resolution.ok ? resolution.departmentName : null,
    incharge: resolution.ok ? short(resolution.inchargeId) : "-",
    visible: resolution.ok && resolution.inchargeId ? await wouldBeVisible(resolution.inchargeId, resolution.departmentId, loc) : false,
    outcome: !resolution.ok ? "no_department" : resolution.inchargeId ? "department+incharge" : "department_only",
    applied: null,
  };

  if (APPLY && resolution.ok) {
    try {
      const out = await routeReport(admin, {
        reportId: r.id,
        title: r.title,
        categoryLabel: categoryLabels[category],
        category,
        priority: null,
        location: loc,
        departments,
      });
      row.applied = out.outcome;
      if (out.outcome === "routed" && (out.departmentId !== resolution.departmentId || out.inchargeId !== resolution.inchargeId)) {
        row.applied = "routed (differs from preview)";
      }
    } catch (err) {
      row.applied = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  results.push(row);
}

// ---- report ------------------------------------------------------------------
const count = (pred) => results.filter(pred).length;
console.log("Eligible reports:");
for (const x of results) {
  console.log(
    `  ${x.id} ${x.created} ${x.status.padEnd(11)} ${x.category.padEnd(8)} ${x.jurisdiction}\n` +
      `           -> ${x.department ?? "NO DEPARTMENT"} · in-charge ${x.incharge}` +
      `${x.incharge !== "-" ? ` · visible on dashboard: ${x.visible ? "yes" : "NO"}` : ""}` +
      `${x.applied ? ` · applied: ${x.applied}` : ""}`
  );
}

const skipCounts = skipped.reduce((acc, s) => ((acc[s.reason] = (acc[s.reason] ?? 0) + 1), acc), {});
console.log("\nSkipped reports:");
for (const s of skipped) console.log(`  ${short(s.r.id)} ${s.r.created_at.slice(0, 10)} ${s.reason}`);

console.log("\nSummary");
console.log(`  unrouted (eligible status, no assignment): ${candidates.length}`);
console.log(`  eligible genuine citizen reports:          ${results.length}`);
console.log(`    department match:                        ${count((x) => x.department)}`);
console.log(`    matching in-charge:                      ${count((x) => x.outcome === "department+incharge")}`);
console.log(`      of which visible on in-charge dashboard: ${count((x) => x.visible)}`);
console.log(`    department but no in-charge:             ${count((x) => x.outcome === "department_only")}`);
console.log(`    no configured department:                ${count((x) => x.outcome === "no_department")}`);
console.log(`  skipped:                                   ${skipped.length} ${JSON.stringify(skipCounts)}`);
if (APPLY) {
  const applied = results.reduce((acc, x) => ((acc[x.applied ?? "not_attempted"] = (acc[x.applied ?? "not_attempted"] ?? 0) + 1), acc), {});
  console.log(`  apply outcomes:                            ${JSON.stringify(applied)}`);
} else {
  console.log("\nDry run — nothing was written. Re-run with --apply to route the eligible reports.");
}
console.log(`  departments configured: ${[...deptName.values()].join(", ")}`);
