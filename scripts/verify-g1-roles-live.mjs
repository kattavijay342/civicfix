// G1 Role & Access — live checks against the real Supabase project (real
// RLS, real triggers). Uses the seeded test accounts from
// scripts/seed-test-accounts.mjs; any throwaway users it creates are
// unconfirmed/unused and deleted before it exits. Sends NO email: the
// invitation check uses generateLink(), which creates the link without
// mailing it.
// Usage: node --env-file=.env.local scripts/verify-g1-roles-live.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const noPersist = { auth: { autoRefreshToken: false, persistSession: false } };
const admin = createClient(url, serviceKey, noPersist);
const PASSWORD = "CivicFixTest2026!";

const results = [];
function record(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} - ${name}${detail ? ` (${detail})` : ""}`);
}

const cleanup = [];
async function throwawayEmail(tag) {
  return `g1-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.civicfix.local`;
}

async function asUser(email) {
  const client = createClient(url, anonKey, noPersist);
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return { client, userId: data.user.id };
}

try {
  // ---------------------------------------------------------------
  // A. Sign-up can't choose a role (requires migration 0015)
  // ---------------------------------------------------------------
  for (const forged of ["admin", "government", "department_incharge"]) {
    const { data, error } = await admin.auth.admin.createUser({
      email: await throwawayEmail("forged"),
      email_confirm: false,
      user_metadata: { full_name: "G1 Probe", role: forged },
    });
    if (error) throw new Error(`probe createUser failed: ${error.message}`);
    cleanup.push(data.user.id);
    const { data: p } = await admin.from("profiles").select("role").eq("id", data.user.id).single();
    record(`A. sign-up metadata role="${forged}" still creates a citizen`, p?.role === "citizen", `profile role: ${p?.role}`);
  }

  // ---------------------------------------------------------------
  // B. Role detection source: each account's own profile row via RLS
  // ---------------------------------------------------------------
  const accounts = [
    ["citizen1@test.civicfix.local", "citizen"],
    ["gov1@test.civicfix.local", "government"],
    ["incharge1@test.civicfix.local", "department_incharge"],
  ];
  const sessions = {};
  for (const [email, expected] of accounts) {
    const s = await asUser(email);
    sessions[expected] = s;
    const { data: p } = await s.client.from("profiles").select("role").eq("id", s.userId).single();
    record(`B. ${email} reads its own stored role = ${expected}`, p?.role === expected, `got ${p?.role}`);
  }

  // ---------------------------------------------------------------
  // C. No client-side role/scope escalation
  // ---------------------------------------------------------------
  for (const [label, s, patch] of [
    ["citizen -> admin", sessions.citizen, { role: "admin" }],
    ["citizen -> government", sessions.citizen, { role: "government", gov_state: "Andhra Pradesh" }],
    ["government -> admin", sessions.government, { role: "admin" }],
    ["government widens jurisdiction", sessions.government, { gov_district: null, gov_constituency: null, gov_area: null }],
    ["in-charge -> admin", sessions.department_incharge, { role: "admin" }],
    ["in-charge changes department", sessions.department_incharge, { department_id: null }],
  ]) {
    const { data: before } = await admin.from("profiles").select("*").eq("id", s.userId).single();
    await s.client.from("profiles").update(patch).eq("id", s.userId);
    const { data: after } = await admin.from("profiles").select("*").eq("id", s.userId).single();
    const unchanged = Object.keys(patch).every((k) => after[k] === before[k]);
    record(`C. ${label} is blocked`, unchanged);
  }

  const { data: seenProfiles } = await sessions.citizen.client.from("profiles").select("id");
  record("C. citizen can read only its own profile", seenProfiles?.length === 1, `rows: ${seenProfiles?.length}`);

  const { error: insertErr } = await sessions.citizen.client
    .from("department_incharges")
    .insert({ profile_id: sessions.citizen.userId, department_id: (await admin.from("departments").select("id").limit(1).single()).data.id });
  record("C. citizen cannot insert itself as a department in-charge", !!insertErr);

  // ---------------------------------------------------------------
  // D. Jurisdiction / department scoping is enforced by RLS
  // ---------------------------------------------------------------
  const { data: govProfile } = await admin.from("profiles").select("*").eq("id", sessions.government.userId).single();
  const { data: govReports } = await sessions.government.client.from("reports").select("id, report_locations(state, district, constituency, area)");
  const outside = (govReports ?? []).filter((r) => {
    const l = Array.isArray(r.report_locations) ? r.report_locations[0] : r.report_locations;
    if (!l) return true;
    return (
      (govProfile.gov_state && l.state !== govProfile.gov_state) ||
      (govProfile.gov_district && l.district !== govProfile.gov_district) ||
      (govProfile.gov_constituency && l.constituency !== govProfile.gov_constituency) ||
      (govProfile.gov_area && l.area !== govProfile.gov_area)
    );
  });
  record("D. government sees only reports inside its jurisdiction", outside.length === 0, `${govReports?.length ?? 0} visible, ${outside.length} outside`);

  const { data: inchargeReports } = await sessions.department_incharge.client.from("reports").select("id");
  const { data: assigned } = await admin.from("report_assignments").select("report_id").eq("incharge_id", sessions.department_incharge.userId);
  const assignedIds = new Set((assigned ?? []).map((a) => a.report_id));
  const unassigned = (inchargeReports ?? []).filter((r) => !assignedIds.has(r.id));
  record("D. department in-charge sees only reports assigned to it", unassigned.length === 0, `${inchargeReports?.length ?? 0} visible, ${unassigned.length} unassigned`);

  const { data: citizenReports } = await sessions.citizen.client.from("reports").select("reporter_id");
  record(
    "D. citizen sees only its own reports",
    (citizenReports ?? []).every((r) => r.reporter_id === sessions.citizen.userId),
    `${citizenReports?.length ?? 0} visible`
  );

  // ---------------------------------------------------------------
  // E. Invitation mechanism (no email sent)
  // ---------------------------------------------------------------
  for (const origin of ["http://localhost:3000", "https://civicfix-sbte.vercel.app"]) {
    const redirectTo = `${origin}/auth/accept-invite`;
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
      type: "invite",
      email: await throwawayEmail("invite"),
      options: { redirectTo },
    });
    if (linkErr) throw new Error(`generateLink failed: ${linkErr.message}`);
    cleanup.push(link.user.id);

    const { data: invitedProfile } = await admin.from("profiles").select("role").eq("id", link.user.id).single();
    record(`E. invited user starts as citizen until an admin scopes it (${origin})`, invitedProfile?.role === "citizen");

    const res = await fetch(link.properties.action_link, { redirect: "manual" });
    const location = res.headers.get("location") ?? "";
    record(
      `E. Supabase honors redirect to ${redirectTo} (Redirect URLs allow-list)`,
      location.startsWith(redirectTo),
      location ? `redirected to ${location.split("#")[0]}` : `status ${res.status}`
    );

    const hash = new URLSearchParams(location.split("#")[1] ?? "");
    if (hash.get("access_token")) {
      const invitee = createClient(url, anonKey, noPersist);
      const { error: sessErr } = await invitee.auth.setSession({
        access_token: hash.get("access_token"),
        refresh_token: hash.get("refresh_token"),
      });
      const { error: pwErr } = sessErr ? { error: sessErr } : await invitee.auth.updateUser({ password: `${PASSWORD}-inv` });
      record(`E. invite link yields a session and the invitee sets their own password (${origin})`, !sessErr && !pwErr, sessErr?.message ?? pwErr?.message ?? "");
    }
  }
} catch (err) {
  record("script error", false, err.message);
} finally {
  for (const id of cleanup) await admin.auth.admin.deleteUser(id);
  console.log(`\ncleaned up ${cleanup.length} throwaway user(s)`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
