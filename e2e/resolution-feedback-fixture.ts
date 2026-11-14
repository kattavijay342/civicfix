import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertLocalSupabase, requireLocalSupabaseEnv } from "./local-supabase-guard";

/**
 * Isolated fixture for e2e/resolution-feedback.spec.ts — never depends on
 * reports left over from earlier runs or on the seeded test accounts' data.
 *
 * Creates, all tagged with a run id and in a synthetic jurisdiction unique
 * to this run:
 *   - `citizen`: the reporter whose reports the spec views;
 *   - `otherCitizen`: a second citizen whose report is the target of a
 *     duplicate flag — its name/mobile/email must never leak into the
 *     citizen's duplicate card;
 *   - `government`: a government user scoped to the synthetic jurisdiction
 *     (so it can read the reports, but is never their reporter);
 *   - reports: `resolved` (with resolution evidence), `routed` (not yet
 *     resolved), `withDuplicate` (flagged as a duplicate of `otherReport`).
 *
 * cleanup() deletes the reports first (every dependent row — locations,
 * assignments, evidence, feedback, duplicate flags, notifications, history —
 * cascades), then the users (profiles cascade), then verifies that nothing
 * tagged with this run is left. It is safe to call after a partial setup.
 *
 * Local only: the guard rejects any Supabase URL other than the local CLI
 * stack (http://127.0.0.1:54321 / http://localhost:54321) or non-local keys.
 */

const PASSWORD = "CivicFixTest2026!";

type FixtureUser = { id: string; email: string; password: string; fullName: string; mobile: string };

export type ResolutionFeedbackFixture = {
  runId: string;
  citizen: FixtureUser;
  otherCitizen: FixtureUser;
  government: FixtureUser;
  reports: { resolved: string; routed: string; withDuplicate: string; otherReport: string };
  otherReportTitle: string;
  cleanup: () => Promise<void>;
};

export function localAdminClient(): SupabaseClient {
  const { url } = requireLocalSupabaseEnv();
  return createClient(assertLocalSupabase(url), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function createResolutionFeedbackFixture(): Promise<ResolutionFeedbackFixture> {
  const admin = localAdminClient();
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tag = `RF E2E ${runId}`;
  const jurisdiction = {
    state: `RF E2E State ${runId}`,
    district: "RF E2E District",
    constituency: "RF E2E Constituency",
    area: `RF E2E Area ${runId}`,
  };

  const userIds: string[] = [];
  const reportIds: string[] = [];

  const cleanup = async () => {
    const problems: string[] = [];
    if (reportIds.length) {
      const { error } = await admin.from("reports").delete().in("id", reportIds);
      if (error) problems.push(`delete reports: ${error.message}`);
    }
    for (const id of userIds) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) problems.push(`delete user: ${error.message}`);
    }
    const { count: leftReports } = await admin
      .from("reports")
      .select("id", { count: "exact", head: true })
      .ilike("title", `${tag}%`);
    const { count: leftProfiles } = await admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .in("id", userIds.length ? userIds : ["00000000-0000-0000-0000-000000000000"]);
    if (leftReports) problems.push(`${leftReports} report(s) tagged "${tag}" left`);
    if (leftProfiles) problems.push(`${leftProfiles} fixture profile(s) left`);
    if (problems.length) throw new Error(`Resolution-feedback fixture cleanup failed: ${problems.join("; ")}`);
  };

  const makeUser = async (
    key: string,
    role: "citizen" | "government",
    fullName: string,
    mobile: string
  ): Promise<FixtureUser> => {
    const email = `rf-e2e-${key}-${runId}@test.civicfix.local`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (error) throw error;
    userIds.push(data.user.id);
    const profile: Record<string, unknown> = { role, full_name: fullName, mobile_number: mobile };
    if (role === "government") {
      Object.assign(profile, {
        gov_state: jurisdiction.state,
        gov_district: jurisdiction.district,
        gov_constituency: jurisdiction.constituency,
        gov_area: jurisdiction.area,
      });
    }
    const { error: profileError } = await admin.from("profiles").update(profile).eq("id", data.user.id);
    if (profileError) throw profileError;
    return { id: data.user.id, email, password: PASSWORD, fullName, mobile };
  };

  const makeReport = async (key: string, reporterId: string, status: string): Promise<{ id: string; title: string }> => {
    const title = `${tag} ${key}`;
    const { data, error } = await admin
      .from("reports")
      .insert({
        reporter_id: reporterId,
        title,
        description: `${title}. Disposable resolution-feedback E2E fixture — deleted after the run.`,
        category: "road",
        status,
      })
      .select("id")
      .single();
    if (error) throw error;
    reportIds.push(data.id);
    const { error: locError } = await admin.from("report_locations").insert({
      report_id: data.id,
      display_name: `RF fixture spot ${key} ${runId}`,
      ...jurisdiction,
      location_source: "manual",
    });
    if (locError) throw locError;
    return { id: data.id, title };
  };

  try {
    const citizen = await makeUser("citizen", "citizen", "RF E2E Citizen", "+919876511101");
    const otherCitizen = await makeUser("other", "citizen", `RF E2E Other Citizen ${runId}`, "+919876511102");
    const government = await makeUser("gov", "government", "RF E2E Government", "+919876511103");

    const { data: dept, error: deptError } = await admin
      .from("departments")
      .select("id")
      .eq("name", "Roads & Infrastructure")
      .single();
    if (deptError) throw deptError;

    const resolved = await makeReport("resolved", citizen.id, "resolved");
    const routed = await makeReport("routed", citizen.id, "routed");
    const withDuplicate = await makeReport("with-duplicate", citizen.id, "routed");
    const otherReport = await makeReport("other-citizen-report", otherCitizen.id, "routed");

    for (const reportId of [resolved.id, routed.id, withDuplicate.id, otherReport.id]) {
      const { error } = await admin
        .from("report_assignments")
        .insert({ report_id: reportId, department_id: dept.id, incharge_id: null, assignment_method: "auto" });
      if (error) throw error;
    }

    const { error: evidenceError } = await admin.from("resolution_evidence").insert({
      report_id: resolved.id,
      resolution_notes: "Pothole filled and the road surface relaid (E2E fixture).",
      resolved_by: government.id,
      resolved_at: new Date().toISOString(),
    });
    if (evidenceError) throw evidenceError;

    const { error: flagError } = await admin.from("report_duplicate_flags").insert({
      report_id: withDuplicate.id,
      possible_duplicate_of: otherReport.id,
      similarity_score: 0.8,
      relation_type: "duplicate",
      reason: "Same category and nearby location (E2E fixture).",
    });
    if (flagError) throw flagError;

    return {
      runId,
      citizen,
      otherCitizen,
      government,
      reports: { resolved: resolved.id, routed: routed.id, withDuplicate: withDuplicate.id, otherReport: otherReport.id },
      otherReportTitle: otherReport.title,
      cleanup,
    };
  } catch (err) {
    // Never leave a half-built fixture behind.
    await cleanup().catch(() => {});
    throw err;
  }
}
