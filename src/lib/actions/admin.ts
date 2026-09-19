"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UserRole } from "@/lib/types";

export interface AdminActionState {
  error?: string;
  success?: boolean;
}

async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." } as const;

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile || profile.role !== "admin") {
    return { error: "Admin access required." } as const;
  }
  return { user } as const;
}

export async function createDepartment(
  _prevState: AdminActionState,
  formData: FormData
): Promise<AdminActionState> {
  const auth = await requireAdmin();
  if ("error" in auth) return { error: auth.error };

  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  if (!name) return { error: "Department name is required." };

  const admin = createAdminClient();
  const { error } = await admin.from("departments").insert({ name, description });
  if (error) return { error: "Unable to save. Please try again." };

  revalidatePath("/admin");
  return { success: true };
}

/**
 * The single place a user's role/jurisdiction/department can change.
 * Public sign-up never sets anything but "citizen" (see
 * src/lib/actions/auth.ts) — this is how government, department-incharge,
 * and admin accounts actually get provisioned, and it always requires an
 * existing admin to act.
 */
export async function updateUserRole(
  profileId: string,
  _prevState: AdminActionState,
  formData: FormData
): Promise<AdminActionState> {
  const auth = await requireAdmin();
  if ("error" in auth) return { error: auth.error };

  const role = String(formData.get("role") ?? "") as UserRole;
  const departmentId = String(formData.get("departmentId") ?? "") || null;
  const govState = String(formData.get("govState") ?? "").trim() || null;
  const govDistrict = String(formData.get("govDistrict") ?? "").trim() || null;
  const govConstituency = String(formData.get("govConstituency") ?? "").trim() || null;
  const govArea = String(formData.get("govArea") ?? "").trim() || null;

  if (!["citizen", "government", "department_incharge", "admin"].includes(role)) {
    return { error: "Invalid role." };
  }
  if (role === "department_incharge" && !departmentId) {
    return { error: "Select a department for a department in-charge." };
  }

  const admin = createAdminClient();

  const { error } = await admin
    .from("profiles")
    .update({
      role,
      department_id: role === "department_incharge" ? departmentId : null,
      gov_state: role === "government" || role === "department_incharge" ? govState : null,
      gov_district: role === "government" || role === "department_incharge" ? govDistrict : null,
      gov_constituency: role === "government" || role === "department_incharge" ? govConstituency : null,
      gov_area: role === "government" || role === "department_incharge" ? govArea : null,
    })
    .eq("id", profileId);

  if (error) return { error: "Unable to save. Please try again." };

  // Keep the department_incharges routing table in sync: deactivate any
  // existing rows for this profile, then (re)activate one if applicable.
  await admin.from("department_incharges").update({ is_active: false }).eq("profile_id", profileId);

  if (role === "department_incharge" && departmentId) {
    const { data: existing } = await admin
      .from("department_incharges")
      .select("id")
      .eq("profile_id", profileId)
      .eq("department_id", departmentId)
      .maybeSingle();

    if (existing) {
      await admin
        .from("department_incharges")
        .update({
          is_active: true,
          gov_state: govState,
          gov_district: govDistrict,
          gov_constituency: govConstituency,
          gov_area: govArea,
        })
        .eq("id", existing.id);
    } else {
      await admin.from("department_incharges").insert({
        department_id: departmentId,
        profile_id: profileId,
        gov_state: govState,
        gov_district: govDistrict,
        gov_constituency: govConstituency,
        gov_area: govArea,
        is_active: true,
      });
    }
  }

  revalidatePath("/admin");
  return { success: true };
}
