"use client";

import { useActionState, useState } from "react";
import { Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { updateReportStatus, submitResolution, type DepartmentActionState } from "@/lib/actions/department";
import type { IssueStatus } from "@/lib/types";

const initialState: DepartmentActionState = {};

const inputClasses =
  "w-full rounded-xl border border-border bg-white px-3.5 py-2.5 text-sm text-foreground outline-none transition focus:border-civic-400 focus:ring-2 focus:ring-civic-100";

export function DepartmentActionsPanel({ reportId, status }: { reportId: string; status: IssueStatus }) {
  const updateAction = updateReportStatus.bind(null, reportId);
  const resolveAction = submitResolution.bind(null, reportId);
  const [updateState, updateFormAction, updatePending] = useActionState(updateAction, initialState);
  const [resolveState, resolveFormAction, resolvePending] = useActionState(resolveAction, initialState);
  const [showResolve, setShowResolve] = useState(false);

  if (status === "RESOLVED") {
    return (
      <div className="rounded-2xl border border-civic-200 bg-civic-50 p-6">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-civic-800">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          This report is resolved.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-white p-6">
      <h2 className="text-sm font-semibold text-foreground">Department Actions</h2>

      {!showResolve ? (
        <>
          <form action={updateFormAction} className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground-muted">Update status</span>
              <select name="status" required className={inputClasses} defaultValue="">
                <option value="" disabled>
                  Select status
                </option>
                <option value="ACKNOWLEDGED">Acknowledged</option>
                <option value="IN_PROGRESS">In Progress</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground-muted">Action notes (optional)</span>
              <textarea name="notes" rows={2} className={inputClasses} placeholder="What did you do?" />
            </label>
            {updateState.error && (
              <p className="flex items-center gap-1.5 text-xs font-medium text-priority-critical">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {updateState.error}
              </p>
            )}
            {updateState.success && (
              <p className="flex items-center gap-1.5 text-xs font-medium text-civic-700">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Status updated.
              </p>
            )}
            <button
              type="submit"
              disabled={updatePending}
              className="inline-flex w-fit items-center gap-2 rounded-full bg-civic-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-civic-700 disabled:opacity-60"
            >
              {updatePending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Update status
            </button>
          </form>

          <button
            type="button"
            onClick={() => setShowResolve(true)}
            className="mt-4 w-full rounded-full border border-border bg-white px-4 py-2.5 text-xs font-semibold text-foreground hover:border-civic-300"
          >
            Mark as resolved (upload evidence)
          </button>
        </>
      ) : (
        <form action={resolveFormAction} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground-muted">Resolution notes</span>
            <textarea
              name="notes"
              rows={3}
              required
              className={inputClasses}
              placeholder="Describe what was fixed."
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground-muted">After photo</span>
            <input type="file" name="afterPhoto" accept="image/*" required className={inputClasses} />
          </label>
          {resolveState.error && (
            <p className="flex items-center gap-1.5 text-xs font-medium text-priority-critical">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {resolveState.error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={resolvePending}
              className="inline-flex items-center gap-2 rounded-full bg-civic-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-civic-700 disabled:opacity-60"
            >
              {resolvePending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Submit resolution
            </button>
            <button
              type="button"
              onClick={() => setShowResolve(false)}
              className="rounded-full px-4 py-2 text-xs font-medium text-foreground-muted hover:bg-surface-muted"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
