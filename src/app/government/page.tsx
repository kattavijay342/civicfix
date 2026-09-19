import type { Metadata } from "next";
import { DepartmentPerformanceCard } from "@/components/cards/DepartmentPerformanceCard";
import { DepartmentAnalyticsTable } from "@/components/cards/DepartmentAnalyticsTable";
import { JurisdictionExplorer } from "@/components/cards/JurisdictionExplorer";
import { FollowUpCard } from "@/components/cards/FollowUpCard";
import { AIInsightCard } from "@/components/cards/AIInsightCard";
import { DuplicateIssueCard } from "@/components/cards/DuplicateIssueCard";
import { MapPreview } from "@/components/cards/MapPreview";
import { statusLabels } from "@/components/ui/StatusBadge";
import { categoryLabels } from "@/lib/categories";
import {
  aiInsights,
  areaOverview,
  departmentPerformance,
  duplicateGroups,
  sampleIssues,
} from "@/lib/sample-data";

export const metadata: Metadata = {
  title: "Government Dashboard — CivicFix",
};

const followUpIssues = sampleIssues.filter((i) => i.lastFollowUp);

export default function GovernmentDashboardPage() {
  return (
    <div className="bg-surface-muted">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
        <div>
          <span className="text-sm font-semibold text-civic-700">Government Dashboard</span>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
            Area Overview
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
            AI already routed every issue to its department — this view is for monitoring,
            follow-up, and performance oversight, not manual assignment.
          </p>
        </div>

        <div className="mt-8">
          <JurisdictionExplorer issues={sampleIssues} fallbackOverview={areaOverview} />
        </div>

        {/* Department Performance */}
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-foreground">Department Performance</h2>
          <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-5">
            <div className="min-w-0 rounded-2xl border border-border bg-white p-6 lg:col-span-2">
              <div className="divide-y divide-border">
                {departmentPerformance.map((dept) => (
                  <DepartmentPerformanceCard key={dept.name} department={dept} />
                ))}
              </div>
            </div>
            <div className="lg:col-span-3">
              <DepartmentAnalyticsTable departments={departmentPerformance} />
              <p className="mt-3 text-xs text-foreground-muted">
                Sample analytics shown for preview — calculations will run against real issue
                data once connected.
              </p>
            </div>
          </div>
        </section>

        {/* Area Map */}
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-foreground">Government Area Map</h2>
          <p className="mt-1 text-sm text-foreground-muted">
            Markers show priority; shaded zones highlight where issues cluster into hotspots.
          </p>
          <div className="mt-4">
            <MapPreview />
          </div>
          <p className="mt-3 text-xs text-foreground-muted">
            Preview surface with sample coordinates — a live map provider (Google Maps, Mapbox, or
            Leaflet) can be connected behind this layout in a later phase.
          </p>
        </section>

        {/* Follow-up */}
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-foreground">Follow-up</h2>
          <p className="mt-1 text-sm text-foreground-muted">
            Government users monitor and follow up — AI already routed the issue, no manual
            reassignment needed.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {followUpIssues.map((issue) => (
              <FollowUpCard key={issue.id} issue={issue} />
            ))}
          </div>
        </section>

        {/* AI Insights + Duplicate detection */}
        <section className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <h2 className="text-lg font-semibold text-foreground">AI Insights</h2>
            <div className="mt-4 flex flex-col gap-3">
              {aiInsights.map((insight) => (
                <AIInsightCard key={insight.id} insight={insight} />
              ))}
            </div>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">Duplicate Detection</h2>
            <div className="mt-4 flex flex-col gap-3">
              {duplicateGroups.map((group) => (
                <DuplicateIssueCard
                  key={group.primary.id}
                  group={group}
                  category={categoryLabels[group.primary.category]}
                  status={statusLabels[group.primary.status]}
                />
              ))}
            </div>
          </div>
        </section>

        <p className="mt-10 text-center text-xs text-foreground-muted">
          Every metric on this page is sample data structured for a real backend to replace in a
          later phase — no live department or issue data is connected yet.
        </p>
      </div>
    </div>
  );
}
