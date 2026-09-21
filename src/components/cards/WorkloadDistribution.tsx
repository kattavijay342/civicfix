import type { DepartmentWorkload } from "@/lib/data/government";

/**
 * Neutral operational workload view (Phase 6E §10) — deliberately NOT
 * sorted into a ranking and NEVER labeled "Best"/"Worst"/"Top Performing"
 * (spec §8/§41). Departments are shown in the same stable order the SQL
 * function returns them (alphabetical), not by active-issue count.
 */
export function WorkloadDistribution({ workload }: { workload: DepartmentWorkload[] }) {
  if (workload.length === 0) {
    return <p className="text-sm text-foreground-muted">No department workload data available.</p>;
  }

  const maxActive = Math.max(1, ...workload.map((d) => d.activeIssues));

  return (
    <div className="flex flex-col gap-3">
      {workload.map((d) => (
        <div key={d.departmentId} className="flex items-center gap-3 text-sm">
          <span className="w-36 shrink-0 truncate font-medium text-foreground">{d.name}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-muted">
            <div
              className="h-full rounded-full bg-civic-500"
              style={{ width: `${Math.round((d.activeIssues / maxActive) * 100)}%` }}
              role="img"
              aria-label={`${d.name}: ${d.activeIssues} active issues`}
            />
          </div>
          <span className="w-10 shrink-0 text-right text-xs font-semibold text-foreground">{d.activeIssues}</span>
        </div>
      ))}
      <p className="mt-1 text-xs text-foreground-muted">
        {workload.map((d) => `${d.name}: ${d.activeIssues} active issue${d.activeIssues === 1 ? "" : "s"}`).join(". ")}.
      </p>
    </div>
  );
}
