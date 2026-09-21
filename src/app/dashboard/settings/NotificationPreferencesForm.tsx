"use client";

import { useActionState } from "react";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import {
  updateNotificationPreferences,
  type NotificationPreferencesFormState,
} from "@/lib/actions/notification-preferences";
import { CATEGORY_LABELS, type NotificationCategory } from "@/lib/notifications/types";
import type { Profile } from "@/lib/types";

const initialState: NotificationPreferencesFormState = {};

const categories = Object.keys(CATEGORY_LABELS) as NotificationCategory[];

export function NotificationPreferencesForm({ profile }: { profile: Profile }) {
  const [state, action, pending] = useActionState(updateNotificationPreferences, initialState);

  return (
    <form action={action} className="flex flex-col gap-4 rounded-2xl border border-border bg-white p-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Notification preferences</h2>
        <p className="mt-1 text-xs text-foreground-muted">
          Every category is on by default. Email, SMS, and push notifications aren&apos;t available yet — only
          in-app notifications are sent.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {categories.map((category) => {
          const enabled = profile.notification_preferences?.[category] !== false;
          return (
            <label key={category} className="flex items-start gap-3 text-sm text-foreground">
              <input
                type="checkbox"
                name={category}
                defaultChecked={enabled}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-civic-600 focus-visible:ring-2 focus-visible:ring-civic-200"
              />
              <span>{CATEGORY_LABELS[category]}</span>
            </label>
          );
        })}
      </div>

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
        Save preferences
      </button>
    </form>
  );
}
