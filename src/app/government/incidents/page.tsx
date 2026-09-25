import type { Metadata } from "next";
import { AlertOctagon } from "lucide-react";
import { IncidentCard } from "@/components/cards/IncidentCard";
import { IncidentListFilterBar } from "@/components/cards/IncidentListControls";
import { IssueListPagination } from "@/components/cards/IssueListControls";
import { EmptyState } from "@/components/ui/EmptyState";
import { requireRole } from "@/lib/supabase/server";
import { getIncidentList, getIncidentDepartments } from "@/lib/data/incidents";
import type { IncidentListFilters, IssueStatus, Priority, ProblemCategory } from "@/lib/types";

export const metadata: Metadata = {
  title: "Civic Incidents — CivicFix",
};

const PAGE_SIZE = 20;

export default async function IncidentsListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole(["government", "department_incharge", "admin"]);

  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? "1") || 1);
  const filters: IncidentListFilters = {
    status: (params.status as IssueStatus) || undefined,
    priority: (params.priority as Priority) || undefined,
    category: (params.category as ProblemCategory) || undefined,
    department: params.department || undefined,
    dateFrom: params.dateFrom || undefined,
    dateTo: params.dateTo || undefined,
  };

  const [allIncidents, departments] = await Promise.all([getIncidentList(filters), getIncidentDepartments()]);

  const totalCount = allIncidents.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const items = allIncidents.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <div className="bg-surface-muted">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
        <span className="text-sm font-semibold text-civic-700">Civic Incident Intelligence</span>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Civic Incidents</h1>
        <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
          Groups of citizen reports that likely describe the same real-world civic problem, so a department can
          resolve it once instead of report-by-report. Each incident links back to every underlying report.
        </p>

        <div className="mt-6">
          <IncidentListFilterBar basePath="/government/incidents" filters={filters} departments={departments} />
        </div>

        {totalCount === 0 ? (
          <div className="mt-8">
            <EmptyState
              icon={<AlertOctagon className="h-5 w-5" aria-hidden="true" />}
              title="No civic incidents yet"
              description="Incidents are created automatically when multiple citizen reports strongly indicate the same real-world problem. Nothing has cleared that bar yet within what you're authorized to see."
            />
          </div>
        ) : (
          <>
            <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((incident) => (
                <IncidentCard key={incident.id} incident={incident} />
              ))}
            </div>
            <IssueListPagination
              basePath="/government/incidents"
              query={params}
              page={currentPage}
              totalPages={totalPages}
              totalCount={totalCount}
              pageSize={PAGE_SIZE}
            />
          </>
        )}
      </div>
    </div>
  );
}
