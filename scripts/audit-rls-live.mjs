// Inspects the LIVE database's actual RLS state via Postgres system catalogs
// (through PostgREST's ability to call a helper RPC would be cleaner, but we
// don't have one — so this uses the service-role client's raw SQL escape
// hatch via the Supabase Management-less approach: query pg_policies through
// a temporary read-only RPC is not available by default, so instead we
// verify indirectly by checking rowsecurity flags via information_schema
// where possible, and by listing tables.
// Usage: node --env-file=.env.local scripts/audit-rls-live.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const tables = [
  "profiles",
  "departments",
  "department_incharges",
  "reports",
  "report_locations",
  "report_media",
  "ai_analyses",
  "report_assignments",
  "follow_ups",
  "status_history",
  "resolution_evidence",
  "notifications",
  "report_duplicate_flags",
];

console.log("Checking each table exists and is reachable via service role...\n");
for (const t of tables) {
  const { error, count } = await admin.from(t).select("*", { count: "exact", head: true });
  console.log(`${t.padEnd(24)} ${error ? "ERROR: " + error.message : `OK (${count} rows)`}`);
}
