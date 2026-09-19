"use client";

import { useMemo, useState } from "react";
import { ListChecks, CheckCircle2, Clock, AlertOctagon, TrendingUp, MapPinned } from "lucide-react";
import { DashboardStat } from "@/components/cards/DashboardStat";
import { SortablePendingIssues } from "@/components/cards/SortablePendingIssues";
import { EmptyState } from "@/components/ui/EmptyState";
import { stateNames, getDistricts, getConstituencies, getAreas } from "@/lib/jurisdiction";
import type { CivicIssue } from "@/lib/types";
import { cn } from "@/lib/utils";

interface JurisdictionExplorerProps {
  issues: CivicIssue[];
  fallbackOverview: {
    totalIssues: number;
    resolved: number;
    pending: number;
    critical: number;
    resolutionRate: number;
  };
}

function computeStats(issues: CivicIssue[]) {
  const totalIssues = issues.length;
  const resolved = issues.filter((i) => i.status === "RESOLVED").length;
  const pending = totalIssues - resolved;
  const critical = issues.filter((i) => i.priority === "CRITICAL").length;
  const highPriority = issues.filter((i) => i.priority === "HIGH").length;
  const resolutionRate = totalIssues ? Math.round((resolved / totalIssues) * 100) : 0;
  return { totalIssues, resolved, pending, critical, highPriority, resolutionRate };
}

export function JurisdictionExplorer({ issues, fallbackOverview }: JurisdictionExplorerProps) {
  const [state, setState] = useState("");
  const [district, setDistrict] = useState("");
  const [constituency, setConstituency] = useState("");
  const [area, setArea] = useState("");

  const districtOptions = useMemo(() => getDistricts(state), [state]);
  const constituencyOptions = useMemo(() => getConstituencies(state, district), [state, district]);
  const areaOptions = useMemo(() => getAreas(state, district, constituency), [state, district, constituency]);

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
  const stats = hasFilter ? computeStats(filteredIssues) : null;

  const selectClass =
    "rounded-lg border border-border bg-white px-3 py-2 text-xs font-medium text-foreground focus-visible:border-civic-400 disabled:cursor-not-allowed disabled:opacity-50";

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
            {stateNames.map((s) => (
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
              className="rounded-lg px-3 py-2 text-xs font-medium text-civic-700 hover:bg-civic-50"
            >
              Clear
            </button>
          )}
        </div>
        <p className="mt-3 text-[11px] text-foreground-muted">
          {hasFilter
            ? `Showing sample issues matching ${[area, constituency, district, state].filter(Boolean).join(", ")}.`
            : "Demo jurisdiction list for Andhra Pradesh and Telangana only — select a state to filter issues by area."}
        </p>
      </div>

      <div className={cn("mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2", stats ? "lg:grid-cols-5" : "lg:grid-cols-5")}>
        <DashboardStat
          icon={ListChecks}
          label="Total Issues"
          value={String(stats ? stats.totalIssues : fallbackOverview.totalIssues)}
        />
        <DashboardStat
          icon={CheckCircle2}
          label="Resolved"
          value={String(stats ? stats.resolved : fallbackOverview.resolved)}
        />
        <DashboardStat
          icon={Clock}
          label="Pending"
          value={String(stats ? stats.pending : fallbackOverview.pending)}
        />
        <DashboardStat
          icon={AlertOctagon}
          label="Critical"
          value={String(stats ? stats.critical : fallbackOverview.critical)}
        />
        <DashboardStat
          icon={TrendingUp}
          label="Overall Resolution Rate"
          value={`${stats ? stats.resolutionRate : fallbackOverview.resolutionRate}%`}
          tone="civic"
        />
      </div>
      {hasFilter && (
        <p className="mt-2 text-[11px] text-foreground-muted">
          Computed from {filteredIssues.length} sample issue{filteredIssues.length === 1 ? "" : "s"} in this
          area — not a live jurisdiction-wide aggregate.
        </p>
      )}

      <div className="mt-8">
        <h2 className="text-lg font-semibold text-foreground">Pending Issues</h2>
        <div className="mt-4">
          {pendingIssues.length > 0 ? (
            <SortablePendingIssues issues={pendingIssues} />
          ) : (
            <EmptyState
              title="No pending issues for this area"
              description={
                hasFilter
                  ? "No sample issues match this jurisdiction filter. Try a broader area or clear the filter."
                  : "There are currently no pending issues in the sample data."
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
