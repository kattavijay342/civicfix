"use client";

import { useActionState, useState } from "react";
import { Loader2, AlertCircle, CheckCircle2, RotateCcw } from "lucide-react";
import { submitResolutionFeedback, type ResolutionFeedbackState } from "@/lib/actions/resolution-feedback";

const initialState: ResolutionFeedbackState = {};

const inputClasses =
  "w-full rounded-xl border border-border bg-white px-3.5 py-2.5 text-sm text-foreground outline-none transition focus:border-civic-400 focus:ring-2 focus:ring-civic-100";

/** "Was this issue actually resolved?" — the original reporter's own
 * confirmation signal (Phase 6D §7). Rendered only for the report owner
 * when status is RESOLVED and no feedback exists yet for this resolution
 * cycle (see src/app/reports/[id]/page.tsx). */
export function ResolutionFeedbackForm({ reportId }: { reportId: string }) {
  const action = submitResolutionFeedback.bind(null, reportId);
  const [state, formAction, pending] = useActionState(action, initialState);

  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [handledState, setHandledState] = useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state.success) setIdempotencyKey(crypto.randomUUID());
  }

  if (state.success) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-2xl border border-civic-200 bg-civic-50 p-6 text-sm font-medium text-civic-800"
      >
        {state.reopened ? (
          <>
            <RotateCcw className="h-4 w-4 shrink-0" aria-hidden="true" />
            Your issue has been reopened.
          </>
        ) : (
          <>
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            Thanks. Your feedback was recorded.
          </>
        )}
      </div>
    );
  }

  return (
    <form action={formAction} className="rounded-2xl border border-border bg-white p-6">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <h2 className="text-sm font-semibold text-foreground">Was this issue actually resolved?</h2>
      <fieldset className="mt-3 flex flex-col gap-2">
        <legend className="sr-only">Was this issue actually resolved?</legend>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="radio" name="confirmed" value="yes" required className="h-4 w-4 accent-civic-600" />
          Yes, it was resolved
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="radio" name="confirmed" value="no" required className="h-4 w-4 accent-priority-critical" />
          No, it&apos;s still an issue
        </label>
      </fieldset>
      <label className="mt-3 flex flex-col gap-1.5">
        <span className="text-xs font-medium text-foreground-muted">Tell us what happened (optional)</span>
        <textarea name="comment" rows={2} className={inputClasses} placeholder="Optional details" maxLength={1000} />
      </label>
      {state.error && (
        <p role="alert" className="mt-3 flex items-center gap-1.5 text-xs font-medium text-priority-critical">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="mt-4 inline-flex w-fit items-center gap-2 rounded-full bg-civic-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-civic-700 disabled:opacity-60"
      >
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
        Submit feedback
      </button>
    </form>
  );
}
