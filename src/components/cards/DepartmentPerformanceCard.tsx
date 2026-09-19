import { TrendingDown, TrendingUp } from "lucide-react";
import type { DepartmentPerformance } from "@/lib/types";
import { cn } from "@/lib/utils";

export function DepartmentPerformanceCard({ department }: { department: DepartmentPerformance }) {
  const trendUp = department.trend >= 0;
  return (
    <div className="flex min-w-0 items-center gap-2 py-3 sm:gap-4">
      <span className="w-16 shrink-0 truncate text-sm font-medium text-foreground sm:w-28">
        {department.name}
      </span>
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-muted">
        <div
          className={cn(
            "h-full rounded-full",
            department.resolutionRate >= 85 ? "bg-civic-500" : "bg-priority-medium",
          )}
          style={{ width: `${department.resolutionRate}%` }}
        />
      </div>
      <span className="w-9 shrink-0 text-right text-sm font-semibold text-foreground sm:w-12">
        {department.resolutionRate}%
      </span>
      <span
        className={cn(
          "flex w-11 shrink-0 items-center gap-0.5 text-xs font-semibold sm:w-14",
          trendUp ? "text-civic-600" : "text-priority-critical",
        )}
      >
        {trendUp ? (
          <TrendingUp className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <TrendingDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        {trendUp ? "+" : ""}
        {department.trend}%
      </span>
    </div>
  );
}
