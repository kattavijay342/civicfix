import Link from "next/link";
import Image from "next/image";
import { MapPin, Building2, MessageSquare, CalendarClock } from "lucide-react";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { CivicIssue } from "@/lib/types";
import { agingLabel, agingClass } from "@/lib/aging";
import { locationHeadline, locationBreakdown } from "@/lib/location-format";
import { cn } from "@/lib/utils";

export function PendingIssueDetailCard({ issue }: { issue: CivicIssue }) {
  const loc = issue.location;
  return (
    <Link
      href={`/reports/${issue.id}`}
      className="block rounded-2xl border border-border bg-white p-5 transition-all duration-300 hover:-translate-y-0.5 hover:border-civic-200 hover:shadow-[0_16px_40px_-24px_rgba(20,64,47,0.32)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-civic-500"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex gap-3">
          {issue.imageUrl && (
            <div className="relative hidden h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-border sm:block">
              <Image src={issue.imageUrl} alt="" fill sizes="64px" className="object-cover object-bottom" />
            </div>
          )}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <PriorityBadge priority={issue.priority} />
              <StatusBadge status={issue.status} />
            </div>
            <h3 className="mt-2 text-[15px] font-semibold text-foreground">{issue.title}</h3>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-foreground-muted">
              <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
              {locationHeadline(loc)}
            </p>
          </div>
        </div>
        <span className={cn("shrink-0 text-sm", agingClass(issue.daysPending))}>
          {agingLabel(issue.daysPending)}
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4 text-xs sm:grid-cols-4">
        {locationBreakdown(loc).map((row) => (
          <div key={row.label} className={row.label === "Specific Location" ? "col-span-2 sm:col-span-4" : undefined}>
            <dt className="text-foreground-muted">{row.label}</dt>
            <dd className="mt-1 font-semibold text-foreground">{row.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4 text-xs sm:grid-cols-4">
        <div>
          <span className="flex items-center gap-1 text-foreground-muted">
            <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
            Department
          </span>
          <p className="mt-1 font-semibold text-foreground">{issue.department}</p>
        </div>
        <div>
          <span className="flex items-center gap-1 text-foreground-muted">
            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
            Follow-ups
          </span>
          <p className="mt-1 font-semibold text-foreground">{issue.followUps ?? 0}</p>
        </div>
        {issue.lastFollowUp && (
          <div className="col-span-2 sm:col-span-1">
            <span className="text-foreground-muted">Last Follow-up</span>
            <p className="mt-1 font-medium text-foreground">{issue.lastFollowUp}</p>
          </div>
        )}
        {issue.nextFollowUp && (
          <div className="col-span-2 sm:col-span-1">
            <span className="flex items-center gap-1 text-foreground-muted">
              <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
              Next Follow-up
            </span>
            <p className="mt-1 font-semibold text-civic-700">{issue.nextFollowUp}</p>
          </div>
        )}
      </div>
    </Link>
  );
}
