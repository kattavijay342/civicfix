"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MapPinOff, ShieldAlert } from "lucide-react";
import { statusLabels } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { categoryLabels } from "@/lib/categories";
import { isValidLatitude, isValidLongitude } from "@/lib/location/validation";
import { CivicMap } from "@/components/map/CivicMap";
import type { CivicMapIssueMarker } from "@/components/map/mapTypes";
import type { CivicIssue, IssueStatus, Priority, ProblemCategory } from "@/lib/types";
import { cn } from "@/lib/utils";

const selectClass =
  "min-h-9 rounded-lg border border-border bg-white px-2.5 py-1.5 text-xs font-medium text-foreground focus-visible:border-civic-400";

/** Below this many plotted issues, a heatmap/density layer wouldn't show
 * anything meaningful — a real message instead of a decorative fake one. */
const MIN_ISSUES_FOR_DENSITY = 5;

/**
 * Phase 6B, now on a real Mapbox map. Every marker position is genuinely
 * derived from that report's own stored latitude/longitude — never a hash
 * of the report id, and never a fabricated "zone." Reports without valid
 * coordinates (most manually-entered ones) simply aren't plotted, and
 * that's shown honestly rather than guessed at.
 */
export function MapPreview({ issues }: { issues: CivicIssue[] }) {
  const router = useRouter();
  const [priorityFilter, setPriorityFilter] = useState<Priority | "ALL">("ALL");
  const [statusFilter, setStatusFilter] = useState<IssueStatus | "ALL">("ALL");
  const [categoryFilter, setCategoryFilter] = useState<ProblemCategory | "ALL">("ALL");
  const [departmentFilter, setDepartmentFilter] = useState<string>("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const departmentOptions = useMemo(
    () => Array.from(new Set(issues.map((i) => i.department))).sort((a, b) => a.localeCompare(b)),
    [issues]
  );

  const fromTime = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
  const toTime = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : null;

  const filteredIssues = useMemo(
    () =>
      issues.filter((i) => {
        if (priorityFilter !== "ALL" && i.priority !== priorityFilter) return false;
        if (statusFilter !== "ALL" && i.status !== statusFilter) return false;
        if (categoryFilter !== "ALL" && i.category !== categoryFilter) return false;
        if (departmentFilter !== "ALL" && i.department !== departmentFilter) return false;
        const reportedTime = new Date(i.reportedDate).getTime();
        if (fromTime != null && reportedTime < fromTime) return false;
        if (toTime != null && reportedTime > toTime) return false;
        return true;
      }),
    [issues, priorityFilter, statusFilter, categoryFilter, departmentFilter, fromTime, toTime]
  );

  const plottableIssues = useMemo(
    () => filteredIssues.filter((i) => isValidLatitude(i.location.latitude) && isValidLongitude(i.location.longitude)),
    [filteredIssues]
  );

  const markers: CivicMapIssueMarker[] = useMemo(
    () =>
      plottableIssues.map((issue) => ({
        id: issue.id,
        latitude: issue.location.latitude as number,
        longitude: issue.location.longitude as number,
        priority: issue.priority,
        title: issue.title,
        statusLabel: statusLabels[issue.status],
        department: issue.department,
        reportedDateLabel: new Date(issue.reportedDate).toLocaleDateString(),
      })),
    [plottableIssues]
  );

  const showDensity = markers.length >= MIN_ISSUES_FOR_DENSITY;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setPriorityFilter((p) => (p === "CRITICAL" ? "ALL" : "CRITICAL"))}
          aria-pressed={priorityFilter === "CRITICAL"}
          className={cn(
            "inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition",
            priorityFilter === "CRITICAL"
              ? "border-priority-critical bg-priority-critical-bg text-priority-critical"
              : "border-border bg-white text-foreground-muted hover:border-priority-critical/40"
          )}
        >
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
          Critical Issues
        </button>
        <select
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value as Priority | "ALL")}
          className={selectClass}
          aria-label="Filter map by priority"
        >
          <option value="ALL">All Priorities</option>
          <option value="CRITICAL">Critical</option>
          <option value="HIGH">High</option>
          <option value="MEDIUM">Medium</option>
          <option value="LOW">Low</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as IssueStatus | "ALL")}
          className={selectClass}
          aria-label="Filter map by status"
        >
          <option value="ALL">All Statuses</option>
          {Object.entries(statusLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value as ProblemCategory | "ALL")}
          className={selectClass}
          aria-label="Filter map by category"
        >
          <option value="ALL">All Categories</option>
          {Object.entries(categoryLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {departmentOptions.length > 0 && (
          <select
            value={departmentFilter}
            onChange={(e) => setDepartmentFilter(e.target.value)}
            className={selectClass}
            aria-label="Filter map by department"
          >
            <option value="ALL">All Departments</option>
            {departmentOptions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}
        <label className="flex items-center gap-1.5 text-xs font-medium text-foreground-muted">
          From
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            aria-label="Filter map from date"
            className={selectClass}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs font-medium text-foreground-muted">
          To
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            aria-label="Filter map to date"
            className={selectClass}
          />
        </label>
      </div>

      {plottableIssues.length === 0 ? (
        <EmptyState
          icon={<MapPinOff className="h-5 w-5" aria-hidden="true" />}
          title="Not enough location data to generate this view"
          description={
            filteredIssues.length === 0
              ? "No issues match the selected filters."
              : `${filteredIssues.length} issue${filteredIssues.length === 1 ? "" : "s"} match the selected filters, but none have GPS coordinates recorded yet — most locations today are entered manually without a map pin.`
          }
        />
      ) : (
        <>
          <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-border sm:aspect-[16/9]">
            <CivicMap
              mode="multi"
              issues={markers}
              onViewIssue={(id) => router.push(`/reports/${id}`)}
              showDensity={showDensity}
              fitToIssues
            />
          </div>

          <p className="mt-2 text-[11px] text-foreground-muted">
            {markers.length} of {filteredIssues.length} matching issue{filteredIssues.length === 1 ? "" : "s"} have
            recorded GPS coordinates and appear above, clustered by proximity. Marker color and letter both show
            priority.
            {!showDensity &&
              markers.length > 0 &&
              " Not enough mapped issues to show a meaningful density view."}
          </p>
        </>
      )}
    </div>
  );
}
