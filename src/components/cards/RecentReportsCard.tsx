import Link from "next/link";
import { MapPin } from "lucide-react";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { categoryLabels } from "@/lib/categories";
import { locationDetailLine, locationCompact } from "@/lib/location-format";
import { timeAgo, isWithin } from "@/lib/time-ago";
import type { CivicIssue } from "@/lib/types";

/**
 * Phase G2 — the newest citizen reports in this government user's
 * jurisdiction. Takes the dashboard's existing RLS-scoped issue list
 * (already newest-first), so it adds no query and can never show a report
 * the caller isn't authorized to see.
 */
export function RecentReportsCard({ issues, limit = 5 }: { issues: CivicIssue[]; limit?: number }) {
  const recent = issues.slice(0, limit);
  const newCount = issues.filter((i) => isWithin(i.reportedDate)).length;

  return (
    <div className="rounded-2xl border border-border bg-white p-6">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-foreground">New &amp; Recent Reports</h2>
          <p className="mt-1 text-xs text-foreground-muted">
            {newCount > 0
              ? `${newCount} new in the last 24 hours in your jurisdiction.`
              : "No new reports in the last 24 hours."}
          </p>
        </div>
        <Link href="/government/issues" className="shrink-0 text-xs font-medium text-civic-700 hover:underline">
          All issues →
        </Link>
      </div>

      {recent.length === 0 ? (
        <p className="mt-4 text-sm text-foreground-muted">No reports in your jurisdiction yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {recent.map((issue) => {
            const isNew = isWithin(issue.reportedDate);
            const detail = locationDetailLine(issue.location);
            return (
              <li key={issue.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {isNew && (
                      <span className="rounded-full bg-priority-critical-bg px-2 py-0.5 text-[11px] font-semibold text-priority-critical">
                        New
                      </span>
                    )}
                    <span className="truncate text-sm font-semibold text-foreground">{issue.title}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground-muted">
                    <span>{categoryLabels[issue.category]}</span>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3 w-3" aria-hidden="true" />
                      {detail ? `${detail}, ${locationCompact(issue.location)}` : locationCompact(issue.location)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <time dateTime={issue.reportedDate}>{timeAgo(issue.reportedDate)}</time>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <PriorityBadge priority={issue.priority} />
                  <StatusBadge status={issue.status} />
                  <Link
                    href={`/reports/${issue.id}`}
                    className="text-xs font-medium text-civic-700 hover:underline"
                  >
                    View issue
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
