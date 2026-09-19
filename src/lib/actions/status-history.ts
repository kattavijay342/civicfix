import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Every status-changing code path calls this explicitly (see
 * supabase/migrations/0001_init_schema.sql for why there's no trigger). */
export async function logStatusChange(
  admin: SupabaseClient,
  reportId: string,
  oldStatus: string | null,
  newStatus: string,
  changedBy: string | null,
  notes: string | null = null
) {
  await admin.from("status_history").insert({
    report_id: reportId,
    old_status: oldStatus,
    new_status: newStatus,
    changed_by: changedBy,
    notes,
  });
}
