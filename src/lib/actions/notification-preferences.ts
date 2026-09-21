"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { NotificationCategory } from "@/lib/notifications/types";
import { CATEGORY_LABELS } from "@/lib/notifications/types";

export interface NotificationPreferencesFormState {
  error?: string;
  success?: boolean;
}

const ALL_CATEGORIES = Object.keys(CATEGORY_LABELS) as NotificationCategory[];

/** Self-update only — uses the caller's own session client, exactly like
 * updateOwnProfile (src/lib/actions/profile.ts). notification_preferences
 * isn't one of the fields the profiles_update_self trigger protects
 * (role/department_id/jurisdiction only), so a citizen can freely update
 * their own preferences without an admin/service-role client. */
export async function updateNotificationPreferences(
  _prevState: NotificationPreferencesFormState,
  formData: FormData
): Promise<NotificationPreferencesFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  // Checkboxes only submit when checked — an unchecked box means "off".
  const preferences: Record<NotificationCategory, boolean> = Object.fromEntries(
    ALL_CATEGORIES.map((category) => [category, formData.get(category) === "on"])
  ) as Record<NotificationCategory, boolean>;

  const { error } = await supabase
    .from("profiles")
    .update({ notification_preferences: preferences })
    .eq("id", user.id);

  if (error) {
    return { error: "Unable to save your preferences. Please try again." };
  }

  revalidatePath("/dashboard/settings");
  return { success: true };
}
