import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createNotification } from "./create";
import type { NotificationPriority } from "./types";
import type { JurisdictionLike } from "@/lib/routing";

export interface ReportAssignedNotificationInput {
  reportId: string;
  inchargeId: string;
  title: string;
  categoryLabel: string;
  departmentName: string;
  /** DB priority ("low" … "critical") from the AI analysis that routed it. */
  priority: string | null;
  jurisdiction: JurisdictionLike;
}

function notificationPriorityFor(priority: string | null): NotificationPriority {
  if (priority === "critical") return "critical";
  if (priority === "high") return "high";
  return "normal";
}

/** Pure message/payload builder — only report/category/priority/place, never
 * the citizen's name or mobile number. */
export function buildReportAssignedNotification(input: ReportAssignedNotificationInput) {
  const { jurisdiction } = input;
  const place = [jurisdiction.area, jurisdiction.constituency].filter(Boolean).join(", ");
  const priorityText = input.priority ? ` · ${input.priority} priority` : "";
  return {
    type: "report_assigned" as const,
    title: "New issue assigned to your department",
    body: `"${input.title}" — ${input.categoryLabel}${place ? ` in ${place}` : ""}${priorityText}. Routed to ${input.departmentName}.`,
    relatedReportId: input.reportId,
    actionUrl: `/reports/${input.reportId}`,
    priority: notificationPriorityFor(input.priority),
    metadata: {
      event: "REPORT_ASSIGNED",
      report_id: input.reportId,
      department: input.departmentName,
      priority: input.priority,
      jurisdiction: {
        state: jurisdiction.state ?? null,
        district: jurisdiction.district ?? null,
        constituency: jurisdiction.constituency ?? null,
        area: jurisdiction.area ?? null,
      },
    },
  };
}

/**
 * In-app only (the one real delivery channel). Skips when this in-charge
 * already has a report_assigned notification for this report, so a retried
 * or re-run routing can never notify twice.
 */
export async function notifyInchargeOfAssignment(
  admin: SupabaseClient,
  input: ReportAssignedNotificationInput
): Promise<boolean> {
  const { data: existing } = await admin
    .from("notifications")
    .select("id")
    .eq("recipient_id", input.inchargeId)
    .eq("type", "report_assigned")
    .eq("related_report_id", input.reportId)
    .limit(1)
    .maybeSingle();
  if (existing) return false;

  const created = await createNotification(admin, {
    recipientId: input.inchargeId,
    ...buildReportAssignedNotification(input),
  });
  return created !== null;
}
