import type { Metadata } from "next";
import Link from "next/link";
import { ClipboardList, ListChecks, Loader2, CheckCircle2, BellRing, Eye, AlertTriangle, MessageSquareText } from "lucide-react";
import { IssueCard } from "@/components/cards/IssueCard";
import { DashboardStat } from "@/components/cards/DashboardStat";
import { AgingBucketsChart } from "@/components/cards/AgingBucketsChart";
import { ResolutionQualityCard } from "@/components/cards/ResolutionQualityCard";
import { IncidentsSection } from "@/components/cards/IncidentsSection";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import { timeAgo } from "@/lib/time-ago";
import { statusFromDb } from "@/lib/db-enums";
import { IssueListFilterBar, IssueListPagination } from "@/components/cards/IssueListControls";
import { requireRole } from "@/lib/supabase/server";
import {
  getAssignedIssuesPage,
  getAssignedIssueStats,
  getRecentlyAssignedIssues,
  getDepartmentFollowUps,
} from "@/lib/data/department";
import { getAgingBuckets, getResolutionQuality } from "@/lib/data/government";
import { getIncidentList } from "@/lib/data/incidents";
import type { IssueListFilters, IssueStatus, Priority, ProblemCategory } from "@/lib/types";

export const metadata: Metadata = {
  title: "Department Dashboard — CivicFix",
};

export default async function DepartmentDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireRole(["department_incharge", "admin"]);

  const params = await searchParams;
  const page = Number(params.page ?? "1") || 1;
  const filters: IssueListFilters = {
    status: (params.status as IssueStatus) || undefined,
    priority: (params.priority as Priority) || undefined,
    category: (params.category as ProblemCategory) || undefined,
    search: params.q || undefined,
  };

  // getAgingBuckets/getResolutionQuality are the same Phase 6E functions
  // the government dashboard uses (src/lib/data/government.ts) — no new
  // query shape needed: both are `security invoker` over `reports`, so for
  // a department_incharge caller RLS's `report_assigned_to_me` already
  // scopes them down to just this in-charge's own assigned reports.
  const [stats, paged, recent, aging, resolutionQuality, incidents, followUps] = await Promise.all([
    getAssignedIssueStats(session.user.id),
    getAssignedIssuesPage(session.user.id, page, filters),
    getRecentlyAssignedIssues(session.user.id),
    getAgingBuckets(),
    getResolutionQuality(),
    getIncidentList(),
    getDepartmentFollowUps(session.user.id),
  ]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
      <span className="text-sm font-semibold text-civic-700">Department In-charge</span>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">My Assigned Issues</h1>
      <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
        Issues CivicFix routed to your department within your authorized jurisdiction. Update status, add
        action notes, and submit resolution evidence.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6" data-testid="department-stats">
        <DashboardStat icon={ListChecks} label="Total assigned" value={String(stats.assigned)} tone="civic" />
        <DashboardStat icon={BellRing} label="Awaiting acknowledgement" value={String(stats.awaitingAcknowledgement)} />
        <DashboardStat icon={Eye} label="Acknowledged" value={String(stats.acknowledged)} />
        <DashboardStat icon={Loader2} label="In progress" value={String(stats.inProgress)} />
        <DashboardStat icon={CheckCircle2} label="Resolved" value={String(stats.resolved)} />
        <DashboardStat icon={AlertTriangle} label="High/critical open" value={String(stats.urgentOpen)} />
      </div>

      {followUps.length > 0 && (
        <div className="mt-6 rounded-2xl border border-border bg-white p-6" data-testid="department-follow-ups">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <MessageSquareText className="h-4 w-4 text-civic-700" aria-hidden="true" />
            Government follow-ups
          </h2>
          <p className="mt-1 text-xs text-foreground-muted">
            Follow-ups sent to you on your assigned issues. Respond by updating the issue — acknowledge, start
            work or resolve it from the issue page.
          </p>
          <ul className="mt-4 divide-y divide-border">
            {followUps.map((f) => (
              <li key={f.id}>
                <Link
                  href={`/reports/${f.reportId}#reminders`}
                  className="flex flex-col gap-1 rounded-lg py-3 text-sm hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-civic-500"
                >
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{f.reportTitle}</span>
                    {f.reportStatus && statusFromDb[f.reportStatus] && <StatusBadge status={statusFromDb[f.reportStatus]} />}
                    <span className="text-xs text-foreground-muted">{timeAgo(f.sentAt)}</span>
                  </span>
                  <span className="text-xs text-foreground-muted">
                    <span className="font-semibold text-foreground">{f.title}:</span> {f.message}
                    {f.senderName && <> — {f.senderName} (Government)</>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {recent.length > 0 && (
        <div className="mt-6 rounded-2xl border border-border bg-white p-6">
          <h2 className="text-sm font-semibold text-foreground">Recently assigned</h2>
          <p className="mt-1 text-xs text-foreground-muted">The latest reports routed to you, newest first.</p>
          <ul className="mt-4 divide-y divide-border">
            {recent.map((issue) => (
              <li key={issue.id}>
                <Link
                  href={`/reports/${issue.id}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg py-3 text-sm hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-civic-500"
                >
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">{issue.title}</span>
                  <PriorityBadge priority={issue.priority} />
                  <StatusBadge status={issue.status} />
                  {issue.assignedAt && (
                    <span className="text-xs text-foreground-muted">Assigned {timeAgo(issue.assignedAt).toLowerCase()}</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {stats.assigned > 0 && (
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-border bg-white p-6">
            <h2 className="text-sm font-semibold text-foreground">Issue Aging</h2>
            <p className="mt-1 text-xs text-foreground-muted">How long your currently-pending reports have been waiting.</p>
            <div className="mt-4">
              <AgingBucketsChart buckets={aging} />
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-white p-6">
            <h2 className="text-sm font-semibold text-foreground">Resolution Quality</h2>
            <div className="mt-4">
              <ResolutionQualityCard quality={resolutionQuality} />
            </div>
          </div>
        </div>
      )}

      {incidents.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-foreground">Civic Incidents</h2>
          <p className="mt-1 text-xs text-foreground-muted">
            Reports assigned to you that are grouped with others describing the same real-world problem —
            resolve the incident once instead of report-by-report.
          </p>
          <div className="mt-4">
            <IncidentsSection incidents={incidents} />
          </div>
        </div>
      )}

      <div className="mt-6">
        <IssueListFilterBar basePath="/department" filters={filters} />
      </div>

      {stats.assigned === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={<ClipboardList className="h-5 w-5" aria-hidden="true" />}
            title="No reports assigned yet"
            description="Reports routed to your department will appear here."
          />
        </div>
      ) : paged.items.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={<ClipboardList className="h-5 w-5" aria-hidden="true" />}
            title="No reports match these filters"
            description="Try clearing a filter or searching for something else."
          />
        </div>
      ) : (
        <>
          <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {paged.items.map((issue) => (
              <IssueCard key={issue.id} issue={issue} showWorkflowMeta />
            ))}
          </div>
          <IssueListPagination
            basePath="/department"
            query={params}
            page={paged.page}
            totalPages={paged.totalPages}
            totalCount={paged.totalCount}
            pageSize={paged.pageSize}
          />
        </>
      )}
    </div>
  );
}
