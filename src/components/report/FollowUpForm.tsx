"use client";

import { useActionState } from "react";
import { Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { addFollowUp, type FollowUpFormState } from "@/lib/actions/follow-up";

const initialState: FollowUpFormState = {};

const inputClasses =
  "w-full rounded-xl border border-border bg-white px-3.5 py-2.5 text-sm text-foreground outline-none transition focus:border-civic-400 focus:ring-2 focus:ring-civic-100";

export function FollowUpForm({ reportId }: { reportId: string }) {
  const action = addFollowUp.bind(null, reportId);
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-foreground-muted">Follow-up notes</span>
        <textarea name="notes" rows={2} required className={inputClasses} placeholder="e.g. Called the department, they confirmed a site visit." />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-foreground-muted">Next follow-up date (optional)</span>
        <input type="date" name="nextFollowUpDate" className={inputClasses} />
      </label>
      {state.error && (
        <p className="flex items-center gap-1.5 text-xs font-medium text-priority-critical">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {state.error}
        </p>
      )}
      {state.success && (
        <p className="flex items-center gap-1.5 text-xs font-medium text-civic-700">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Follow-up recorded.
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="inline-flex w-fit items-center gap-2 rounded-full bg-civic-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-civic-700 disabled:opacity-60"
      >
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
        Record follow-up
      </button>
    </form>
  );
}
