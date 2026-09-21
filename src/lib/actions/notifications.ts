import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createNotification } from "@/lib/notifications/create";

export async function notifyNewAssignment(
  admin: SupabaseClient,
  reportId: string,
  inchargeId: string | null,
  reportTitle: string
) {
  if (!inchargeId) return;
  await createNotification(admin, {
    recipientId: inchargeId,
    type: "report_assigned",
    title: "New issue assigned to you",
    body: `"${reportTitle}" was routed to you.`,
    relatedReportId: reportId,
  });
}

const STATUS_CHANGE_LABEL: Record<string, string> = {
  acknowledged: "acknowledged",
  in_progress: "marked in progress",
};

/** Notifies the reporter when the department in-charge acknowledges or
 * starts work on their report (Phase 4 Step 5 — "department
 * acknowledgement" / "status changed" events). Resolution has its own,
 * more detailed notification (see src/lib/actions/department.ts). */
export async function notifyStatusChanged(
  admin: SupabaseClient,
  reportId: string,
  reporterId: string,
  reportTitle: string,
  dbStatus: string
) {
  const label = STATUS_CHANGE_LABEL[dbStatus];
  if (!label) return;
  await createNotification(admin, {
    recipientId: reporterId,
    type: "status_changed",
    title: "Your report status was updated",
    body: `"${reportTitle}" was ${label} by the assigned department.`,
    relatedReportId: reportId,
  });
}
