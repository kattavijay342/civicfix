"use client";

import { useActionState } from "react";
import { Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { createDepartment, type AdminActionState } from "@/lib/actions/admin";

const initialState: AdminActionState = {};

export function CreateDepartmentForm() {
  const [state, formAction, pending] = useActionState(createDepartment, initialState);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-foreground-muted">Name</span>
        <input
          name="name"
          required
          className="rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground outline-none focus:border-civic-400"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-foreground-muted">Description (optional)</span>
        <input
          name="description"
          className="rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground outline-none focus:border-civic-400"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-full bg-civic-600 px-4 py-2 text-xs font-semibold text-white hover:bg-civic-700 disabled:opacity-60"
      >
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
        Add department
      </button>
      {state.error && (
        <p className="flex items-center gap-1.5 text-xs font-medium text-priority-critical">
          <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
          {state.error}
        </p>
      )}
      {state.success && <CheckCircle2 className="h-4 w-4 text-civic-600" aria-hidden="true" />}
    </form>
  );
}
