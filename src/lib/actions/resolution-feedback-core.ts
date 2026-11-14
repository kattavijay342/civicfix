import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";
import { createNotification } from "@/lib/notifications/create";
import { findGovernmentUsersForJurisdiction } from "@/lib/notifications/targeting";
import { logStatusChange } from "@/lib/actions/status-history";
import { checkInchargeAccess } from "@/lib/data/incharge-access";
import { statusFromDb } from "@/lib/db-enums";
import { evaluateFeedbackDecision, type FeedbackDecision } from "@/lib/resolution-verification";

/**
 * DB-facing core of the G7 citizen resolution decision. Lives in a
 * server-only module (NOT the "use server" action file) so it is never
 * exposed as a client-callable Server Action endpoint — every export of a
 * "use server" file is reachable from the browser, and this function trusts
 * its caller to have already authorized citizenId.
 */

export interface ResolutionFeedbackState {
  error?: string;
  success?: boolean;
  reopened?: boolean;
}

const SAVE_ERROR = "Unable to save your decision. Please try again.";
const CONCURRENT_MESSAGE = "This resolution was just updated. Refresh the page to see the latest status.";

type AdminClient = ReturnType<typeof createAdminClient>;

interface FeedbackRow {
  id: string;
  confirmed: boolean;
  updated_at: string;
}

async function loadDecisionState(admin: AdminClient, reportId: string) {
  const [{ data: evidence }, { data: feedback }] = await Promise.all([
    admin.from("resolution_evidence").select("resolved_at").eq("report_id", reportId).maybeSingle(),
    admin.from("resolution_feedback").select("id, confirmed, updated_at").eq("report_id", reportId).maybeSingle(),
  ]);
  return {
    resolvedAt: (evidence?.resolved_at as string | undefined) ?? null,
    feedback: (feedback as FeedbackRow | null) ?? null,
  };
}

function decide(
  status: string,
  state: Awaited<ReturnType<typeof loadDecisionState>>,
  confirmed: boolean,
  submittedResolvedAt: string | null
): FeedbackDecision {
  return evaluateFeedbackDecision({
    status: statusFromDb[status] ?? "REPORTED",
    resolvedAt: state.resolvedAt,
    feedback: state.feedback ? { confirmed: state.feedback.confirmed, updatedAt: state.feedback.updated_at } : null,
    submittedResolvedAt,
    confirmed,
  });
}

function decisionResult(decision: Exclude<FeedbackDecision, { kind: "claim" }>): ResolutionFeedbackState {
  return decision.kind === "replay" ? { success: true, reopened: decision.reopened } : { error: decision.message };
}

/**
 * Atomically claims the one resolution_feedback row (unique report_id) for
 * the current resolution. This row is the single serialization point for
 * every citizen decision:
 *   - no row yet: INSERT — Postgres's unique constraint lets exactly one
 *     concurrent insert succeed (23505 for the rest);
 *   - a row from an EARLIER resolution cycle: one conditional UPDATE whose
 *     WHERE requires the updated_at we read AND that it still predates the
 *     current resolution — a concurrent claim changes updated_at (trigger),
 *     so every other request matches zero rows.
 * Returns the claimed row's previous state (for rollback) or null if lost.
 */
async function claimFeedback(
  admin: AdminClient,
  reportId: string,
  citizenId: string,
  existing: FeedbackRow | null,
  resolvedAt: string | null,
  confirmed: boolean,
  comment: string | null
): Promise<{ claimed: true; insertedId: string | null } | { claimed: false; error?: string }> {
  if (!existing) {
    // updated_at stamped by the app clock — the same clock that stamps
    // resolution_evidence.resolved_at (department.ts), which it is compared to.
    const now = new Date().toISOString();
    const { data, error } = await admin
      .from("resolution_feedback")
      .insert({ report_id: reportId, citizen_id: citizenId, confirmed, comment, created_at: now, updated_at: now })
      .select("id")
      .maybeSingle();
    if (error) return error.code === "23505" ? { claimed: false } : { claimed: false, error: SAVE_ERROR };
    return { claimed: true, insertedId: (data?.id as string | undefined) ?? null };
  }

  let update = admin
    .from("resolution_feedback")
    .update({ confirmed, comment, citizen_id: citizenId, updated_at: new Date().toISOString() })
    .eq("id", existing.id)
    .eq("updated_at", existing.updated_at);
  if (resolvedAt) update = update.lt("updated_at", resolvedAt);
  const { data, error } = await update.select("id");
  if (error) return { claimed: false, error: SAVE_ERROR };
  return data && data.length > 0 ? { claimed: true, insertedId: null } : { claimed: false };
}

/** Recipients chosen entirely server-side: the stored in-charge only while
 * their assignment is still EFFECTIVE (G4 rule — a deactivated, moved or
 * re-scoped in-charge is skipped), plus every government user whose
 * jurisdiction covers the report. */
