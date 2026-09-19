"use client";

import Link from "next/link";
import { useTransition } from "react";
import { Circle, CheckCircle2 } from "lucide-react";
import { markNotificationRead } from "@/lib/actions/notifications-client";
import { cn } from "@/lib/utils";

interface Notification {
  id: string;
  title: string;
  body: string | null;
  is_read: boolean;
  related_report_id: string | null;
  created_at: string;
}

export function NotificationRow({ notification }: { notification: Notification }) {
  const [pending, startTransition] = useTransition();

  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-2xl border p-4",
        notification.is_read ? "border-border bg-white" : "border-civic-200 bg-civic-50"
      )}
    >
      <button
        type="button"
        disabled={pending || notification.is_read}
        onClick={() => startTransition(() => markNotificationRead(notification.id))}
        className="mt-0.5 shrink-0 text-civic-600 disabled:text-civic-600/50"
        aria-label={notification.is_read ? "Read" : "Mark as read"}
      >
        {notification.is_read ? (
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Circle className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">{notification.title}</p>
        {notification.body && <p className="mt-0.5 text-sm text-foreground-muted">{notification.body}</p>}
        <p className="mt-1 text-xs text-foreground-muted">
          {new Date(notification.created_at).toLocaleString("en-US", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: "Asia/Kolkata",
          })}
        </p>
        {notification.related_report_id && (
          <Link
            href={`/reports/${notification.related_report_id}`}
            className="mt-1 inline-block text-xs font-medium text-civic-700 hover:underline"
          >
            View report
          </Link>
        )}
      </div>
    </li>
  );
}
