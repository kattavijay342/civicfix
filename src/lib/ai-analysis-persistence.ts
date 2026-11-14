import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { analyzeReport } from "@/lib/ai";
import { createNotification, createNotificationDetailed } from "@/lib/notifications/create";
import { findGovernmentUsersForJurisdiction } from "@/lib/notifications/targeting";
import type { CivicLocation } from "@/lib/types";

/**
 * Saving a completed Gemini analysis and its notifications — shared by the
 * owner's manual retry (retryAiAnalysis in src/lib/actions/reports.ts) and
 * the AI job worker (processAiJob in src/lib/ai-jobs.ts), so the two can
 * never drift apart. Lives outside the "use server" actions module on
 * purpose: nothing here may be callable as a Server Action.
 */

export type AnalysisResult = Awaited<ReturnType<typeof analyzeReport>>;

/** Postgres unique-violation code (ai_analyses.report_id is UNIQUE). */
const UNIQUE_VIOLATION = "23505";

/** Shared shape for the `ai_analyses` insert — keeps the flat legacy
 * columns and the Phase 6A `extended` JSONB blob (subcategory, split
 * severity/priority reasoning, evidence, action steps, complaint draft) in
 * exactly one place. */
export function buildAiAnalysesRow(reportId: string, analysis: AnalysisResult) {
  return {
    report_id: reportId,
    problem_summary: analysis.problem_summary,
    category: analysis.category,
    severity: analysis.severity,
    priority: analysis.priority,
    reasoning: analysis.reasoning,
    recommended_department: analysis.recommended_department,
    recommended_action: analysis.recommended_action,
    confidence: analysis.confidence,
    model: analysis.model,
    extended: {
      subcategory: analysis.subcategory,
      severity_reasoning: analysis.severity_reasoning,
      priority_reasoning: analysis.priority_reasoning,
      action_steps: analysis.action_steps,
      affected_infrastructure: analysis.affected_infrastructure,
      urgency_factors: analysis.urgency_factors,
      safety_risk: analysis.safety_risk,
      affected_population: analysis.affected_population,
      time_context: analysis.time_context,
      location_context: analysis.location_context,
      evidence: analysis.evidence,
      complaint_subject: analysis.complaint_subject,
      complaint_impact: analysis.complaint_impact,
      complaint_action: analysis.complaint_action,
    },
  };
}

/**
 * Persists a completed analysis as pure enrichment: inserts the
 * ai_analyses row, then copies severity/priority onto the report. It never
 * touches the lifecycle status, the reporter or the department assignment
 * — routing happens independently, and AI must not move a report forwards
 * or backwards. Nothing else (notifications) may run unless this returns
 * "persisted":
 *   - insert fails                  -> "failed"   (no analysis, retryable)
 *   - insert hits UNIQUE(report_id) -> "already"  (another request persisted it first)
 *   - severity/priority update fails -> the just-inserted analysis row is
 *     deleted again, so the report stays retryable -> "failed"
 */
export async function persistAnalysis(
  admin: SupabaseClient,
  reportId: string,
  analysis: AnalysisResult
): Promise<"persisted" | "already" | "failed"> {
  const { error: insertError } = await admin.from("ai_analyses").insert(buildAiAnalysesRow(reportId, analysis));
  if (insertError) {
    if (insertError.code === UNIQUE_VIOLATION) return "already";
    console.error("ai_analyses insert failed; report stays retryable", reportId, insertError.code ?? "");
    return "failed";
  }

  const { data: updated, error: statusError } = await admin
    .from("reports")
    .update({ severity: analysis.severity, priority: analysis.priority })
    .eq("id", reportId)
    .select("id");
  if (statusError || !updated || updated.length === 0) {
    console.error("Severity/priority update after AI analysis failed; reverting the analysis row", reportId, statusError?.code ?? "");
    const { error: revertError } = await admin.from("ai_analyses").delete().eq("report_id", reportId);
    if (revertError) console.error("Reverting the analysis row failed", reportId, revertError.code ?? "");
    return "failed";
  }
  return "persisted";
}

/** The two AI-analysis notifications, built in ONE place so the direct
 * path (notifyAiAnalysisComplete) and the recovery path
 * (ensureAiAnalysisNotifications) can never drift apart. */
function reporterNotification(reportId: string, reporterId: string, title: string, priority: string) {
  return {
    recipientId: reporterId,
    type: "ai_analysis_completed" as const,
    title: "AI analysis complete",
    body: `"${title}" has been analyzed and classified as ${priority} priority.`,
    relatedReportId: reportId,
  };
}

function criticalNotification(reportId: string, recipientId: string, title: string, problemSummary: string) {
  return {
    recipientId,
    type: "critical_issue" as const,
    title: "Critical issue reported in your jurisdiction",
    body: `"${title}" — ${problemSummary}`,
    relatedReportId: reportId,
  };
}

/** Notifies the reporter that AI analysis finished, and — only when the AI
 * genuinely determined CRITICAL priority — alerts every government user
 * whose configured jurisdiction covers this report's location. Used by the
 * owner's manual retry, which alone persisted the analysis. */
