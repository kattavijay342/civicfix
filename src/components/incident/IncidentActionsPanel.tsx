"use client";

import { useActionState } from "react";
import { Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { markIncidentInProgress, resolveIncident, type IncidentActionState } from "@/lib/actions/incidents";
import type { IssueStatus } from "@/lib/types";

const initialState: IncidentActionState = {};

/**
 * Department/government-only incident-level actions. Deliberately does NOT
 * touch any linked report's own status — see src/lib/actions/incidents.ts's
 * doc comments (spec §16: resolving the physical problem once is a
 * separate operational fact from each citizen report's own workflow).
 */
export function IncidentActionsPanel({ incidentId, status }: { incidentId: string; status: IssueStatus }) {
  const progressAction = markIncidentInProgress.bind(null, incidentId);
  const resolveAction = resolveIncident.bind(null, incidentId);
  const [progressState, progressFormAction, progressPending] = useActionState(progressAction, initialState);
  const [resolveState, resolveFormAction, resolvePending] = useActionState(resolveAction, initialState);

  if (status === "RESOLVED") {
    return (
      <div className="rounded-2xl border border-civic-200 bg-civic-50 p-6">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-civic-800">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          This incident is marked resolved.
        </p>
        <p className="mt-1 text-xs text-civic-700">
          Individual linked reports still go through their own resolution/citizen-confirmation workflow.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-white p-6">
      <h2 className="text-sm font-semibold text-foreground">Incident Actions</h2>
      <p className="mt-1 text-xs text-foreground-muted">
        Operates on the shared physical problem only — never changes any linked report&apos;s own status.
      </p>
      {status === "REOPENED" && (
        <p className="mt-3 rounded-xl border border-status-reopened/30 bg-status-reopened-bg px-3.5 py-2.5 text-xs text-status-reopened">
          A citizen reported that at least one linked issue isn&apos;t actually fixed — resolve the underlying
          reports first (via their own report pages), then mark this incident resolved again once verified.
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {status === "ROUTED" && (
          <form action={progressFormAction}>
            <button
              type="submit"
              disabled={progressPending}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-white px-4 py-2 text-xs font-semibold text-foreground hover:border-civic-300 disabled:opacity-60"
            >
              {progressPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Mark in progress
            </button>
          </form>
        )}
        <form action={resolveFormAction}>
          <button
            type="submit"
            disabled={resolvePending}
            className="inline-flex items-center gap-2 rounded-full bg-civic-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-civic-700 disabled:opacity-60"
          >
            {resolvePending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            Resolve incident
          </button>
        </form>
      </div>
      {(progressState.error || resolveState.error) && (
        <p role="alert" className="mt-3 flex items-center gap-1.5 text-xs font-medium text-priority-critical">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {progressState.error || resolveState.error}
        </p>
      )}
    </div>
  );
}
