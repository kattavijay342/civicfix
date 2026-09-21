import Link from "next/link";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { statusLabels } from "@/components/ui/StatusBadge";
import { categoryLabels, categoryOrder } from "@/lib/categories";
import type { IssueListFilters } from "@/lib/types";

const priorityOrder = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
const priorityLabels: Record<string, string> = { CRITICAL: "Critical", HIGH: "High", MEDIUM: "Medium", LOW: "Low" };
const statusOrder = [
  "REPORTED",
  "AI_ANALYZED",
  "ROUTED",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "RESOLVED",
  "REOPENED",
] as const;

const selectClass =
  "min-h-10 rounded-lg border border-border bg-white px-3 py-2 text-xs font-medium text-foreground focus-visible:border-civic-400";

/**
 * Server-rendered (no client JS required) filter bar for a paginated issue
 * list (Phase 4 Step 7). A plain GET form — filters live entirely in the
 * URL, so the resulting page is bookmarkable/shareable and works with JS
 * disabled.
 */
export function IssueListFilterBar({
  basePath,
  filters,
  departments,
}: {
  basePath: string;
  filters: IssueListFilters;
  /** Phase 6E — only passed on the government issue explorer, which can
   * see reports across departments; omit elsewhere to hide this filter. */
  departments?: { id: string; name: string }[];
}) {
  const hasAnyFilter = !!(
    filters.status ||
    filters.priority ||
    filters.category ||
    filters.search ||
    filters.department ||
    filters.dateFrom ||
    filters.dateTo
  );

  return (
    <form method="get" action={basePath} className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-muted"
          aria-hidden="true"
        />
        <input
          type="search"
          name="q"
          aria-label="Search title or description"
          defaultValue={filters.search ?? ""}
          placeholder="Search title or description"
          className="min-h-10 w-56 rounded-lg border border-border bg-white py-2 pl-8 pr-3 text-xs font-medium text-foreground focus-visible:border-civic-400"
        />
      </div>
      <select name="status" aria-label="Filter by status" defaultValue={filters.status ?? ""} className={selectClass}>
        <option value="">All Statuses</option>
        {statusOrder.map((s) => (
          <option key={s} value={s}>
            {statusLabels[s]}
          </option>
        ))}
      </select>
      <select name="priority" aria-label="Filter by priority" defaultValue={filters.priority ?? ""} className={selectClass}>
        <option value="">All Priorities</option>
        {priorityOrder.map((p) => (
          <option key={p} value={p}>
            {priorityLabels[p]}
          </option>
        ))}
      </select>
      <select name="category" aria-label="Filter by category" defaultValue={filters.category ?? ""} className={selectClass}>
        <option value="">All Categories</option>
        {categoryOrder.map((c) => (
          <option key={c} value={c}>
            {categoryLabels[c]}
          </option>
        ))}
      </select>
      {departments && (
        <select name="department" aria-label="Filter by department" defaultValue={filters.department ?? ""} className={selectClass}>
          <option value="">All Departments</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      )}
      {departments && (
        <>
          <label className="flex items-center gap-1.5 text-xs font-medium text-foreground-muted">
            From
            <input type="date" name="dateFrom" aria-label="From date" defaultValue={filters.dateFrom ?? ""} className={selectClass} />
          </label>
          <label className="flex items-center gap-1.5 text-xs font-medium text-foreground-muted">
            To
            <input type="date" name="dateTo" aria-label="To date" defaultValue={filters.dateTo ?? ""} className={selectClass} />
          </label>
        </>
      )}
      <button
        type="submit"
        className="min-h-10 rounded-lg bg-civic-600 px-4 py-2 text-xs font-semibold text-white hover:bg-civic-700"
      >
        Apply
      </button>
      {hasAnyFilter && (
        <Link href={basePath} className="text-xs font-medium text-civic-700 hover:underline">
          Clear filters
        </Link>
      )}
    </form>
  );
}

function hrefForPage(basePath: string, currentQuery: Record<string, string | undefined>, page: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(currentQuery)) {
    if (value) params.set(key, value);
  }
  params.set("page", String(page));
  return `${basePath}?${params.toString()}`;
}

export function IssueListPagination({
  basePath,
  query,
  page,
  totalPages,
  totalCount,
  pageSize,
}: {
  basePath: string;
  query: Record<string, string | undefined>;
  page: number;
  totalPages: number;
  totalCount: number;
  pageSize: number;
}) {
  const from = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalCount);

  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <p className="text-xs text-foreground-muted">
        {totalCount === 0 ? "No results" : `Showing ${from}–${to} of ${totalCount}`}
      </p>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link
            href={hrefForPage(basePath, query, page - 1)}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-white px-3 py-1.5 text-xs font-medium text-foreground hover:border-civic-300"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Previous
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground-muted/50">
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Previous
          </span>
        )}
        <span className="text-xs font-medium text-foreground-muted">
          Page {page} of {totalPages}
        </span>
        {page < totalPages ? (
          <Link
            href={hrefForPage(basePath, query, page + 1)}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-white px-3 py-1.5 text-xs font-medium text-foreground hover:border-civic-300"
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground-muted/50">
            Next
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        )}
      </div>
    </div>
  );
}
