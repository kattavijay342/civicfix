"use client";

import { useActionState, useState } from "react";
import { Loader2, AlertCircle, CheckCircle2, Send, CalendarClock } from "lucide-react";
import { createReminder, type ReminderFormState } from "@/lib/actions/reminders";
import { REMINDER_TITLE_MAX, REMINDER_MESSAGE_MAX } from "@/lib/reminders-shared";

const initialState: ReminderFormState = {};

const inputClasses =
  "w-full rounded-xl border border-border bg-white px-3.5 py-2.5 text-sm text-foreground outline-none transition focus:border-civic-400 focus:ring-2 focus:ring-civic-100";

/** "Tomorrow" quick-pick, computed as an India Standard Time calendar date
 * at a sensible default time — matches how the server interprets this same
 * datetime-local value (src/lib/actions/reminders.ts parseIstDateTimeLocal),
 * so what the user picks is exactly when it fires, regardless of the
 * browser's own system timezone. */
function tomorrowIstValue(): string {
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  istNow.setUTCDate(istNow.getUTCDate() + 1);
  const yyyy = istNow.getUTCFullYear();
  const mm = String(istNow.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(istNow.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T10:00`;
}

const OUTCOME_MESSAGES: Record<NonNullable<ReminderFormState["outcome"]>, string> = {
  sent: "Follow-up sent to the department in-charge.",
  queued: "Follow-up queued — delivery will be retried automatically.",
  scheduled: "Reminder scheduled.",
};

/** G6 — one form, two submit buttons: "Send now" delivers the follow-up
 * immediately, "Schedule reminder" (the existing Phase 4 flow) queues it
 * for the chosen time. The recipient is never part of the form — the
 * server derives the effective in-charge (src/lib/actions/reminders.ts). */
export function ReminderForm({ reportId }: { reportId: string }) {
  const action = createReminder.bind(null, reportId);
  const [state, formAction, pending] = useActionState(action, initialState);
  const [scheduledAt, setScheduledAt] = useState("");

  // Rotated during render (React's documented "adjust state while
  // rendering" pattern) rather than in an Effect — see FollowUpForm for
  // the same pattern and why.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [handledState, setHandledState] = useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state.success) setIdempotencyKey(crypto.randomUUID());
  }

  return (
    <form action={formAction} className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-foreground-muted">Subject (optional)</span>
        <input
          name="title"
          maxLength={REMINDER_TITLE_MAX}
          className={inputClasses}
          placeholder="e.g. Status update needed"
          aria-invalid={!!state.error}
          aria-describedby={state.error ? "reminder-form-error" : undefined}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-foreground-muted">Message to the department in-charge</span>
        <textarea
          name="message"
          rows={3}
          required
          minLength={5}
          maxLength={REMINDER_MESSAGE_MAX}
          className={inputClasses}
          placeholder="e.g. Please provide an update on this issue."
          aria-invalid={!!state.error}
          aria-describedby={state.error ? "reminder-form-error" : undefined}
        />
      </label>
      <div>
        <span className="text-xs font-medium text-foreground-muted">Schedule for later (optional)</span>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setScheduledAt(tomorrowIstValue())}
            className="min-h-10 rounded-full border border-border bg-white px-3.5 py-2 text-xs font-medium text-foreground hover:border-civic-300"
          >
            Tomorrow
          </button>
          <input
            type="datetime-local"
            name="scheduledAt"
            aria-label="Reminder date and time"
            aria-invalid={!!state.error}
            aria-describedby={state.error ? "reminder-form-error" : undefined}
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            className={inputClasses}
          />
        </div>
        <p className="mt-1 text-[11px] text-foreground-muted">Times are in India Standard Time (IST).</p>
      </div>
      {state.error && (
        <p id="reminder-form-error" role="alert" className="flex items-center gap-1.5 text-xs font-medium text-priority-critical">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {state.error}
        </p>
      )}
      {state.success && (
        <p role="status" className="flex items-center gap-1.5 text-xs font-medium text-civic-700">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {OUTCOME_MESSAGES[state.outcome ?? "scheduled"]}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          name="timing"
          value="now"
          disabled={pending}
          className="inline-flex min-h-10 items-center gap-2 rounded-full bg-civic-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-civic-700 disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Send className="h-3.5 w-3.5" aria-hidden="true" />}
          Send now
        </button>
        <button
          type="submit"
          name="timing"
          value="scheduled"
          disabled={pending}
          className="inline-flex min-h-10 items-center gap-2 rounded-full border border-civic-200 bg-white px-4 py-2 text-xs font-semibold text-civic-700 transition hover:border-civic-400 disabled:opacity-60"
        >
          <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
          Schedule reminder
        </button>
      </div>
    </form>
  );
}
