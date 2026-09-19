"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isValidReporterName, isValidIndianMobile, formatIndianMobile } from "@/lib/validators";

export interface ProfileFormState {
  error?: string;
  success?: boolean;
}

export async function updateOwnProfile(
  _prevState: ProfileFormState,
  formData: FormData
): Promise<ProfileFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const fullName = String(formData.get("fullName") ?? "").trim();
  const mobile = String(formData.get("mobile") ?? "").trim();

  if (!isValidReporterName(fullName)) {
    return { error: "Enter your full name (2-60 characters)." };
  }
  if (!isValidIndianMobile(mobile)) {
    return { error: "Enter a valid 10-digit Indian mobile number." };
  }

  // Self-update — RLS (profiles_update_self) allows this; role/department/
  // jurisdiction fields are protected from client changes by a DB trigger.
  const { error } = await supabase
    .from("profiles")
    .update({ full_name: fullName, mobile_number: formatIndianMobile(mobile) })
    .eq("id", user.id);

  if (error) {
    return { error: "Unable to save your profile. Please try again." };
  }

  revalidatePath("/dashboard/settings");
  return { success: true };
}