export async function notifyAiAnalysisComplete(
  admin: SupabaseClient,
  input: {
    reportId: string;
    reporterId: string;
    title: string;
    analysis: AnalysisResult;
    location: CivicLocation;
  }
) {
  await createNotification(admin, reporterNotification(input.reportId, input.reporterId, input.title, input.analysis.priority));

  if (input.analysis.priority === "critical") {
    const govUserIds = await findGovernmentUsersForJurisdiction(admin, input.location);
    for (const recipientId of govUserIds) {
      await createNotification(admin, criticalNotification(input.reportId, recipientId, input.title, input.analysis.problem_summary));
    }
  }
}

async function notificationExists(admin: SupabaseClient, recipientId: string, type: string, reportId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("notifications")
    .select("id")
    .eq("recipient_id", recipientId)
    .eq("type", type)
    .eq("related_report_id", reportId)
    .limit(1);
  if (error) throw new Error(`notification lookup failed (${error.code ?? "unknown"})`);
  return Array.isArray(data) && data.length > 0;
}

export type EnsureNotificationsResult =
  | { sent: number; alreadyPresent: number; optedOut: number }
  | { skipped: "no_analysis" | "report_missing" };

/** Thrown when at least one required AI-analysis notification could not be
 * written/verified. The caller must NOT set ai_analysis_jobs.notified_at, so
 * the next pass retries delivery (without calling Gemini). */
export class NotificationDeliveryError extends Error {
  constructor(readonly missing: number) {
    super(`${missing} AI-analysis notification(s) could not be delivered`);
    this.name = "NotificationDeliveryError";
  }
}

/**
 * AI-2 Option A — idempotent-by-check delivery of the AI-analysis
 * notifications for a report whose analysis IS saved: for each required
 * notification (reporter `ai_analysis_completed`; plus `critical_issue`
 * for each jurisdiction government user when priority is critical), send it
 * only if that (recipient, type, report) notification does not exist yet.
 * Types, titles and bodies are identical to notifyAiAnalysisComplete.
 *
 * Delivery is VERIFIED (M1): a recipient counts as handled only when the
 * notification exists afterwards, or when that recipient opted out of the
 * category (createNotificationDetailed's `skipped_preference` — not an
 * error, never retried). Any insert failure, or a written notification that
 * cannot be found on re-read, throws NotificationDeliveryError; a failed
 * lookup throws too. The caller then leaves notified_at NULL and retries
 * later without calling Gemini again.
 *
 * Used by the AI job worker after it saves an analysis, and to recover after
 * a crash between saving and notifying.
 *
 * Remaining race (documented, accepted for Option A — no unique index): two
 * senders running this check for the same report at the same instant (e.g.
 * the owner's manual retry notifying while a worker's recovery check runs)
 * can both see "missing" and both insert. Leases make this very unlikely.
 */
export async function ensureAiAnalysisNotifications(admin: SupabaseClient, reportId: string): Promise<EnsureNotificationsResult> {
  const [{ data: analysis }, { data: report }, { data: location }] = await Promise.all([
    admin.from("ai_analyses").select("priority, problem_summary").eq("report_id", reportId).maybeSingle(),
    admin.from("reports").select("reporter_id, title").eq("id", reportId).maybeSingle(),
    admin
      .from("report_locations")
      .select("display_name, state, district, constituency, area, landmark, latitude, longitude, location_source")
      .eq("report_id", reportId)
      .maybeSingle(),
  ]);
  if (!analysis) return { skipped: "no_analysis" };
  if (!report) return { skipped: "report_missing" };

  const title = report.title as string;
  const priority = analysis.priority as string;
  const required: Array<{ recipientId: string; type: "ai_analysis_completed" | "critical_issue"; build: () => Parameters<typeof createNotificationDetailed>[1] }> = [];

  const reporterId = report.reporter_id as string;
  required.push({ recipientId: reporterId, type: "ai_analysis_completed", build: () => reporterNotification(reportId, reporterId, title, priority) });

  if (priority === "critical" && location) {
    const civicLocation: CivicLocation = {
      displayName: location.display_name,
      state: location.state,
      district: location.district,
      constituency: location.constituency,
      area: location.area,
      landmark: location.landmark,
      latitude: location.latitude,
      longitude: location.longitude,
      source: location.location_source,
    };
    for (const recipientId of await findGovernmentUsersForJurisdiction(admin, civicLocation)) {
      required.push({
        recipientId,
        type: "critical_issue",
        build: () => criticalNotification(reportId, recipientId, title, analysis.problem_summary as string),
      });
    }
  }

  let sent = 0;
  let alreadyPresent = 0;
  let optedOut = 0;
  let missing = 0;
  for (const item of required) {
    if (await notificationExists(admin, item.recipientId, item.type, reportId)) {
      alreadyPresent += 1;
      continue;
    }
    const result = await createNotificationDetailed(admin, item.build());
    if (result.status === "skipped_preference") {
      optedOut += 1;
      continue;
    }
    // Verify persistence: a "created" result must be readable back; a
    // failed insert is never counted as delivered.
    if (result.status === "created" && (await notificationExists(admin, item.recipientId, item.type, reportId))) {
      sent += 1;
    } else {
      missing += 1;
    }
  }
  if (missing > 0) throw new NotificationDeliveryError(missing);
  return { sent, alreadyPresent, optedOut };
}
