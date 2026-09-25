import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { IssueCard } from "@/components/cards/IssueCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { IssueListFilterBar, IssueListPagination } from "@/components/cards/IssueListControls";
import { requireRole } from "@/lib/supabase/server";
import { getGovernmentIssuesPage } from "@/lib/data/government";
import { getAllDepartments } from "@/lib/data/admin";
import type { IssueListFilters, IssueStatus, Priority, ProblemCategory } from "@/lib/types";

export const metadata: Metadata = {
  title: "All Issues — CivicFix",
};

/**
 * Real, server-side paginated view over every issue in the caller's
 * jurisdiction (Phase 4 Step 7) — the government dashboard's own issue
 * feed stays a bounded summary widget; this is the complete, filterable
 * list so nothing is silently truncated at scale.
 */
export default async function GovernmentAllIssuesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole(["government", "admin"]);

  const params = await searchParams;
  const page = Number(params.page ?? "1") || 1;
  const filters: IssueListFilters = {
    status: (params.status as IssueStatus) || undefined,
    priority: (params.priority as Priority) || undefined,
    category: (params.category as ProblemCategory) || undefined,
    search: params.q || undefined,
    department: params.department || undefined,
    dateFrom: params.dateFrom || undefined,
    dateTo: params.dateTo || undefined,
  };

  const [paged, departments] = await Promise.all([getGovernmentIssuesPage(page, filters), getAllDepartments()]);

  return (
    <div className="bg-surface-muted">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
        <Link
          href="/government"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to dashboard
        </Link>

        <div className="mt-4">
          <span className="text-sm font-semibold text-civic-700">Government Dashboard</span>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">All Issues</h1>
          <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
            Every issue in your jurisdiction, paginated and filterable — nothing is capped or hidden here.
          </p>
        </div>

        <div className="mt-6">
          <IssueListFilterBar
            basePath="/government/issues"
            filters={filters}
            departments={departments.map((d) => ({ id: d.id, name: d.name }))}
          />
        </div>

        {paged.items.length === 0 ? (
          <div className="mt-8">
            <EmptyState
              title={paged.totalCount === 0 ? "No issues in your jurisdiction yet" : "No issues match these filters"}
              description={
                paged.totalCount === 0
                  ? "Reports from citizens in your configured area will appear here as they come in."
                  : "Try clearing a filter or searching for something else."
              }
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
              basePath="/government/issues"
              query={params}
              page={paged.page}
              totalPages={paged.totalPages}
              totalCount={paged.totalCount}
              pageSize={paged.pageSize}
            />
          </>
        )}
      </div>
    </div>
  );
}
