import Image from "next/image";
import Link from "next/link";
import { MapPin, Building2, CalendarDays, MessageSquare, ImageOff } from "lucide-react";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { CivicIssue } from "@/lib/types";
import { categoryLabels } from "@/lib/categories";
import { agingLabel, agingClass } from "@/lib/aging";
import { locationCompact, locationOneLine } from "@/lib/location-format";
import { cn } from "@/lib/utils";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function IssueCard({ issue, linkToDetail = true }: { issue: CivicIssue; linkToDetail?: boolean }) {
  const content = (
    <article className="group flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-white transition-all duration-300 hover:-translate-y-1 hover:border-civic-200 hover:shadow-[0_16px_40px_-22px_rgba(20,64,47,0.32)]">
      <div className="relative h-36 border-b border-border bg-surface-muted text-foreground-muted">
        {issue.imageUrl ? (
          <Image
            src={issue.imageUrl}
            alt={`Photo evidence of: ${issue.title}, ${locationOneLine(issue.location)}`}
            fill
            sizes="(min-width: 1024px) 360px, (min-width: 640px) 45vw, 90vw"
            className="object-cover object-bottom transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <ImageOff className="h-6 w-6" aria-hidden="true" />
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col p-5">
        <div className="flex flex-wrap items-center gap-2">
          <PriorityBadge priority={issue.priority} />
          <StatusBadge status={issue.status} />
        </div>

        <h3 className="mt-3 text-[15px] font-semibold leading-snug text-foreground">
          {issue.title}
        </h3>
        <p className="mt-1 text-xs font-medium text-civic-700">
          {categoryLabels[issue.category]}
        </p>

        <dl className="mt-4 space-y-2 text-xs text-foreground-muted">
          <div className="flex items-start gap-1.5">
            <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <dt className="sr-only">Location</dt>
            <dd>
              <p>{issue.location.displayName}</p>
              <p className="text-foreground-muted/80">{locationCompact(issue.location)}</p>
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <dt className="sr-only">Department</dt>
            <dd>{issue.department}</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <CalendarDays className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <dt className="sr-only">Reported</dt>
            <dd>Reported {formatDate(issue.reportedDate)}</dd>
          </div>
        </dl>

        <div className="mt-auto flex items-center justify-between border-t border-border pt-4 text-xs">
          <span className={cn(agingClass(issue.daysPending))}>{agingLabel(issue.daysPending)}</span>
          {!!issue.followUps && (
            <span className="flex items-center gap-1 font-medium text-civic-700">
              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
              {issue.followUps} follow-up{issue.followUps === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>
    </article>
  );

  if (!linkToDetail) return content;

  return (
    <Link
      href={`/reports/${issue.id}`}
      className="block h-full rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-civic-500"
      aria-label={`View details for ${issue.title}`}
    >
      {content}
    </Link>
  );
}
