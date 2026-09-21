"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck } from "lucide-react";
import { markAllNotificationsRead } from "@/lib/actions/notifications-client";

export function MarkAllReadButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await markAllNotificationsRead();
          router.refresh();
        })
      }
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3.5 py-2 text-xs font-medium text-foreground-muted transition hover:border-civic-300 hover:text-foreground disabled:opacity-60"
    >
      <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
      {pending ? "Marking…" : "Mark all read"}
    </button>
  );
}
