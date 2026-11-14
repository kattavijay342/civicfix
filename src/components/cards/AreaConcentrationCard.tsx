import type { AreaBreakdownRow } from "@/lib/government-analytics";

function placeLabel(row: AreaBreakdownRow): { primary: string; secondary: string } {
  const levels = [row.area, row.constituency, row.district, row.state];
  const known = levels.filter((v): v is string => !!v);
  if (known.length === 0) return { primary: "Location not recorded", secondary: "" };
  return { primary: known[0], secondary: known.slice(1).join(", ") };
}

/**
 * G8 — where issues are, per stored location, from get_area_breakdown()
 * (migration 0018). Descriptive counts only: rows keep the SQL function's
 * alphabetical place order, never sorted or labeled as best/worst. The bar
 * shows each place's share of the largest total so concentration is
 * visible without implying a ranking.
 */
export function AreaConcentrationCard({ rows }: { rows: AreaBreakdownRow[] | null }) {
  if (rows === null) {
    return <p className="text-sm text-foreground-muted">Area breakdown is unavailable right now.</p>;
  }
  if (rows.length === 0) {
    return <p className="text-sm text-foreground-muted">No issues in your jurisdiction yet.</p>;
  }

  const maxTotal = Math.max(1, ...rows.map((r) => r.total));

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-sm" data-testid="area-breakdown">
        <thead>
          <tr className="border-b border-border text-xs font-semibold uppercase tracking-wide text-foreground-muted">
            <th className="py-2 pr-3">Location</th>
            <th className="py-2 pr-3">Total</th>
            <th className="py-2 pr-3">Pending</th>
            <th className="py-2 pr-3">Critical (open)</th>
            <th className="py-2 pr-3">Resolved</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => {
            const place = placeLabel(r);
            return (
              <tr key={[r.state, r.district, r.constituency, r.area].join("|")} data-testid="area-breakdown-row">
                <td className="py-2 pr-3">
                  <p className="font-medium text-foreground">{place.primary}</p>
                  {place.secondary && <p className="text-xs text-foreground-muted">{place.secondary}</p>}
                  <div className="mt-1 h-1.5 w-full max-w-48 overflow-hidden rounded-full bg-surface-muted">
                    <div
                      className="h-full rounded-full bg-civic-500"
                      style={{ width: `${Math.round((r.total / maxTotal) * 100)}%` }}
                      role="img"
                      aria-label={`${place.primary}: ${r.total} issue${r.total === 1 ? "" : "s"}`}
                    />
                  </div>
                </td>
                <td className="py-2 pr-3 font-semibold text-foreground">{r.total}</td>
                <td className="py-2 pr-3 text-foreground-muted">{r.pending}</td>
                <td className="py-2 pr-3 text-foreground-muted">{r.criticalOpen}</td>
                <td className="py-2 pr-3 text-foreground-muted">{r.resolved}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
