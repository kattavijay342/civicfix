"use client";

import { useActionState, useState } from "react";
import { Loader2, AlertCircle, CheckCircle2, RotateCcw, Check } from "lucide-react";
import { updateReportStatus, submitResolution, type DepartmentActionState } from "@/lib/actions/department";
import { ACTION_LABEL, nextDepartmentStatus } from "@/lib/status-transitions";
import type { IssueStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const initialState: DepartmentActionState = {};

const inputClasses =
  "w-full rounded-xl border border-border bg-white px-3.5 py-2.5 text-sm text-foreground outline-none transition focus:border-civic-400 focus:ring-2 focus:ring-civic-100";

const buttonClasses =
  "inline-flex w-fit items-center gap-2 rounded-full bg-civic-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-civic-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-civic-500 focus-visible:ring-offset-2 disabled:opacity-60";

const WORKFLOW_STEPS: IssueStatus[] = ["ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED"];

/** Which workflow steps are already done for the current status. */
function completedSteps(status: IssueStatus): number {
  if (status === "RESOLVED") return 3;
  if (status === "IN_PROGRESS") return 2;
  if (status === "ACKNOWLEDGED") return 1;
  return 0;
}

function WorkflowSteps({ status }: { status: IssueStatus }) {
  const done = completedSteps(status);
  return (
    <ol className="mt-4 grid grid-cols-3 gap-2" aria-label="Department workflow">
      {WORKFLOW_STEPS.map((step, i) => {
        const isDone = i < done;
        const isCurrent = i === done;
        return (
          <li
            key={step}
            aria-current={isCurrent ? "step" : undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-xl border px-2.5 py-2 text-[11px] font-semibold",
              isDone && "border-civic-200 bg-civic-50 text-civic-800",
              isCurrent && "border-civic-400 bg-white text-foreground",
              !isDone && !isCurrent && "border-border bg-surface-muted text-foreground-muted"
            )}
          >
            <span
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px]",
                isDone ? "bg-civic-600 text-white" : "border border-current"
              )}
              aria-hidden="true"
            >
              {isDone ? <Check className="h-2.5 w-2.5" /> : i + 1}
            </span>
            {ACTION_LABEL[step]}
          </li>
        );
      })}
    </ol>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-center gap-1.5 text-xs font-medium text-priority-critical">
      <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {message}
    </p>
  );
}

/**
 * The department in-charge's workflow actions (G4). Offers exactly the one
 * next step the server will accept (nextDepartmentStatus, shared with
 * src/lib/actions/department.ts) — the server re-validates everything
 * against the stored status and the caller's live assignment regardless.
 */
export function DepartmentActionsPanel({
  reportId,
  status,
  reopenNote,
}: {
  reportId: string;
  status: IssueStatus;
  /** The citizen's own comment from resolution feedback, shown read-only
   * when this report was reopened — never editable here (Phase 6D §20:
   * "Do NOT allow government users to manipulate citizen feedback"). */
  reopenNote?: string | null;
}) {
  const updateAction = updateReportStatus.bind(null, reportId);
  const resolveAction = submitResolution.bind(null, reportId);
  const [updateState, updateFormAction, updatePending] = useActionState(updateAction, initialState);
  const [resolveState, resolveFormAction, resolvePending] = useActionState(resolveAction, initialState);

  // Rotated on success, same "adjust state while rendering" pattern as
  // FollowUpForm/ReminderForm — prevents a double-click or retried request
  // from being replayed as a second real status change/resolution.
  const [updateKey, setUpdateKey] = useState(() => crypto.randomUUID());
  const [handledUpdateState, setHandledUpdateState] = useState(updateState);
  if (updateState !== handledUpdateState) {
    setHandledUpdateState(updateState);
    if (updateState.success) setUpdateKey(crypto.randomUUID());
  }

  const [resolveKey, setResolveKey] = useState(() => crypto.randomUUID());
  const [handledResolveState, setHandledResolveState] = useState(resolveState);
  if (resolveState !== handledResolveState) {
    setHandledResolveState(resolveState);
    if (resolveState.success) setResolveKey(crypto.randomUUID());
  }

  const next = nextDepartmentStatus(status);

  if (status === "RESOLVED") {
    return (
      <div className="rounded-2xl border border-civic-200 bg-civic-50 p-6" data-testid="department-actions">
        <p role="status" className="flex items-center gap-1.5 text-sm font-semibold text-civic-800">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          This report is resolved.
        </p>
        <p className="mt-1 text-xs text-civic-800/80">The citizen can now confirm whether the fix worked.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-white p-6" data-testid="department-actions">
      <h2 className="text-sm font-semibold text-foreground">Department Actions</h2>
      <WorkflowSteps status={status} />

      {status === "REOPENED" && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-status-reopened/30 bg-status-reopened-bg px-3.5 py-2.5 text-xs text-status-reopened">
          <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            The citizen reported this issue isn&apos;t actually resolved. Acknowledge it to restart work.
            {reopenNote && <> &ldquo;{reopenNote}&rdquo;</>}
          </span>
        </div>
      )}

      {!next && (
        <p className="mt-4 text-xs text-foreground-muted">
          No department action is available until this report has been routed.
        </p>
      )}

      {(next === "ACKNOWLEDGED" || next === "IN_PROGRESS") && (
        <form action={updateFormAction} className="mt-4 flex flex-col gap-3">
          <input type="hidden" name="idempotencyKey" value={updateKey} />
          <input type="hidden" name="status" value={next} />
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground-muted">Action notes (optional)</span>
            <textarea
              name="notes"
              rows={2}
              maxLength={1000}
              className={inputClasses}
              placeholder={next === "ACKNOWLEDGED" ? "e.g. Inspection scheduled for tomorrow." : "e.g. Repair crew dispatched."}
            />
          </label>
          {updateState.error && <ErrorLine message={updateState.error} />}
          {updateState.success && (
            <p role="status" className="flex items-center gap-1.5 text-xs font-medium text-civic-700">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Status updated.
            </p>
          )}
          <button type="submit" disabled={updatePending} className={buttonClasses}>
            {updatePending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {ACTION_LABEL[next]}
          </button>
        </form>
      )}

      {next === "RESOLVED" && (
        <form action={resolveFormAction} className="mt-4 flex flex-col gap-3">
          <input type="hidden" name="idempotencyKey" value={resolveKey} />
          {updateState.success && (
            <p role="status" className="flex items-center gap-1.5 text-xs font-medium text-civic-700">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Work started. Submit the resolution once the fix is done.
            </p>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground-muted">Resolution notes</span>
            <textarea
              name="notes"
              rows={3}
              required
              minLength={5}
              maxLength={1000}
              className={inputClasses}
              placeholder="Describe what was fixed."
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground-muted">After photo</span>
            <input type="file" name="afterPhoto" accept="image/*" required className={inputClasses} />
          </label>
          {resolveState.error && <ErrorLine message={resolveState.error} />}
          <button type="submit" disabled={resolvePending} className={buttonClasses}>
            {resolvePending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            Resolve
          </button>
        </form>
      )}
    </div>
  );
}
