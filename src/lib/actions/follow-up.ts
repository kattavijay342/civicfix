"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export interface FollowUpFormState {
  error?: string;
  success?: boolean;
}

/** Government users monitor and record follow-ups. They never reassign a
 * report — department/in-charge routing is fixed by resolveAssignment(). */
export async function addFollowUp(
  reportId: string,
  _prevState: FollowUpFormState,
  formData: FormData
): Promise<FollowUpFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile || (profile.role !== "government" && profile.role !== "admin")) {
    return { error: "Only government users can record follow-ups." };
  }

  // RLS-gated visibility check: report_in_my_jurisdiction / admin.
  const { data: report } = await supabase.from("reports").select("id").eq("id", reportId).maybeSingle();
  if (!report) return { error: "Report not found." };

  const notes = String(formData.get("notes") ?? "").trim();
  const nextFollowUpDate = String(formData.get("nextFollowUpDate") ?? "").trim() || null;

  if (!notes || notes.length < 3) {
    return { error: "Add a short note for this follow-up." };
  }
  if (notes.length > 1000) {
    return { error: "Note is too long (1000 characters max)." };
  }

  const admin = createAdminClient();
  const { error } = await admin.from("follow_ups").insert({
    report_id: reportId,
    government_user_id: user.id,
    notes,
    next_follow_up_date: nextFollowUpDate,
  });

  if (error) {
    return { error: "Unable to save the follow-up. Please try again." };
  }

  revalidatePath(`/reports/${reportId}`);
  return { success: true };
}
