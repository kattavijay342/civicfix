// Read-only snapshot: baseline counts, INC-0002/INC-0003 (+ linked reports),
// and any leftover E2E/live test fixtures. Usage:
//   node --env-file=.env.local <this> <out.json>
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const a = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const c = async (t) => (await a.from(t).select("*", { count: "exact", head: true })).count;
const { data: users } = await a.auth.admin.listUsers({ perPage: 1000 });

const counts = {
  reports: await c("reports"), profiles: await c("profiles"), auth_users: users.users.length,
  departments: await c("departments"), department_incharges: await c("department_incharges"),
  notifications: await c("notifications"), reminders: await c("reminders"), follow_ups: await c("follow_ups"),
  report_assignments: await c("report_assignments"), civic_incidents: await c("civic_incidents"), incident_reports: await c("incident_reports"),
};

const { data: incidents } = await a.from("civic_incidents").select("*").in("incident_code", ["INC-0002", "INC-0003"]).order("incident_code");
const incIds = (incidents ?? []).map((i) => i.id);
const { data: links } = await a.from("incident_reports").select("*").in("incident_id", incIds);
const reportIds = [...new Set((links ?? []).map((l) => l.report_id))];
const { data: linkedReports } = await a.from("reports").select("id, title, status, priority, updated_at").in("id", reportIds).order("id");

const fixturePattern = /^(G[1-6] (E2E|Test)|G[1-6] Test:|Phase|E2E|Security-audit)/i;
const { data: allReports } = await a.from("reports").select("id, title");
const leftoverReports = (allReports ?? []).filter((r) => /\bG[1-6]\b.*(E2E|Test)|E2E/i.test(r.title));
const leftoverUsers = users.users.filter((u) => /^g[1-6]-/i.test(u.email ?? "") || /-e2e-/i.test(u.email ?? ""));
const { data: rem } = await a.from("reminders").select("id, title, message");
const { data: notifs } = await a.from("notifications").select("id, title, body");
const { data: fus } = await a.from("follow_ups").select("id, notes");
const testText = (s) => /G[1-6] (E2E|Test)|disposable|RUN_ID|Stale inbox|Scheduled check-in/i.test(s ?? "");

const snap = {
  counts,
  incidents,
  incidentLinks: links,
  linkedReports,
  leftovers: {
    reports: leftoverReports.map((r) => r.title),
    users: leftoverUsers.map((u) => u.email),
    reminders: (rem ?? []).filter((r) => testText(r.title) || testText(r.message)).length,
    notifications: (notifs ?? []).filter((n) => testText(n.title) || testText(n.body)).length,
    follow_ups: (fus ?? []).filter((f) => testText(f.notes)).length,
  },
};
void fixturePattern;
writeFileSync(process.argv[2], JSON.stringify(snap, null, 2));
console.log(JSON.stringify({ counts: snap.counts, incidents: (incidents ?? []).map((i) => i.incident_code), linkedReports: (linkedReports ?? []).length, leftovers: snap.leftovers }));
