import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function notifyNewAssignment(
  admin: SupabaseClient,
  reportId: string,
  inchargeId: string | null,
  reportTitle: string
) {
  if (!inchargeId) return;
  await admin.from("notifications").insert({
    recipient_id: inchargeId,
    type: "report_assigned",
    title: "New issue assigned to you",
    body: `"${reportTitle}" was routed to you.`,
    related_report_id: reportId,
  });
}
