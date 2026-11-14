import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { TEST_CITIZEN } from "./fixtures";
import { assertLocalSupabase, requireLocalSupabaseEnv } from "./local-supabase-guard";

/**
 * Self-contained Government Dashboard fixture for specs that need a
 * jurisdiction WITH issues (the dashboard deliberately renders its analytics
 * sections — Issue Aging, Department Trend, Civic Incidents, Government Area
 * Map, … — only when the signed-in government user's jurisdiction has at
 * least one issue, and an honest empty state otherwise).
 *
 * Isolation: every call creates
 *   - a throwaway government user scoped to a synthetic jurisdiction that is
 *     unique to this call (so no other spec, seeded account or execution
 *     order can add to or remove from what this user sees), and
 *   - a small set of reports in that jurisdiction, owned by the seeded test
 *     citizen, with routed/acknowledged/resolved statuses, department
 *     assignments, and — optionally — valid GPS coordinates.
 * cleanup() deletes the reports (every dependent row cascades: locations,
 * assignments, status history, notifications, jobs) and the throwaway user,
 * then verifies nothing tagged with this run is left.
 *
 * Local only: the guard aborts for any Supabase URL other than the local CLI
 * stack (http://127.0.0.1:54321 / http://localhost:54321) or non-local keys.
 */

const PASSWORD = "CivicFixTest2026!";

/** Valid coordinates in Palnadu district, Andhra Pradesh (Narasaraopet area). */
const COORDINATES = [
  { latitude: 16.2354, longitude: 80.0479 },
  { latitude: 16.2401, longitude: 80.0532 },
  { latitude: 16.2298, longitude: 80.0411 },
];

export type GovernmentDashboardFixture = {
  email: string;
  password: string;
  tag: string;
  reportIds: string[];
  cleanup: () => Promise<void>;
};

function adminClient(): SupabaseClient {
  const { url } = requireLocalSupabaseEnv();
  return createClient(assertLocalSupabase(url), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function userIdByEmail(admin: SupabaseClient, email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  const user = data.users.find((u) => u.email === email);
  if (!user) throw new Error(`Seeded test user missing: ${email} (run global setup / seed-test-accounts first)`);
  return user.id;
}

export async function createGovernmentDashboardFixture(
  label: string,
  opts: { withCoordinates?: boolean } = {}
): Promise<GovernmentDashboardFixture> {
  const admin = adminClient();
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tag = `GOVDASH E2E ${label} ${runId}`;
  const jurisdiction = {
    state: `GovDash E2E State ${runId}`,
    district: "GovDash E2E District",
    constituency: "GovDash E2E Constituency",
    area: `GovDash E2E Area ${runId}`,
  };

  const reportIds: string[] = [];
  let govUserId: string | null = null;

  const cleanup = async () => {
    if (reportIds.length) {
      const { error } = await admin.from("reports").delete().in("id", reportIds);
      if (error) throw error;
    }
    if (govUserId) {
      const { error } = await admin.auth.admin.deleteUser(govUserId);
      if (error) throw error;
    }
    const { count, error } = await admin.from("reports").select("id", { count: "exact", head: true }).ilike("title", `${tag}%`);
    if (error) throw error;
    if (count !== 0) throw new Error(`Fixture cleanup left ${count} report(s) tagged "${tag}"`);
  };

  try {
    const email = `govdash-e2e-${runId}@test.civicfix.local`;
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (createError) throw createError;
    govUserId = created.user.id;

    const { error: profileError } = await admin
      .from("profiles")
      .update({
        role: "government",
        full_name: "GovDash E2E Government User",
        gov_state: jurisdiction.state,
        gov_district: jurisdiction.district,
        gov_constituency: jurisdiction.constituency,
        gov_area: jurisdiction.area,
      })
      .eq("id", govUserId);
    if (profileError) throw profileError;

    const reporterId = await userIdByEmail(admin, TEST_CITIZEN.email);
    const { data: departments, error: deptError } = await admin.from("departments").select("id, name");
    if (deptError) throw deptError;
    const deptId = (name: string) => {
      const dept = departments?.find((d) => d.name === name);
      if (!dept) throw new Error(`Department missing in local DB: ${name}`);
      return dept.id as string;
    };

    const seeds = [
      { key: "road-routed", category: "road", status: "routed", priority: "high", department: "Roads & Infrastructure" },
      { key: "garbage-acknowledged", category: "garbage", status: "acknowledged", priority: "critical", department: "Sanitation" },
      { key: "road-resolved", category: "road", status: "resolved", priority: "medium", department: "Roads & Infrastructure" },
    ] as const;

    for (const [i, seed] of seeds.entries()) {
      const title = `${tag} ${seed.key}`;
      const { data: report, error } = await admin
        .from("reports")
        .insert({
          reporter_id: reporterId,
          title,
          description: `${title}. Disposable Government Dashboard E2E fixture — deleted after the run.`,
          category: seed.category,
          status: seed.status,
          priority: seed.priority,
          severity: seed.priority,
        })
        .select("id")
        .single();
      if (error) throw error;
      reportIds.push(report.id);

      const coords = opts.withCoordinates ? COORDINATES[i % COORDINATES.length] : null;
      const { error: locError } = await admin.from("report_locations").insert({
        report_id: report.id,
        display_name: `GovDash fixture spot ${i + 1} ${runId}`,
        ...jurisdiction,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
        location_source: coords ? "gps" : "manual",
      });
      if (locError) throw locError;

      const { error: assignError } = await admin.from("report_assignments").insert({
        report_id: report.id,
        department_id: deptId(seed.department),
        incharge_id: null,
        assignment_method: "auto",
      });
      if (assignError) throw assignError;
    }

    return { email, password: PASSWORD, tag, reportIds, cleanup };
  } catch (err) {
    // Never leave a half-built fixture behind.
    await cleanup().catch(() => {});
    throw err;
  }
}
