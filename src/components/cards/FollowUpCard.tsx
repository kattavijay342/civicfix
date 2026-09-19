import Link from "next/link";
import { ArrowRight, Phone, Clock, Hourglass, CheckCircle2 } from "lucide-react";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import type { CivicIssue } from "@/lib/types";

export function FollowUpCard({ issue }: { issue: CivicIssue }) {
  return (
    <div className="rounded-2xl border border-border bg-white p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <PriorityBadge priority={issue.priority} />
          <span className="text-sm font-semibold text-foreground">{issue.title}</span>
        </div>
        <Link
          href={`/reports/${issue.id}`}
          className="shrink-0 text-xs font-medium text-civic-700 hover:underline"
        >
          View issue
        </Link>
      </div>

      <div className="mt-4 flex items-center gap-2 text-xs text-foreground-muted">
        <span className="rounded-full bg-civic-50 px-2.5 py-1 font-semibold text-civic-700">
          AI Routed
        </span>
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="font-medium text-foreground">{issue.department} Department</span>
      </div>

      <ol className="mt-4 space-y-3 border-l-2 border-border pl-4">
        <li className="relative text-xs">
          <span className="absolute -left-[21px] top-0.5 h-2.5 w-2.5 rounded-full bg-civic-400" aria-hidden="true" />
          <span className="font-semibold text-foreground">Reported &amp; automatically routed</span>
        </li>
        {issue.lastFollowUp && (
          <li className="relative text-xs">
            <span className="absolute -left-[21px] top-0.5 h-2.5 w-2.5 rounded-full bg-civic-600" aria-hidden="true" />
            <span className="flex items-center gap-1.5 font-semibold text-foreground">
              <Phone className="h-3 w-3" aria-hidden="true" />
              Government Follow-up
            </span>
            <p className="mt-0.5 text-foreground-muted">{issue.lastFollowUp}</p>
          </li>
        )}
        {issue.nextFollowUp && (
          <li className="relative text-xs">
            <span className="absolute -left-[21px] top-0.5 h-2.5 w-2.5 rounded-full border-2 border-civic-400 bg-white" aria-hidden="true" />
            <span className="flex items-center gap-1.5 font-semibold text-civic-700">
              <Clock className="h-3 w-3" aria-hidden="true" />
              Next Follow-up: {issue.nextFollowUp}
            </span>
          </li>
        )}
      </ol>

      <div className="mt-3 flex items-center gap-1.5 text-xs font-medium text-priority-medium">
        {issue.status === "RESOLVED" ? (
          <>
            <CheckCircle2 className="h-3.5 w-3.5 text-civic-600" aria-hidden="true" />
            <span className="text-civic-700">Resolved</span>
          </>
        ) : (
          <>
            <Hourglass className="h-3.5 w-3.5" aria-hidden="true" />
            Awaiting Department Update
          </>
        )}
      </div>
    </div>
  );
}
