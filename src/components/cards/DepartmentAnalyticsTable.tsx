import type { DepartmentPerformance } from "@/lib/types";

export function DepartmentAnalyticsTable({ departments }: { departments: DepartmentPerformance[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-white">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs font-semibold uppercase tracking-wide text-foreground-muted">
            <th className="px-5 py-3">Department</th>
            <th className="px-5 py-3">Total</th>
            <th className="px-5 py-3">Resolved</th>
            <th className="px-5 py-3">Pending</th>
            <th className="px-5 py-3">Resolution Rate</th>
            <th className="px-5 py-3">On-Time Rate</th>
            <th className="px-5 py-3">Avg. Resolution Time</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {departments.map((d) => (
            <tr key={d.name}>
              <td className="px-5 py-3 font-medium text-foreground">{d.name}</td>
              <td className="px-5 py-3 text-foreground-muted">{d.totalIssues}</td>
              <td className="px-5 py-3 text-foreground-muted">{d.resolvedIssues}</td>
              <td className="px-5 py-3 text-foreground-muted">{d.pendingIssues}</td>
              <td className="px-5 py-3 font-semibold text-civic-700">{d.resolutionRate}%</td>
              <td className="px-5 py-3 text-xs text-foreground-muted">
                {d.onTimeRate === null ? "No configured SLA" : `${d.onTimeRate}%`}
              </td>
              <td className="px-5 py-3 text-foreground-muted">{d.avgResolutionDays.toFixed(1)} days</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
