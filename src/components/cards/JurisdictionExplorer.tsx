"use client";

import { useMemo, useState } from "react";
import { ListChecks, CheckCircle2, Clock, AlertOctagon, TrendingUp, MapPinned } from "lucide-react";
import { DashboardStat } from "@/components/cards/DashboardStat";
import { SortablePendingIssues } from "@/components/cards/SortablePendingIssues";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  distinctLevelValues,
  rowsMatchingFilter,
  sumAreaBreakdown,
  type AreaBreakdownRow,
} from "@/lib/government-analytics";
import type { CivicIssue } from "@/lib/types";

interface JurisdictionExplorerProps {
  /** Most recent issues (bounded feed) — used ONLY for the pending-issue
   * list below, never for aggregate totals. */
  issues: CivicIssue[];
  /** Jurisdiction-wide totals from get_area_overview() / get_insight_metrics(). */
  fallbackOverview: {
    totalIssues: number;
    resolved: number;
    pending: number;
    critical: number | null;
    resolutionRate: number;
  };
  /** get_area_breakdown() rows (RLS-scoped). Filtered totals are summed
   * from these; null when the RPC is unavailable. */
  areaBreakdown: AreaBreakdownRow[] | null;
}

const dash = "—";

export function JurisdictionExplorer({ issues, fallbackOverview, areaBreakdown }: JurisdictionExplorerProps) {
  const [state, setState] = useState("");
  const [district, setDistrict] = useState("");
  const [constituency, setConstituency] = useState("");
  const [area, setArea] = useState("");

  // Display narrowing only: options and totals come from the caller's own
  // RLS-scoped breakdown, so no place outside the jurisdiction can appear.
  const rows = useMemo(() => areaBreakdown ?? [], [areaBreakdown]);
  const stateOptions = useMemo(() => distinctLevelValues(rows, "state", {}), [rows]);
  const districtOptions = useMemo(() => (state ? distinctLevelValues(rows, "district", { state }) : []), [rows, state]);
  const constituencyOptions = useMemo(
    () => (district ? distinctLevelValues(rows, "constituency", { state, district }) : []),
    [rows, state, district]
  );
  const areaOptions = useMemo(
    () => (constituency ? distinctLevelValues(rows, "area", { state, district, constituency }) : []),
    [rows, state, district, constituency]
  );

  const hasFilter = !!state;

  const filteredIssues = useMemo(() => {
    if (!hasFilter) return issues;
    return issues.filter((i) => {
      if (i.location.state !== state) return false;
      if (district && i.location.district !== district) return false;
      if (constituency && i.location.constituency !== constituency) return false;
      if (area && i.location.area !== area) return false;
      return true;
    });
  }, [issues, hasFilter, state, district, constituency, area]);

  const pendingIssues = filteredIssues.filter((i) => i.status !== "RESOLVED");
  const filter = { state, district, constituency, area };
  const filteredTotals = hasFilter && areaBreakdown ? sumAreaBreakdown(rowsMatchingFilter(areaBreakdown, filter)) : null;
  const shown = hasFilter
    ? filteredTotals
      ? {
          totalIssues: String(filteredTotals.totalIssues),
          resolved: String(filteredTotals.resolved),
          pending: String(filteredTotals.pending),
          critical: String(filteredTotals.criticalOpen),
          resolutionRate: `${filteredTotals.resolutionRate}%`,
        }
      : { totalIssues: dash, resolved: dash, pending: dash, critical: dash, resolutionRate: dash }
    : {
        totalIssues: String(fallbackOverview.totalIssues),
        resolved: String(fallbackOverview.resolved),
        pending: String(fallbackOverview.pending),
        critical: fallbackOverview.critical === null ? dash : String(fallbackOverview.critical),
        resolutionRate: `${fallbackOverview.resolutionRate}%`,
      };

  const selectClass =
    "min-h-10 rounded-lg border border-border bg-white px-3 py-2 text-xs font-medium text-foreground focus-visible:border-civic-400 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div>
      <div className="rounded-2xl border border-border bg-white p-5">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <MapPinned className="h-4 w-4 text-civic-700" aria-hidden="true" />
          Filter by Jurisdiction
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setDistrict("");
              setConstituency("");
              setArea("");
            }}
            className={selectClass}
          >
            <option value="">All States</option>
            {stateOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            value={district}
            disabled={!state}
            onChange={(e) => {
              setDistrict(e.target.value);
              setConstituency("");
              setArea("");
            }}
            className={selectClass}
          >
            <option value="">All Districts</option>
            {districtOptions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <select
            value={constituency}
            disabled={!district}
            onChange={(e) => {
              setConstituency(e.target.value);
              setArea("");
            }}
            className={selectClass}
          >
            <option value="">All Constituencies</option>
            {constituencyOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            value={area}
            disabled={!constituency}
            onChange={(e) => setArea(e.target.value)}
            className={selectClass}
          >
            <option value="">All Areas / Wards</option>
            {areaOptions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          {hasFilter && (
            <button
              type="button"
              onClick={() => {
                setState("");
                setDistrict("");
                setConstituency("");
                setArea("");
              }}
              className="min-h-10 rounded-lg px-3 py-2 text-xs font-medium text-civic-700 hover:bg-civic-50"
            >
              Clear
            </button>
          )}
        </div>
        <p className="mt-3 text-[11px] text-foreground-muted">
          {hasFilter
            ? `Showing issues matching ${[area, constituency, district, state].filter(Boolean).join(", ")}.`
            : areaBreakdown === null
              ? "Area filter unavailable right now — showing jurisdiction-wide totals."
              : "Only places that appear in your jurisdiction's reports are listed."}
        </p>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5" data-testid="overview-kpis">
        <DashboardStat icon={ListChecks} label="Total Issues" value={shown.totalIssues} />
        <DashboardStat icon={CheckCircle2} label="Resolved" value={shown.resolved} />
        <DashboardStat icon={Clock} label="Pending" value={shown.pending} />
        <DashboardStat icon={AlertOctagon} label="Critical (open)" value={shown.critical} />
        <DashboardStat icon={TrendingUp} label="Overall Resolution Rate" value={shown.resolutionRate} tone="civic" />
      </div>
      <p className="mt-2 text-[11px] text-foreground-muted">
        {hasFilter
          ? filteredTotals
            ? "Totals for this area filter, from all of its issues."
            : "Area totals unavailable right now."
          : "Pending includes reopened issues. Critical counts unresolved critical-priority issues only."}
      </p>

      <div className="mt-8">
        <h2 className="text-lg font-semibold text-foreground">Pending Issues</h2>
        <p className="mt-1 text-xs text-foreground-muted">From the {issues.length} most recent issues.</p>
        <div className="mt-4">
          {pendingIssues.length > 0 ? (
            <SortablePendingIssues issues={pendingIssues} />
          ) : (
            <EmptyState
              title="No pending issues for this area"
              description={
                hasFilter
                  ? "No issues match this jurisdiction filter. Try a broader area or clear the filter."
                  : "There are currently no pending issues in your jurisdiction."
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
