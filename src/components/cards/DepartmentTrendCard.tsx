"use client";

import { useState } from "react";
import type { DepartmentTrend, DepartmentTrendsByPeriod } from "@/lib/data/government";

const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];

function TrendTable({ trend }: { trend: DepartmentTrend[] }) {
  if (trend.length === 0 || trend.every((d) => d.received === 0 && d.resolved === 0 && d.reopened === 0 && d.active === 0)) {
    return <p className="text-sm text-foreground-muted">Not enough historical data for this period.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs font-semibold uppercase tracking-wide text-foreground-muted">
            <th className="py-2 pr-3">Department</th>
            <th className="py-2 pr-3">Received</th>
            <th className="py-2 pr-3">Resolved</th>
            <th className="py-2 pr-3">Reopened</th>
            <th className="py-2 pr-3">Active</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {trend.map((d) => (
            <tr key={d.departmentId}>
              <td className="py-2 pr-3 font-medium text-foreground">{d.name}</td>
              <td className="py-2 pr-3 text-foreground-muted">{d.received}</td>
              <td className="py-2 pr-3 text-foreground-muted">{d.resolved}</td>
              <td className="py-2 pr-3 text-foreground-muted">{d.reopened}</td>
              <td className="py-2 pr-3 text-foreground-muted">{d.active}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Department Trend over time (Phase 6E §9) — all three periods are already
 * fetched server-side (get_department_trend(), migration 0013, called for
 * 7/30/90 in one Promise.all — src/lib/data/government.ts's
 * getDepartmentTrends()), so this toggle is instant and needs no refetch.
 */
export function DepartmentTrendCard({ trends }: { trends: DepartmentTrendsByPeriod }) {
  const [period, setPeriod] = useState<Period>(7);

  return (
    <div>
      <div className="flex items-center gap-1.5" role="group" aria-label="Select time period">
        {PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            aria-pressed={period === p}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              period === p ? "bg-civic-600 text-white" : "bg-surface-muted text-foreground-muted hover:text-foreground"
            }`}
          >
            {p} days
          </button>
        ))}
      </div>
      <div className="mt-4">
        <TrendTable trend={trends[period]} />
      </div>
    </div>
  );
}
