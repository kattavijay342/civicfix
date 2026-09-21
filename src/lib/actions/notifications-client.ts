"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/** Best-effort only, deliberately a separate statement from the `is_read`
 * update: `read_at` (migration 0011) may not exist yet in every
 * environment, and updating it in the SAME statement as `is_read` would
 * fail the whole update — silently breaking mark-as-read entirely (not
 * just the timestamp) until that migration is applied. Same defensive
 * pattern as the accuracy_meters fix in src/lib/actions/reports.ts. */
async function tryStampReadAt(admin: ReturnType<typeof createAdminClient>, filter: { column: string; value: string }) {
  const nowIso = new Date().toISOString();
  const { error } = await admin.from("notifications").update({ read_at: nowIso }).eq(filter.column, filter.value).is("read_at", null);
  if (error) console.error("Failed to stamp notification read_at (non-fatal)", error);
}

export async function markNotificationRead(notificationId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const admin = createAdminClient();
  const { error } = await admin
    .from("notifications")
    .update({ is_read: true })
    .eq("id", notificationId)
    .eq("recipient_id", user.id)
    .eq("is_read", false);

  if (!error) await tryStampReadAt(admin, { column: "id", value: notificationId });

  revalidatePath("/notifications");
}

/** Bulk mark-all-read. Naturally idempotent (updating already-read rows to
 * read again is a no-op filtered out by `.eq("is_read", false)`), so this
 * needs no idempotency-key machinery — unlike a create action, running it
 * twice in a row (double-click, retry) can never produce a different or
 * duplicated result. */
export async function markAllNotificationsRead() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const admin = createAdminClient();
  const { error } = await admin
    .from("notifications")
    .update({ is_read: true })
    .eq("recipient_id", user.id)
    .eq("is_read", false);

  if (!error) await tryStampReadAt(admin, { column: "recipient_id", value: user.id });

  revalidatePath("/notifications");
}
