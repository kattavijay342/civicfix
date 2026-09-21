import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ArrowRight, FileEdit } from "lucide-react";
import { CTAButton } from "@/components/ui/CTAButton";
import { IssueCard } from "@/components/cards/IssueCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { IssueListFilterBar, IssueListPagination } from "@/components/cards/IssueListControls";
import { getSessionProfile } from "@/lib/supabase/server";
import { getCitizenIssuesPage } from "@/lib/data/citizen";
import type { IssueListFilters, IssueStatus, Priority, ProblemCategory } from "@/lib/types";

export const metadata: Metadata = {
  title: "My Reports — CivicFix",
};

export default async function MyReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/sign-in");

  const params = await searchParams;
  const page = Number(params.page ?? "1") || 1;
  const filters: IssueListFilters = {
    status: (params.status as IssueStatus) || undefined,
    priority: (params.priority as Priority) || undefined,
    category: (params.category as ProblemCategory) || undefined,
    search: params.q || undefined,
  };

  const paged = await getCitizenIssuesPage(session.user.id, page, filters);

  return (
    <div>
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            My Reports
          </h1>
          <p className="mt-1 text-sm text-foreground-muted">
            Every issue you&apos;ve reported, in one place.
          </p>
        </div>
        <CTAButton href="/report" icon={<ArrowRight className="h-4 w-4" />}>
          Report a Problem
        </CTAButton>
      </div>

      <div className="mt-6">
        <IssueListFilterBar basePath="/dashboard/reports" filters={filters} />
      </div>

      {paged.totalCount === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={<FileEdit className="h-5 w-5" aria-hidden="true" />}
            title="No reports yet"
            description="Reports you submit will appear here so you can track their status."
            action={<CTAButton href="/report">Report a Problem</CTAButton>}
          />
        </div>
      ) : paged.items.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={<FileEdit className="h-5 w-5" aria-hidden="true" />}
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
            basePath="/dashboard/reports"
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
