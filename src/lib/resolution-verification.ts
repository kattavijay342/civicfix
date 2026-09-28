import type { IssueStatus } from "@/lib/types";

/**
 * G7 — citizen verification of a department resolution.
 *
 * No new status: the existing lifecycle already carries every state.
 *   verified  = status RESOLVED + resolution_feedback.confirmed = true for
 *               the CURRENT resolution (feedback.updated_at >=
 *               resolution_evidence.resolved_at)
 *   rejected  = status REOPENED (the rejection reason lives in
 *               resolution_feedback.comment and status_history.notes)
 *   pending   = status RESOLVED + no feedback for the current resolution
 *
 * "Verified" is the reporting citizen's own confirmation — never an
 * official government verification.
 *
 * Pure so it can be unit-tested; the DB-facing side is
 * src/lib/actions/resolution-feedback.ts.
 */

export const REJECTION_REASON_MIN = 10;
export const REJECTION_REASON_MAX = 1000;

export type FeedbackAccessDenial = "signed_out" | "not_found" | "not_citizen" | "not_owner";

export const FEEDBACK_ACCESS_MESSAGES: Record<FeedbackAccessDenial, string> = {
  signed_out: "You must be signed in.",
  not_found: "Report not found.",
  not_citizen: "Only the citizen who reported this issue can verify its resolution.",
  not_owner: "Only the citizen who reported this issue can verify its resolution.",
};

/** Only the reporting citizen may verify or reject. Every input comes from
 * the server: the session user, their stored role, the stored reporter. */
export function evaluateFeedbackAccess(input: {
  userId: string | null;
  role: string | null;
  reporterId: string | null;
}): { ok: true } | { ok: false; reason: FeedbackAccessDenial } {
  if (!input.userId) return { ok: false, reason: "signed_out" };
  if (!input.reporterId) return { ok: false, reason: "not_found" };
  if (input.role !== "citizen") return { ok: false, reason: "not_citizen" };
  if (input.reporterId !== input.userId) return { ok: false, reason: "not_owner" };
  return { ok: true };
}

function instant(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Whether stored feedback was given for the CURRENT resolution (a fresh
 * reopen -> re-resolve cycle needs fresh feedback). With no evidence row at
 * all, any feedback counts as current. Shared with the report page and
 * mirrored by get_resolution_quality (migration 0013). */
export function isFeedbackForCurrentResolution(
  feedbackUpdatedAt: string | null | undefined,
  resolvedAt: string | null | undefined
): boolean {
  const feedback = instant(feedbackUpdatedAt);
  if (feedback === null) return false;
  const resolved = instant(resolvedAt);
  return resolved === null ? true : feedback >= resolved;
}

export type FeedbackInput = { confirmed: boolean; comment: string | null } | { error: string };

export function parseFeedbackInput(decisionRaw: unknown, commentRaw: unknown): FeedbackInput {
  const decision = String(decisionRaw ?? "");
  if (decision !== "yes" && decision !== "no") {
    return { error: "Please choose whether to verify or reject the resolution." };
  }
  const confirmed = decision === "yes";
  const comment = String(commentRaw ?? "").trim() || null;
  if (comment && comment.length > REJECTION_REASON_MAX) {
    return { error: `Comment is too long (${REJECTION_REASON_MAX} characters max).` };
  }
  if (!confirmed && (!comment || comment.length < REJECTION_REASON_MIN)) {
    return { error: `Please explain why the issue isn't resolved (at least ${REJECTION_REASON_MIN} characters).` };
  }
  return { confirmed, comment };
}

export const STALE_RESOLUTION_MESSAGE =
  "This resolution has changed since you opened the page. Refresh to see the latest resolution.";

export type FeedbackDecision =
  | { kind: "claim" }
  | { kind: "replay"; reopened: boolean }
  | { kind: "error"; message: string };

/**
 * Decides what a verify/reject submission may do against the report's
 * CURRENT stored state. `submittedResolvedAt` is the resolution the page
 * was showing — used only to detect a stale page, never to authorize.
 *
 *  - feedback already recorded for the current resolution: the same
 *    decision replays as success with no side effects (double click, two
 *    tabs); the opposite decision is refused (an old page can never
 *    overwrite a newer decision).
 *  - otherwise the report must still be RESOLVED and the page must be
 *    showing the current resolution; only then may the caller try to
 *    CLAIM the feedback row (the atomic step — see performSubmitFeedback).
 */
export function evaluateFeedbackDecision(input: {
  status: IssueStatus;
  resolvedAt: string | null;
  feedback: { confirmed: boolean; updatedAt: string } | null;
  submittedResolvedAt: string | null;
  confirmed: boolean;
}): FeedbackDecision {
  const { status, resolvedAt, feedback, submittedResolvedAt, confirmed } = input;

  if (feedback && isFeedbackForCurrentResolution(feedback.updatedAt, resolvedAt)) {
    if (feedback.confirmed === confirmed) return { kind: "replay", reopened: !confirmed };
    return {
      kind: "error",
      message: feedback.confirmed
        ? "You already verified this resolution."
        : "You already rejected this resolution — the issue has been reopened.",
    };
  }

  if (status !== "RESOLVED") {
    return { kind: "error", message: "A resolution can only be verified while the report is marked resolved." };
  }
  if (instant(submittedResolvedAt) !== instant(resolvedAt)) {
    return { kind: "error", message: STALE_RESOLUTION_MESSAGE };
  }
  return { kind: "claim" };
}
