import Link from "next/link";
import { statusLabels } from "@/components/ui/StatusBadge";
import { categoryLabels, categoryOrder } from "@/lib/categories";
import type { IncidentListFilters } from "@/lib/types";

const priorityOrder = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
const priorityLabels: Record<string, string> = { CRITICAL: "Critical", HIGH: "High", MEDIUM: "Medium", LOW: "Low" };
// Only the statuses an incident can actually display (src/lib/incident-status.ts)
// — REPORTED/AI_ANALYZED/ACKNOWLEDGED never apply at the incident level.
const statusOrder = ["ROUTED", "IN_PROGRESS", "RESOLVED", "REOPENED"] as const;

const selectClass =
  "min-h-10 rounded-lg border border-border bg-white px-3 py-2 text-xs font-medium text-foreground focus-visible:border-civic-400";

/** Server-rendered filter bar for the incident list, same pattern as
 * IssueListFilterBar (src/components/cards/IssueListControls.tsx) — a
 * plain GET form so filters live in the URL and the page works with JS
 * disabled. */
export function IncidentListFilterBar({
  basePath,
  filters,
  departments,
}: {
  basePath: string;
  filters: IncidentListFilters;
  departments: { id: string; name: string }[];
}) {
  const hasAnyFilter = !!(filters.status || filters.priority || filters.category || filters.department || filters.dateFrom || filters.dateTo);

  return (
    <form method="get" action={basePath} className="flex flex-wrap items-center gap-2">
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
      <select name="department" aria-label="Filter by department" defaultValue={filters.department ?? ""} className={selectClass}>
        <option value="">All Departments</option>
        {departments.map((d) => (
          <option key={d.id} value={d.name}>
            {d.name}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1.5 text-xs font-medium text-foreground-muted">
        From
        <input type="date" name="dateFrom" aria-label="From date" defaultValue={filters.dateFrom ?? ""} className={selectClass} />
      </label>
      <label className="flex items-center gap-1.5 text-xs font-medium text-foreground-muted">
        To
        <input type="date" name="dateTo" aria-label="To date" defaultValue={filters.dateTo ?? ""} className={selectClass} />
      </label>
      <button type="submit" className="min-h-10 rounded-lg bg-civic-600 px-4 py-2 text-xs font-semibold text-white hover:bg-civic-700">
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
