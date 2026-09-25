"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, retryAfterMessage } from "@/lib/rate-limit";
import { getAuthRedirectOrigin } from "@/lib/auth-redirect";
import { PROVISIONABLE_ROLES } from "@/lib/role-routes";
import { buildRoleAssignment, readJurisdiction, type RoleAssignment } from "@/lib/role-assignment";
import { isValidReporterName } from "@/lib/validators";

export interface AdminActionState {
  error?: string;
  success?: boolean;
  /** Human-readable outcome for a successful action (e.g. who was invited). */
  message?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  const rateLimit = await checkRateLimit(`admin_action:${auth.user.id}`, 40, 60 * 60);
  if (!rateLimit.allowed) return { error: retryAfterMessage(rateLimit.retryAfterSeconds) };

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
 * Writes an already-validated role assignment (see buildRoleAssignment) to
 * the profile and keeps the department_incharges routing table in sync:
 * deactivate any existing rows for this profile, then (re)activate one if
 * applicable. Service-role only — callers must have run requireAdmin().
 */
async function applyRoleAssignment(
  admin: ReturnType<typeof createAdminClient>,
  profileId: string,
  a: RoleAssignment
): Promise<{ error?: string }> {
  // .select() so an update that matched no profile row (e.g. the
  // handle_new_user trigger didn't run) is a failure, not a silent no-op.
  const { data: updated, error } = await admin.from("profiles").update(a).eq("id", profileId).select("id");
  if (error || !updated?.length) return { error: "Unable to save. Please try again." };

  await admin.from("department_incharges").update({ is_active: false }).eq("profile_id", profileId);

  if (a.role === "department_incharge" && a.department_id) {
    const scope = {
      gov_state: a.gov_state,
      gov_district: a.gov_district,
      gov_constituency: a.gov_constituency,
      gov_area: a.gov_area,
    };
    const { data: existing } = await admin
      .from("department_incharges")
      .select("id")
      .eq("profile_id", profileId)
      .eq("department_id", a.department_id)
      .maybeSingle();

    const { error: inchargeError } = existing
      ? await admin.from("department_incharges").update({ is_active: true, ...scope }).eq("id", existing.id)
      : await admin.from("department_incharges").insert({
          department_id: a.department_id,
          profile_id: profileId,
          is_active: true,
          ...scope,
        });
    if (inchargeError) return { error: "Role saved, but department routing could not be updated. Please save again." };
  }
  return {};
}

/**
 * Changes an EXISTING user's role/jurisdiction/department (the Users &
 * Access list). Public sign-up never sets anything but "citizen" (see
 * src/lib/actions/auth.ts and migration 0015) — this and
 * provisionAuthorizedUser below are the only ways a privileged role is
 * ever assigned, and both require an existing admin to act.
 */
export async function updateUserRole(
  profileId: string,
  _prevState: AdminActionState,
  formData: FormData
): Promise<AdminActionState> {
  const auth = await requireAdmin();
  if ("error" in auth) return { error: auth.error };

  const rateLimit = await checkRateLimit(`admin_action:${auth.user.id}`, 40, 60 * 60);
  if (!rateLimit.allowed) return { error: retryAfterMessage(rateLimit.retryAfterSeconds) };

  // An admin demoting themselves could leave the project with no admin
  // and no way back in short of the service-role key.
  if (profileId === auth.user.id) return { error: "You can't change your own role." };

  const built = buildRoleAssignment(
    String(formData.get("role") ?? ""),
    String(formData.get("departmentId") ?? "").trim() || null,
    readJurisdiction(formData)
  );
  if ("error" in built) return { error: built.error };

  const result = await applyRoleAssignment(createAdminClient(), profileId, built.assignment);
  if (result.error) return { error: result.error };

  revalidatePath("/admin");
  return { success: true };
}

/**
 * "Create Authorized User": provisions a NEW Authorized Government User or
 * Department In-charge. Only those two roles — admin is never creatable
 * here. The admin never sets, sees or sends a password: Supabase emails the
 * person an invitation link (its own invite mechanism, same SMTP as
 * sign-up confirmation), and they choose their own password on
 * /auth/accept-invite. The new profile starts as 'citizen' via the
 * handle_new_user trigger and is only then scoped here; if that step
 * fails, the half-created invite is removed rather than left behind.
 */
export async function provisionAuthorizedUser(
  _prevState: AdminActionState,
  formData: FormData
): Promise<AdminActionState> {
  const auth = await requireAdmin();
  if ("error" in auth) return { error: auth.error };

  const rateLimit = await checkRateLimit(`admin_action:${auth.user.id}`, 40, 60 * 60);
  if (!rateLimit.allowed) return { error: retryAfterMessage(rateLimit.retryAfterSeconds) };

  const fullName = String(formData.get("fullName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "");
  const departmentId = String(formData.get("departmentId") ?? "").trim() || null;

  if (!(PROVISIONABLE_ROLES as readonly string[]).includes(role)) {
    return { error: "Choose Authorized Government User or Department In-charge." };
  }
  if (!isValidReporterName(fullName)) return { error: "Enter the person's full name (2-60 characters)." };
  if (!EMAIL_PATTERN.test(email) || email.length > 254) return { error: "Enter a valid email address." };

  const built = buildRoleAssignment(role, departmentId, readJurisdiction(formData));
  if ("error" in built) return { error: built.error };

  const admin = createAdminClient();

  if (built.assignment.department_id) {
    const { data: department } = await admin
      .from("departments")
      .select("id")
      .eq("id", built.assignment.department_id)
      .maybeSingle();
    if (!department) return { error: "Select a valid department." };
  }

  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
    redirectTo: `${getAuthRedirectOrigin()}/auth/accept-invite`,
  });

  if (inviteError || !invited?.user) {
    console.error("[provisionAuthorizedUser] invite failed", {
      code: inviteError?.code,
      status: inviteError?.status,
    });
    if (inviteError?.code === "email_exists" || /already been registered/i.test(inviteError?.message ?? "")) {
      return {
        error: "An account with this email already exists. Change its role from the Users & Access list instead.",
      };
    }
    if (inviteError?.code === "over_email_send_rate_limit") {
      return { error: "The email provider's sending limit was reached. Please wait and try again." };
    }
    return { error: "Unable to send the invitation. Please try again." };
  }

  const result = await applyRoleAssignment(admin, invited.user.id, built.assignment);
  if (result.error) {
    await admin.auth.admin.deleteUser(invited.user.id);
    return { error: "Unable to save this user's access, so the invitation was withdrawn. Please try again." };
  }

  revalidatePath("/admin");
  return {
    success: true,
    message: `Invitation sent to ${email}. They'll set their own password from the email link.`,
  };
}
