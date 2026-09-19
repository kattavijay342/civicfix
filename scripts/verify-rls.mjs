// Verifies RLS enforcement directly against Postgres, bypassing the app UI:
// signs in as each test role with the anon key (so RLS actually applies,
// unlike the service-role client used elsewhere) and checks what `reports`
// each one can see.
// Usage: node --env-file=.env.local scripts/verify-rls.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

async function asUser(email, password) {
  const client = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return { client, userId: data.user.id };
}

const PASSWORD = "CivicFixTest2026!";

// Create a second citizen + a report OUTSIDE the Narasaraopet jurisdiction,
// so we have a real negative case to check gov1/incharge1 against.
const { data: outsiderExisting } = await admin.auth.admin.listUsers();
let outsider = outsiderExisting.users.find((u) => u.email === "citizen2@test.civicfix.local");
if (!outsider) {
  const { data } = await admin.auth.admin.createUser({
    email: "citizen2@test.civicfix.local",
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: "Test Citizen Two", mobile_number: "+919876500099", role: "citizen" },
  });
  outsider = data.user;
}

const { data: outsideReport } = await admin
  .from("reports")
  .insert({
    reporter_id: outsider.id,
    title: "Streetlight out on Ward 1 (Secunderabad)",
    description: "A streetlight has been out for a week on Ward 1 in Secunderabad, Telangana.",
    category: "streetlight",
    status: "reported",
  })
  .select("id")
  .single();
await admin.from("report_locations").insert({
  report_id: outsideReport.id,
  display_name: "Ward 1, Secunderabad",
  state: "Telangana",
  district: "Hyderabad",
  constituency: "Secunderabad",
  area: "Ward 1",
  location_source: "manual",
});
console.log("Created out-of-jurisdiction report:", outsideReport.id, "(Telangana / Hyderabad / Secunderabad)\n");

// --- Test 1: citizen1 must see only their own reports ---
const citizen1 = await asUser("citizen1@test.civicfix.local", PASSWORD);
const { data: c1Reports } = await citizen1.client.from("reports").select("id, reporter_id");
const c1OwnsAll = c1Reports.every((r) => r.reporter_id === citizen1.userId);
console.log(`Test 1 - citizen1 sees ${c1Reports.length} report(s), all own: ${c1OwnsAll ? "PASS" : "FAIL"}`);

// --- Test 2: citizen2 (outsider) must NOT see citizen1's reports ---
const citizen2 = await asUser("citizen2@test.civicfix.local", PASSWORD);
const { data: c2Reports } = await citizen2.client.from("reports").select("id, reporter_id");
const c2SeesOnlyOwn = c2Reports.every((r) => r.reporter_id === citizen2.userId);
console.log(`Test 2 - citizen2 sees ${c2Reports.length} report(s), none belong to citizen1: ${c2SeesOnlyOwn ? "PASS" : "FAIL"}`);

// --- Test 3: gov1 (jurisdiction: Andhra Pradesh/Palnadu) must NOT see the Telangana report ---
const gov1 = await asUser("gov1@test.civicfix.local", PASSWORD);
const { data: govReports } = await gov1.client.from("reports").select("id");
const govIds = new Set(govReports.map((r) => r.id));
console.log(
  `Test 3 - gov1 (Palnadu jurisdiction) sees ${govReports.length} report(s); out-of-jurisdiction report visible: ${govIds.has(outsideReport.id) ? "FAIL (leaked!)" : "PASS (correctly hidden)"}`
);

// --- Test 4: gov1 must NOT be able to directly fetch the out-of-jurisdiction report by id ---
const { data: directFetch } = await gov1.client.from("reports").select("id").eq("id", outsideReport.id).maybeSingle();
console.log(`Test 4 - gov1 direct fetch by id of out-of-jurisdiction report: ${directFetch ? "FAIL (leaked!)" : "PASS (blocked)"}`);

// --- Test 5: incharge1 must only see reports assigned to them ---
const incharge1 = await asUser("incharge1@test.civicfix.local", PASSWORD);
const { data: inchargeReports } = await incharge1.client.from("reports").select("id");
console.log(`Test 5 - incharge1 sees ${inchargeReports.length} report(s) (should equal their assignment count)`);

// --- Test 6: citizen1 must NOT be able to write to another user's profile role ---
const { error: escalationError } = await citizen1.client
  .from("profiles")
  .update({ role: "admin" })
  .eq("id", citizen1.userId);
const { data: profileAfter } = await citizen1.client.from("profiles").select("role").eq("id", citizen1.userId).single();
console.log(
  `Test 6 - citizen1 attempts self-promotion to admin: role is now "${profileAfter.role}" (${profileAfter.role === "citizen" ? "PASS (blocked by trigger)" : "FAIL"})`
);
if (escalationError) console.log("           (update itself errored:", escalationError.message, ")");

// cleanup
await admin.from("reports").delete().eq("id", outsideReport.id);
console.log("\nCleaned up test report.");
