"use client";

import { useState, useTransition } from "react";
import { Clock, CheckCircle2, XCircle, Loader2, Ban } from "lucide-react";
import { cancelReminder } from "@/lib/actions/reminders";
import type { ReminderView } from "@/lib/data/reminders";
import { cn } from "@/lib/utils";

const statusConfig: Record<
  ReminderView["status"],
  { label: string; text: string; bg: string; icon: typeof Clock }
> = {
  scheduled: { label: "Scheduled", text: "text-status-routed", bg: "bg-status-routed-bg", icon: Clock },
  processing: { label: "Processing", text: "text-status-progress", bg: "bg-status-progress-bg", icon: Loader2 },
  sent: { label: "Sent", text: "text-status-resolved", bg: "bg-status-resolved-bg", icon: CheckCircle2 },
  failed: { label: "Failed", text: "text-priority-critical", bg: "bg-priority-critical-bg", icon: XCircle },
  cancelled: { label: "Cancelled", text: "text-foreground-muted", bg: "bg-surface-muted", icon: Ban },
};

function formatIst(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });
}

export function ReminderRow({ reminder, reportId }: { reminder: ReminderView; reportId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const config = statusConfig[reminder.status];
  const Icon = config.icon;

  function handleCancel() {
    setError(null);
    startTransition(async () => {
      const result = await cancelReminder(reminder.id, reportId);
      if (result.error) setError(result.error);
    });
  }

  return (
    <li className="border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{reminder.title}</p>
          <p className="mt-0.5 text-sm text-foreground-muted">{reminder.message}</p>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
            config.text,
            config.bg
          )}
        >
          <Icon className={cn("h-3.5 w-3.5", reminder.status === "processing" && "animate-spin")} aria-hidden="true" />
          {config.label}
        </span>
      </div>
      <p className="mt-2 text-xs text-foreground-muted">
        For <span className="font-medium text-foreground">{reminder.recipientName ?? "the department in-charge"}</span> ·
        Due {formatIst(reminder.scheduledAt)}
        {reminder.createdByName && <> · Scheduled by {reminder.createdByName}</>}
      </p>
      {reminder.status === "sent" && reminder.sentAt && (
        <p className="mt-1 text-xs text-civic-700">Notification sent {formatIst(reminder.sentAt)}.</p>
      )}
      {reminder.status === "failed" && reminder.failureReason && (
        <p className="mt-1 text-xs text-priority-critical">Could not be delivered: {reminder.failureReason}</p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs font-medium text-priority-critical">
          {error}
        </p>
      )}
      {reminder.isOwnCreation && reminder.status === "scheduled" && (
        <button
          type="button"
          disabled={pending}
          onClick={handleCancel}
          className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1.5 text-xs font-medium text-foreground-muted hover:border-priority-critical/40 hover:text-priority-critical disabled:opacity-60"
        >
          {pending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
          Cancel reminder
        </button>
      )}
    </li>
  );
}
