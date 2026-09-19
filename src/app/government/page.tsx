import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MapPinOff } from "lucide-react";
import { DepartmentPerformanceCard } from "@/components/cards/DepartmentPerformanceCard";
import { DepartmentAnalyticsTable } from "@/components/cards/DepartmentAnalyticsTable";
import { JurisdictionExplorer } from "@/components/cards/JurisdictionExplorer";
import { FollowUpCard } from "@/components/cards/FollowUpCard";
import { AIInsightCard } from "@/components/cards/AIInsightCard";
import { DuplicateIssueCard } from "@/components/cards/DuplicateIssueCard";
import { MapPreview } from "@/components/cards/MapPreview";
import { EmptyState } from "@/components/ui/EmptyState";
import { statusLabels } from "@/components/ui/StatusBadge";
import { categoryLabels } from "@/lib/categories";
import { getSessionProfile } from "@/lib/supabase/server";
import {
  getGovernmentIssues,
  getAreaOverview,
  getDepartmentPerformance,
  getAIInsights,
  getDuplicateGroups,
} from "@/lib/data/government";

export const metadata: Metadata = {
  title: "Government Dashboard — CivicFix",
};

export default async function GovernmentDashboardPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/sign-in");
  if (session.profile.role !== "government" && session.profile.role !== "admin") {
    redirect("/dashboard");
  }

  const hasJurisdiction =
    session.profile.role === "admin" ||
    !!(
      session.profile.gov_state ||
      session.profile.gov_district ||
      session.profile.gov_constituency ||
      session.profile.gov_area
    );

  if (!hasJurisdiction) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
        <EmptyState
          icon={<MapPinOff className="h-5 w-5" aria-hidden="true" />}
          title="No jurisdiction assigned yet"
          description="Your account isn't scoped to a state/district/constituency/area yet, so there's nothing to show. Ask an administrator to configure your jurisdiction."
        />
      </div>
    );
  }

  const [issues, areaOverview, departmentPerformance, aiInsights, duplicateGroups] = await Promise.all([
    getGovernmentIssues(),
    getAreaOverview(),
    getDepartmentPerformance(),
    getAIInsights(),
    getDuplicateGroups(),
  ]);

  const followUpIssues = issues.filter((i) => i.lastFollowUp);

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
          <JurisdictionExplorer
            issues={issues}
            fallbackOverview={{
              totalIssues: areaOverview.totalIssues,
              resolved: areaOverview.resolved,
              pending: areaOverview.pending,
              critical: areaOverview.critical,
              resolutionRate: areaOverview.resolutionRate,
            }}
          />
          <p className="mt-2 text-xs text-foreground-muted">
            On-time resolution rate: <span className="font-semibold text-foreground">{areaOverview.onTimeResolutionRate}%</span>{" "}
            of resolved issues within their configured SLA.
          </p>
        </div>

        {issues.length === 0 ? (
          <div className="mt-10">
            <EmptyState
              title="No issues in your jurisdiction yet"
              description="Reports from citizens in your configured area will appear here as they come in."
            />
          </div>
        ) : (
          <>
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
                </div>
              </div>
            </section>

            <section className="mt-10">
              <h2 className="text-lg font-semibold text-foreground">Government Area Map</h2>
              <p className="mt-1 text-sm text-foreground-muted">
                Markers show priority for every issue in your jurisdiction.
              </p>
              <div className="mt-4">
                <MapPreview issues={issues} />
              </div>
              <p className="mt-3 text-xs text-foreground-muted">
                Illustrative layout, not a real geographic projection — no map/geocoding provider is
                configured yet (see the Phase 2 report). Marker positions are not derived from
                latitude/longitude.
              </p>
            </section>

            {followUpIssues.length > 0 && (
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
            )}

            <section className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Insights</h2>
                <div className="mt-4 flex flex-col gap-3">
                  {aiInsights.length > 0 ? (
                    aiInsights.map((insight) => <AIInsightCard key={insight.id} insight={insight} />)
                  ) : (
                    <p className="text-sm text-foreground-muted">Not enough data yet for insights.</p>
                  )}
                </div>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">Duplicate Detection</h2>
                <div className="mt-4 flex flex-col gap-3">
                  {duplicateGroups.length > 0 ? (
                    duplicateGroups.map((group) => (
                      <DuplicateIssueCard
                        key={group.primary.id}
                        group={group}
                        category={categoryLabels[group.primary.category]}
                        status={statusLabels[group.primary.status]}
                      />
                    ))
                  ) : (
                    <p className="text-sm text-foreground-muted">No possible duplicates flagged.</p>
                  )}
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
