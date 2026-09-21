import type { ResolutionQuality } from "@/lib/data/government";

/**
 * Factual resolution-quality counts (Phase 6E §7/§9), built from Phase 6D's
 * resolution_feedback/reopened_at (get_resolution_quality(), migration
 * 0013). Deliberately no interpretive language, no "this department is
 * underperforming" — presented exactly as the spec's own example does.
 */
export function ResolutionQualityCard({ quality }: { quality: ResolutionQuality | null }) {
  if (!quality) {
    return <p className="text-sm text-foreground-muted">Not enough data to calculate resolution quality.</p>;
  }

  const rows: Array<{ label: string; value: number }> = [
    { label: "Resolved", value: quality.resolved },
    { label: "Citizen confirmed", value: quality.citizenConfirmed },
    { label: "Confirmation pending", value: quality.confirmationPending },
    { label: "Citizen reported unresolved (currently reopened)", value: quality.currentlyReopened },
  ];

  return (
    <div>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="text-xs font-medium text-foreground-muted">{row.label}</dt>
            <dd className="mt-1 text-xl font-semibold text-foreground">{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-xs text-foreground-muted">
        {quality.reopenedTotalEver === 0
          ? "No report has ever been reopened."
          : `${quality.reopenedTotalEver} report${quality.reopenedTotalEver === 1 ? " has" : "s have"} been reopened at least once (${quality.reopenedPercentage}% of ever-resolved reports).`}
      </p>
    </div>
  );
}
