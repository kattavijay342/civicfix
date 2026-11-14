import { categoryLabels } from "@/lib/categories";
import type { CategoryTrendsWithComparison } from "@/lib/data/government";

/**
 * "Reports by category" (Phase 6E §16) for the last N days, with the
 * previous N days beside it (G8) — both from the existing
 * get_category_trends() (migration 0013), real database records only, no
 * predictive claims. If the previous-period call failed, the current period
 * still renders and the comparison column says it is unavailable.
 */
export function CategoryTrendsChart({ data, days }: { data: CategoryTrendsWithComparison; days: number }) {
  if (data.current === null) {
    return <p className="text-sm text-foreground-muted">Not enough data to calculate category trends.</p>;
  }

  const rows =
    data.comparison ?? data.current.map((t) => ({ category: t.category, current: t.count, previous: null as number | null }));
  if (rows.length === 0) {
    return (
      <p className="text-sm text-foreground-muted">No reports in the last {data.comparison ? days * 2 : days} days.</p>
    );
  }

  const max = Math.max(1, ...rows.map((t) => Math.max(t.current, t.previous ?? 0)));
  const currentLabel = `Last ${days} days`;
  const previousLabel = `Previous ${days} days (${days + 1}–${days * 2} days ago)`;

  return (
    <div data-testid="category-trends">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-medium text-foreground-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-full bg-civic-600" aria-hidden="true" />
          {currentLabel}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-full bg-civic-200" aria-hidden="true" />
          {previousLabel}
        </span>
      </div>
      <div className="mt-3 flex flex-col gap-3">
        {rows.map((t) => (
          <div key={t.category} className="flex items-center gap-3 text-sm" data-testid="category-trend-row">
            <span className="w-32 shrink-0 truncate font-medium text-foreground">{categoryLabels[t.category]}</span>
            <div className="flex flex-1 flex-col gap-1">
              <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
                <div
                  className="h-full rounded-full bg-civic-600"
                  style={{ width: `${Math.round((t.current / max) * 100)}%` }}
                  role="img"
                  aria-label={`${categoryLabels[t.category]}, ${currentLabel}: ${t.current} reports`}
                />
              </div>
              {t.previous !== null && (
                <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
                  <div
                    className="h-full rounded-full bg-civic-200"
                    style={{ width: `${Math.round((t.previous / max) * 100)}%` }}
                    role="img"
                    aria-label={`${categoryLabels[t.category]}, ${previousLabel}: ${t.previous} reports`}
                  />
                </div>
              )}
            </div>
            <span className="w-14 shrink-0 text-right text-xs font-semibold text-foreground">
              {t.current}
              <span className="font-normal text-foreground-muted"> / {t.previous ?? "—"}</span>
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-foreground-muted">
        {data.comparison === null
          ? `Previous-period comparison unavailable. ${currentLabel}: ${rows.map((t) => `${categoryLabels[t.category]} ${t.current}`).join(", ")}.`
          : rows
              .map((t) => `${categoryLabels[t.category]}: ${t.current} in the last ${days} days, ${t.previous} in the previous ${days}`)
              .join(". ") + "."}
      </p>
    </div>
  );
}
