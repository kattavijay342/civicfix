import type { Metadata } from "next";
import { ClipboardList, ListChecks, Loader2, CheckCircle2 } from "lucide-react";
import { IssueCard } from "@/components/cards/IssueCard";
import { DashboardStat } from "@/components/cards/DashboardStat";
import { AgingBucketsChart } from "@/components/cards/AgingBucketsChart";
import { ResolutionQualityCard } from "@/components/cards/ResolutionQualityCard";
import { IncidentsSection } from "@/components/cards/IncidentsSection";
import { EmptyState } from "@/components/ui/EmptyState";
import { IssueListFilterBar, IssueListPagination } from "@/components/cards/IssueListControls";
import { requireRole } from "@/lib/supabase/server";
import { getAssignedIssuesPage, getAssignedIssueStats } from "@/lib/data/department";
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
  const [stats, paged, aging, resolutionQuality, incidents] = await Promise.all([
    getAssignedIssueStats(session.user.id),
    getAssignedIssuesPage(session.user.id, page, filters),
    getAgingBuckets(),
    getResolutionQuality(),
    getIncidentList(),
  ]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
      <span className="text-sm font-semibold text-civic-700">Department In-charge</span>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Assigned Reports</h1>
      <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
        Reports routed to you. Update status, add action notes, and submit resolution evidence.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <DashboardStat icon={ListChecks} label="Assigned" value={String(stats.assigned)} tone="civic" />
        <DashboardStat icon={Loader2} label="In Progress" value={String(stats.inProgress)} />
        <DashboardStat icon={CheckCircle2} label="Resolved" value={String(stats.resolved)} />
      </div>

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
              <IssueCard key={issue.id} issue={issue} />
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
