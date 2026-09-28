"use client";

import { useActionState, useState } from "react";
import { Loader2, AlertCircle, CheckCircle2, RotateCcw, XCircle } from "lucide-react";
import { submitResolutionFeedback, type ResolutionFeedbackState } from "@/lib/actions/resolution-feedback";
import { REJECTION_REASON_MAX, REJECTION_REASON_MIN } from "@/lib/resolution-verification";

const initialState: ResolutionFeedbackState = {};

const inputClasses =
  "w-full rounded-xl border border-border bg-white px-3.5 py-2.5 text-sm text-foreground outline-none transition focus:border-civic-400 focus:ring-2 focus:ring-civic-100";

const primaryButton =
  "inline-flex w-fit items-center gap-2 rounded-full bg-civic-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-civic-700 disabled:opacity-60";
const secondaryButton =
  "inline-flex w-fit items-center gap-2 rounded-full border border-border bg-white px-4 py-2 text-xs font-semibold text-foreground transition hover:bg-surface-muted disabled:opacity-60";

/** G7 — the reporting citizen verifies or rejects the department's
 * resolution. Rendered only for the report owner while the report is
 * RESOLVED and no decision exists for this resolution (see
 * src/app/reports/[id]/page.tsx); the server re-checks all of that.
 * `resolvedAt` identifies which resolution this page is showing, so a
 * stale page can't decide on a newer one. */
export function ResolutionFeedbackForm({ reportId, resolvedAt }: { reportId: string; resolvedAt: string | null }) {
  const action = submitResolutionFeedback.bind(null, reportId);
  const [state, formAction, pending] = useActionState(action, initialState);
  const [rejecting, setRejecting] = useState(false);
  // One key per mounted panel: a double click replays the first result
  // instead of submitting a second decision.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  if (state.success) {
    return (
      <div
        role="status"
        data-testid="resolution-verification-result"
        className="flex items-center gap-2 rounded-2xl border border-civic-200 bg-civic-50 p-6 text-sm font-medium text-civic-800"
      >
        {state.reopened ? (
          <>
            <RotateCcw className="h-4 w-4 shrink-0" aria-hidden="true" />
            You rejected this resolution. The issue has been reopened for the department.
          </>
        ) : (
          <>
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            You verified this resolution.
          </>
        )}
      </div>
    );
  }

  return (
    <form
      action={formAction}
      className="rounded-2xl border border-border bg-white p-6"
      data-testid="resolution-verification"
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="resolvedAt" value={resolvedAt ?? ""} />
      <input type="hidden" name="confirmed" value={rejecting ? "no" : "yes"} />
      <h2 className="text-sm font-semibold text-foreground">Was this issue actually resolved?</h2>
      <p className="mt-1 text-xs text-foreground-muted">
        Check the resolution notes and the after photo, then verify the fix or reject it.
      </p>

      {rejecting && (
        <label className="mt-3 flex flex-col gap-1.5">
          <span className="text-xs font-medium text-foreground-muted">Why isn&apos;t it resolved?</span>
          <textarea
            name="comment"
            rows={3}
            required
            minLength={REJECTION_REASON_MIN}
            maxLength={REJECTION_REASON_MAX}
            className={inputClasses}
            placeholder="e.g. The pothole was only partly filled and water still collects there."
          />
        </label>
      )}

      {state.error && (
        <p role="alert" className="mt-3 flex items-center gap-1.5 text-xs font-medium text-priority-critical">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {state.error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {rejecting ? (
          <>
            <button type="submit" disabled={pending} className={primaryButton}>
              {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Submit rejection
            </button>
            <button type="button" disabled={pending} className={secondaryButton} onClick={() => setRejecting(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="submit" disabled={pending} className={primaryButton}>
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Verify Resolution
            </button>
            <button type="button" disabled={pending} className={secondaryButton} onClick={() => setRejecting(true)}>
              <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
              Reject Resolution
            </button>
          </>
        )}
      </div>
    </form>
  );
}
