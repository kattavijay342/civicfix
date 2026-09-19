// One-off local dev helper: creates confirmed test accounts across all
// four roles for manual/E2E testing, and verifies DB connectivity.
// Usage: node --env-file=.env.local scripts/seed-test-accounts.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const TEST_PASSWORD = "CivicFixTest2026!";
const JURISDICTION = {
  state: "Andhra Pradesh",
  district: "Palnadu",
  constituency: "Narasaraopet",
  area: "Narasaraopet Municipality",
};

async function upsertConfirmedUser(email, fullName, mobile) {
  const { data: existing } = await admin.auth.admin.listUsers();
  const found = existing?.users.find((u) => u.email === email);
  if (found) {
    console.log(`- ${email} already exists (${found.id})`);
    return found.id;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: fullName, mobile_number: mobile, role: "citizen" },
  });
  if (error) throw new Error(`createUser(${email}) failed: ${error.message}`);
  console.log(`- created ${email} (${data.user.id})`);
  return data.user.id;
}

async function main() {
  console.log("1. Checking DB connection (departments table)...");
  const { data: departments, error: deptError } = await admin.from("departments").select("id, name").order("name");
  if (deptError) throw new Error(`departments query failed: ${deptError.message}`);
  console.log(`   OK — ${departments.length} departments:`, departments.map((d) => d.name).join(", "));

  const roadsDept = departments.find((d) => d.name === "Roads & Infrastructure");
  if (!roadsDept) throw new Error('Seed department "Roads & Infrastructure" not found — did seed.sql run?');

  console.log("\n2. Confirming the real account and promoting to admin...");
  const { data: allUsers } = await admin.auth.admin.listUsers();
  const realUser = allUsers?.users.find((u) => u.email === "siraj.vambara@cannitix.ai");
  if (realUser) {
    if (!realUser.email_confirmed_at) {
      await admin.auth.admin.updateUserById(realUser.id, { email_confirm: true });
      console.log("   confirmed siraj.vambara@cannitix.ai");
    }
    await admin.from("profiles").upsert(
      { id: realUser.id, role: "admin", full_name: "Siraj Vambara", mobile_number: "+919876543210" },
      { onConflict: "id" }
    );
    console.log("   set as admin");
  } else {
    console.log("   (no signup found for siraj.vambara@cannitix.ai — skipping)");
  }

  console.log("\n3. Creating test accounts...");
  const citizenId = await upsertConfirmedUser("citizen1@test.civicfix.local", "Test Citizen", "+919876500001");
  const govId = await upsertConfirmedUser("gov1@test.civicfix.local", "Test Government User", "+919876500002");
  const inchargeId = await upsertConfirmedUser("incharge1@test.civicfix.local", "Test Roads Incharge", "+919876500003");

  console.log("\n4. Assigning roles/jurisdiction...");
  await admin
    .from("profiles")
    .update({ role: "government", ...jurisdictionColumns(JURISDICTION) })
    .eq("id", govId);
  console.log("   gov1 -> government,", JSON.stringify(JURISDICTION));

  await admin
    .from("profiles")
    .update({ role: "department_incharge", department_id: roadsDept.id, ...jurisdictionColumns(JURISDICTION) })
    .eq("id", inchargeId);

  await admin.from("department_incharges").upsert(
    {
      department_id: roadsDept.id,
      profile_id: inchargeId,
      is_active: true,
      gov_state: JURISDICTION.state,
      gov_district: JURISDICTION.district,
      gov_constituency: JURISDICTION.constituency,
      gov_area: JURISDICTION.area,
    },
    { onConflict: "department_id,profile_id" }
  );
  console.log("   incharge1 -> department_incharge, Roads & Infrastructure,", JSON.stringify(JURISDICTION));

  console.log("\nDone. Test credentials (password for all: " + TEST_PASSWORD + "):");
  console.log("  citizen1@test.civicfix.local  (id " + citizenId + ")");
  console.log("  gov1@test.civicfix.local      (id " + govId + ")");
  console.log("  incharge1@test.civicfix.local (id " + inchargeId + ")");
}

function jurisdictionColumns(j) {
  return { gov_state: j.state, gov_district: j.district, gov_constituency: j.constituency, gov_area: j.area };
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
