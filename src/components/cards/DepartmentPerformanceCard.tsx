import type { DepartmentPerformance } from "@/lib/types";

/**
 * One department's resolution rate as a neutral bar — a single colour for
 * every department (G8 removed the old 85% green/amber split, which implied
 * a pass/fail judgment no real target backs). No period comparison exists
 * for this aggregate, so the change column is an explicit "—" rather than a
 * number.
 */
export function DepartmentPerformanceCard({ department }: { department: DepartmentPerformance }) {
  return (
    <div className="flex min-w-0 items-center gap-2 py-3 sm:gap-4" data-testid="department-performance-row">
      <span className="w-16 shrink-0 truncate text-sm font-medium text-foreground sm:w-28">
        {department.name}
      </span>
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-muted">
        <div
          className="h-full rounded-full bg-civic-500"
          style={{ width: `${department.resolutionRate}%` }}
          role="img"
          aria-label={`${department.name}: ${department.resolutionRate}% resolved`}
        />
      </div>
      <span className="w-9 shrink-0 text-right text-sm font-semibold text-foreground sm:w-12">
        {department.resolutionRate}%
      </span>
      <span
        className="w-11 shrink-0 text-center text-xs font-medium text-foreground-muted sm:w-14"
        title="No period-over-period comparison available"
        aria-label="No period-over-period comparison available"
        data-testid="department-trend"
      >
        —
      </span>
    </div>
  );
}
