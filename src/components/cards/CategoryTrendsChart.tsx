import { categoryLabels } from "@/lib/categories";
import type { CategoryTrend } from "@/lib/data/government";

/**
 * "Reports by category — last N days" (Phase 6E §16), from
 * get_category_trends() (migration 0013) — real database records only, no
 * predictive claims.
 */
export function CategoryTrendsChart({ trends, days }: { trends: CategoryTrend[] | null; days: number }) {
  if (trends === null) {
    return <p className="text-sm text-foreground-muted">Not enough data to calculate category trends.</p>;
  }
  if (trends.length === 0) {
    return <p className="text-sm text-foreground-muted">No reports in the last {days} days.</p>;
  }

  const max = Math.max(...trends.map((t) => t.count));

  return (
    <div>
      <p className="text-xs font-medium text-foreground-muted">Reports by category — last {days} days</p>
      <div className="mt-3 flex flex-col gap-2">
        {trends.map((t) => (
          <div key={t.category} className="flex items-center gap-3 text-sm">
            <span className="w-32 shrink-0 truncate font-medium text-foreground">{categoryLabels[t.category]}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-muted">
              <div
                className="h-full rounded-full bg-civic-500"
                style={{ width: `${Math.round((t.count / max) * 100)}%` }}
                role="img"
                aria-label={`${categoryLabels[t.category]}: ${t.count} reports`}
              />
            </div>
            <span className="w-8 shrink-0 text-right text-xs font-semibold text-foreground">{t.count}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-foreground-muted">
        {trends.map((t) => `${categoryLabels[t.category]}: ${t.count}`).join(". ")}.
      </p>
    </div>
  );
}
