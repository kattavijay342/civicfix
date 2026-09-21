import Link from "next/link";
import { Clock, AlertTriangle, CalendarClock, CheckCircle2 } from "lucide-react";
import type { FollowUpCenterGroups, FollowUpCenterItem } from "@/lib/data/reminders";

function formatIst(iso: string) {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

function FollowUpRow({ item }: { item: FollowUpCenterItem }) {
  return (
    <li>
      <Link
        href={`/reports/${item.reportId}`}
        className="flex items-center justify-between gap-3 rounded-xl border border-border bg-white px-4 py-3 text-sm transition hover:border-civic-300"
      >
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{item.title}</p>
          <p className="mt-0.5 truncate text-xs text-foreground-muted">{item.reportTitle}</p>
        </div>
        <div className="shrink-0 text-right text-xs text-foreground-muted">
          <p>{item.recipientName ?? "Department in-charge"}</p>
          <p>{formatIst(item.scheduledAt)}</p>
        </div>
      </Link>
    </li>
  );
}

function FollowUpGroup({
  title,
  icon: Icon,
  items,
  tone,
}: {
  title: string;
  icon: typeof Clock;
  items: FollowUpCenterItem[];
  tone?: "critical";
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3
        className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide ${
          tone === "critical" ? "text-priority-critical" : "text-foreground-muted"
        }`}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {title} ({items.length})
      </h3>
      <ul className="mt-2 flex flex-col gap-2">
        {items.map((item) => (
          <FollowUpRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}

/**
 * Jurisdiction-wide Follow-up Center (Phase 6E §12) — reuses Phase 6C's
 * existing reminder architecture entirely (src/lib/data/reminders.ts's
 * getFollowUpCenter(), the same reminders_select RLS policy); this is a
 * new VIEW over existing reminders, not a second reminder system.
 * "Overdue" is legitimate here (unlike the fabricated SLA metric) because
 * scheduled_at is a real due time the creator explicitly chose.
 */
export function FollowUpCenter({ groups }: { groups: FollowUpCenterGroups }) {
  const nothing =
    groups.dueToday.length === 0 && groups.overdue.length === 0 && groups.upcoming.length === 0 && groups.completed.length === 0;

  if (nothing) {
    return <p className="text-sm text-foreground-muted">No follow-up reminders scheduled.</p>;
  }

  return (
    <div id="follow-up-center" className="flex flex-col gap-5 scroll-mt-20">
      <FollowUpGroup title="Overdue" icon={AlertTriangle} items={groups.overdue} tone="critical" />
      <FollowUpGroup title="Due today" icon={Clock} items={groups.dueToday} />
      <FollowUpGroup title="Upcoming" icon={CalendarClock} items={groups.upcoming} />
      <FollowUpGroup title="Completed" icon={CheckCircle2} items={groups.completed.slice(0, 10)} />
    </div>
  );
}
