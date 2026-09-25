import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createNotification } from "./create";
import { findGovernmentUsersForJurisdiction } from "./targeting";
import type { NotificationPriority } from "./types";
import type { ReportJurisdiction } from "@/lib/report-jurisdiction";

export interface NewReportNotificationInput {
  reportId: string;
  title: string;
  /** DB category value (e.g. "road"). */
  category: string;
  /** Human label for the category (e.g. "Road Damage"). */
  categoryLabel: string;
  jurisdiction: ReportJurisdiction;
  /** DB priority value ("low" … "critical"); null when AI analysis
   * failed/was unavailable — never guessed. */
  priority: string | null;
}

/** High-priority reports surface as "high" in the Notification Center;
 * everything else stays "normal". Critical never reaches this function
 * (see notifyGovernmentOfNewReport). */
function notificationPriorityFor(priority: string | null): NotificationPriority {
  return priority === "high" ? "high" : "normal";
}

/** Pure message/payload builder — split out so the exact content (and the
 * absence of any citizen PII in it) is unit-testable. */
export function buildNewReportNotification(input: NewReportNotificationInput) {
  const { jurisdiction } = input;
  const place = `${jurisdiction.area}, ${jurisdiction.constituency}`;
  const priorityText = input.priority ? ` · ${input.priority} priority` : "";
  return {
    type: "report_created" as const,
    title: "New issue reported in your jurisdiction",
    body: `"${input.title}" — ${input.categoryLabel} in ${place}${priorityText}.`,
    relatedReportId: input.reportId,
    actionUrl: `/reports/${input.reportId}`,
    priority: notificationPriorityFor(input.priority),
    metadata: {
      event: "REPORT_CREATED",
      report_id: input.reportId,
      jurisdiction: {
        state: jurisdiction.state,
        district: jurisdiction.district,
        constituency: jurisdiction.constituency,
        area: jurisdiction.area,
      },
      priority: input.priority,
      category: input.category,
    },
  };
}

/**
 * Phase G2 — REPORT_CREATED for government users. Recipients are exactly
 * the government users whose configured jurisdiction covers this report
 * (findGovernmentUsersForJurisdiction — the same predicate as the RLS
 * function report_in_my_jurisdiction()), so nobody is told about a report
 * they couldn't open. Delivery is the existing in-app channel only.
 *
 * Critical reports are skipped here: notifyAiAnalysisComplete() in
 * src/lib/actions/reports.ts already sends those same users a
 * `critical_issue` alert for this report, and a second "new issue"
 * notification for the same event would just be noise.
 *
 * Best-effort, like every notification in this codebase: a failure here
 * never undoes or fails the report that was already created.
 */
export async function notifyGovernmentOfNewReport(
  admin: SupabaseClient,
  input: NewReportNotificationInput
): Promise<number> {
  if (input.priority === "critical") return 0;

  const recipients = await findGovernmentUsersForJurisdiction(admin, input.jurisdiction);
  if (recipients.length === 0) return 0;

  const message = buildNewReportNotification(input);
  const results = await Promise.all(
    recipients.map((recipientId) => createNotification(admin, { recipientId, ...message }))
  );
  return results.filter(Boolean).length;
}
