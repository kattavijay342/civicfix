import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Scoped by RLS (notifications_select: recipient_id = auth.uid()) — the
 * caller's own client is enough, no admin client needed. Covered by the
 * notifications_recipient_idx (recipient_id, is_read) index. */
export async function getUnreadNotificationCount(
  supabase: SupabaseClient,
  userId: string
): Promise<number> {
  const { count } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("recipient_id", userId)
    .eq("is_read", false);
  return count ?? 0;
}