async function feedbackRecipients(admin: AdminClient, reportId: string) {
  const [{ data: assignment }, { data: location }] = await Promise.all([
    admin.from("report_assignments").select("incharge_id").eq("report_id", reportId).maybeSingle(),
    admin.from("report_locations").select("state, district, constituency, area").eq("report_id", reportId).maybeSingle(),
  ]);
  const inchargeId = (assignment?.incharge_id as string | null | undefined) ?? null;
  const effectiveIncharge =
    inchargeId && (await checkInchargeAccess(admin, inchargeId, reportId)).ok ? inchargeId : null;
  const governmentIds = location ? await findGovernmentUsersForJurisdiction(admin, location) : [];
  return {
    inchargeId: effectiveIncharge,
    governmentIds: [...new Set(governmentIds)].filter((id) => id !== effectiveIncharge),
  };
}

/** Exported so the DB-facing logic (decision, atomic claim, reopen,
 * history, notifications) can be unit-tested with the fake Supabase client
 * — see resolution-feedback.test.ts. Callers must already have authorized
 * `citizenId` as this report's reporting citizen. */
export async function performSubmitFeedback(
  admin: AdminClient,
  reportId: string,
  report: { title: string; reporter_id: string; status: string },
  citizenId: string,
  input: { confirmed: boolean; comment: string | null; submittedResolvedAt: string | null }
): Promise<ResolutionFeedbackState> {
  const { confirmed, comment, submittedResolvedAt } = input;

  const state = await loadDecisionState(admin, reportId);
  const decision = decide(report.status, state, confirmed, submittedResolvedAt);
  if (decision.kind !== "claim") return decisionResult(decision);

  const claim = await claimFeedback(admin, reportId, citizenId, state.feedback, state.resolvedAt, confirmed, comment);
  if (!claim.claimed) {
    if (claim.error) return { error: claim.error };
    // Lost the race: report what the winner decided (same decision
    // replays, the opposite one is refused) — never write anything.
    const { data: fresh } = await admin.from("reports").select("status").eq("id", reportId).maybeSingle();
    const after = decide(
      (fresh?.status as string | undefined) ?? report.status,
      await loadDecisionState(admin, reportId),
      confirmed,
      submittedResolvedAt
    );
    return after.kind === "claim" ? { error: CONCURRENT_MESSAGE } : decisionResult(after);
  }

  if (!confirmed) {
    // Only this request holds the claim; still compare-and-set on
    // "resolved" so nothing but a resolved report can ever be reopened.
    const { data: reopened, error: reopenError } = await admin
      .from("reports")
      .update({ status: "reopened", reopened_at: new Date().toISOString() })
      .eq("id", reportId)
      .eq("status", "resolved")
      .select("id");
    if (reopenError || !reopened || reopened.length === 0) {
      // Undo the claim. A claimed earlier-cycle row can't have its
      // updated_at restored (trigger), and would otherwise read as a
      // decision on this resolution — so it is removed; its content is
      // already preserved in that cycle's status_history notes.
      await admin.from("resolution_feedback").delete().eq("report_id", reportId);
      return { error: reopenError ? SAVE_ERROR : CONCURRENT_MESSAGE };
    }
  }

  await logStatusChange(
    admin,
    reportId,
    "resolved",
    confirmed ? "resolved" : "reopened",
    citizenId,
    confirmed
      ? `Resolution verified by citizen.${comment ? ` "${comment}"` : ""}`
      : `Citizen rejected the resolution: "${comment}"`
  );

  const recipients = await feedbackRecipients(admin, reportId);

  if (!confirmed) {
    if (recipients.inchargeId) {
      await createNotification(admin, {
        recipientId: recipients.inchargeId,
        type: "issue_reopened",
        title: "Resolution rejected — issue reopened",
        body: `The citizen rejected the resolution of "${report.title}", so it was reopened. "${comment}"`,
        relatedReportId: reportId,
      });
    }
    for (const govUserId of recipients.governmentIds) {
      await createNotification(admin, {
        recipientId: govUserId,
        type: "issue_reopened",
        title: "Resolution rejected — issue reopened",
        body: `The citizen rejected the resolution of "${report.title}" in your jurisdiction, so it was reopened.`,
        relatedReportId: reportId,
      });
    }
    return { success: true, reopened: true };
  }

  if (recipients.inchargeId) {
    await createNotification(admin, {
      recipientId: recipients.inchargeId,
      type: "resolution_feedback_recorded",
      title: "Resolution verified by citizen",
      body: `The citizen verified that "${report.title}" was resolved.`,
      relatedReportId: reportId,
    });
  }
  for (const govUserId of recipients.governmentIds) {
    await createNotification(admin, {
      recipientId: govUserId,
      type: "resolution_feedback_recorded",
      title: "Resolution verified by citizen",
      body: `The citizen verified that "${report.title}" in your jurisdiction was resolved.`,
      relatedReportId: reportId,
    });
  }
  return { success: true, reopened: false };
}
