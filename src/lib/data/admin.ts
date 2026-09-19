import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

export async function getAllDepartments() {
  const admin = createAdminClient();
  const { data } = await admin.from("departments").select("*").order("name");
  return data ?? [];
}

export async function getAllProfiles() {
  const admin = createAdminClient();
  const { data: profiles } = await admin.from("profiles").select("*").order("created_at", { ascending: false });
  const { data: users } = await admin.auth.admin.listUsers();
  const emailById = new Map(users?.users.map((u) => [u.id, u.email ?? ""]) ?? []);

  return (profiles ?? []).map((p) => ({ ...p, email: emailById.get(p.id) ?? "" }));
}
