"use client";

import { useActionState } from "react";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { updateOwnProfile, type ProfileFormState } from "@/lib/actions/profile";
import type { Profile } from "@/lib/types";

const inputClasses =
  "w-full rounded-xl border border-border bg-white px-3.5 py-2.5 text-sm text-foreground outline-none transition focus:border-civic-400 focus:ring-2 focus:ring-civic-100";

const initialState: ProfileFormState = {};

export function ProfileForm({ profile }: { profile: Profile }) {
  const [state, action, pending] = useActionState(updateOwnProfile, initialState);

  return (
    <form action={action} className="flex flex-col gap-4 rounded-2xl border border-border bg-white p-6">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">Full name</span>
        <input name="fullName" defaultValue={profile.full_name ?? ""} className={inputClasses} required />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">Mobile number</span>
        <input name="mobile" defaultValue={profile.mobile_number ?? ""} className={inputClasses} required />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">Role</span>
        <input
          value={profile.role === "government" ? "Authorized Government User" : profile.role}
          disabled
          className={`${inputClasses} cursor-not-allowed bg-surface-muted text-foreground-muted`}
        />
      </label>

      {state.error && (
        <p role="alert" className="flex items-center gap-1.5 rounded-lg bg-priority-critical-bg px-3 py-2 text-sm text-priority-critical">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {state.error}
        </p>
      )}
      {state.success && (
        <p className="flex items-center gap-1.5 rounded-lg bg-civic-50 px-3 py-2 text-sm text-civic-800">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          Saved.
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex w-fit items-center gap-2 rounded-full bg-civic-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-civic-700 disabled:opacity-60"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        Save changes
      </button>
    </form>
  );
}
