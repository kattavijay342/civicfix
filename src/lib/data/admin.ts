import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionProfile } from "@/lib/supabase/server";

export async function getAllDepartments() {
  const admin = createAdminClient();
  const { data } = await admin.from("departments").select("*").order("name");
  return data ?? [];
}

/**
 * Returns every profile with its email — full name, mobile number, role,
 * jurisdiction, and email for every user in the system. Callers already
 * gate this behind an admin check (src/app/admin/page.tsx), but this
 * function re-asserts it directly since it reads through the RLS-bypassing
 * admin client: a future caller that forgets the page-level gate must not
 * silently leak the entire user table.
 */
export async function getAllProfiles() {
  const session = await getSessionProfile();
  if (!session || session.profile.role !== "admin") {
    throw new Error("Admin access required.");
  }

  const admin = createAdminClient();
  const { data: profiles } = await admin
    .from("profiles")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);

  // listUsers() pages at 50/page by default — loop until exhausted so
  // accounts don't silently lose their email once there are more than 50.
  const emailById = new Map<string, string>();
  const perPage = 200;
  for (let page = 1; ; page++) {
    const { data: users } = await admin.auth.admin.listUsers({ page, perPage });
    if (!users || users.users.length === 0) break;
    for (const u of users.users) emailById.set(u.id, u.email ?? "");
    if (users.users.length < perPage) break;
  }

  return (profiles ?? []).map((p) => ({ ...p, email: emailById.get(p.id) ?? "" }));
}
