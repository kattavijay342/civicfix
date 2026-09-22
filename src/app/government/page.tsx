import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { MapPinOff } from "lucide-react";
import { DepartmentPerformanceCard } from "@/components/cards/DepartmentPerformanceCard";
import { DepartmentAnalyticsTable } from "@/components/cards/DepartmentAnalyticsTable";
import { JurisdictionExplorer } from "@/components/cards/JurisdictionExplorer";
import { FollowUpCard } from "@/components/cards/FollowUpCard";
import { AIInsightCard } from "@/components/cards/AIInsightCard";
import { DuplicateIssueCard } from "@/components/cards/DuplicateIssueCard";
import { MapPreview } from "@/components/cards/MapPreview";
import { AttentionRequiredSection } from "@/components/cards/AttentionRequiredSection";
import { AgingBucketsChart } from "@/components/cards/AgingBucketsChart";
import { CategoryTrendsChart } from "@/components/cards/CategoryTrendsChart";
import { ResolutionQualityCard } from "@/components/cards/ResolutionQualityCard";
import { WorkloadDistribution } from "@/components/cards/WorkloadDistribution";
import { DepartmentTrendCard } from "@/components/cards/DepartmentTrendCard";
import { FollowUpCenter } from "@/components/cards/FollowUpCenter";
import { IncidentsSection } from "@/components/cards/IncidentsSection";
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
  getAgingBuckets,
  getResolutionQuality,
  getDepartmentWorkload,
  getDepartmentTrends,
  getCategoryTrends,
  getNeedsAttention,
  getActionCenterCounts,
} from "@/lib/data/government";
import { getFollowUpCenter } from "@/lib/data/reminders";
import { getIncidentList } from "@/lib/data/incidents";
import { buildGovernmentMetricsSnapshot, generateGovernmentAIInsights } from "@/lib/government-insights-ai";
import type { AIInsight } from "@/lib/types";

export const metadata: Metadata = {
  title: "Government Dashboard — CivicFix",
};

const INSIGHT_TONE: Record<string, AIInsight["tone"]> = {
  workload: "neutral",
  risk: "down",
  trend: "neutral",
  category: "neutral",
  geographic: "down",
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

  const [
    issues,
    areaOverview,
    departmentPerformance,
    deterministicInsights,
    duplicateGroups,
    aging,
    resolutionQuality,
    departmentWorkload,
    departmentTrends,
    categoryTrends,
    needsAttention,
    actionCounts,
    followUpCenter,
    incidents,
  ] = await Promise.all([
    getGovernmentIssues(),
    getAreaOverview(),
    getDepartmentPerformance(),
    getAIInsights(),
    getDuplicateGroups(),
    getAgingBuckets(),
    getResolutionQuality(),
    getDepartmentWorkload(),
    getDepartmentTrends(),
    getCategoryTrends(30),
    getNeedsAttention(),
    getActionCenterCounts(),
    getFollowUpCenter(),
    getIncidentList(),
  ]);

  const followUpIssues = issues.filter((i) => i.lastFollowUp);

  // AI-grounded insights receive ONLY the real metrics already computed
  // above (never raw report content) and are cross-validated against them
  // (src/lib/government-insights-ai.ts). Any failure — no API key, quota
  // exhausted, invalid response — falls back to the always-available
  // deterministic insights; the dashboard's correctness never depends on
  // AI being reachable (Phase 6E §17).
  let aiInsights: AIInsight[] = deterministicInsights;
  try {
    const metrics = buildGovernmentMetricsSnapshot({
      overview: areaOverview,
      aging,
      quality: resolutionQuality,
      categories: categoryTrends ?? [],
      workload: departmentWorkload,
    });
    const grounded = await generateGovernmentAIInsights(metrics);
    if (grounded.length > 0) {
      aiInsights = grounded.map((g, i) => ({
        id: `ai-${g.insightType}-${i}`,
        text: `${g.title} — ${g.summary}`,
        tone: INSIGHT_TONE[g.insightType] ?? "neutral",
      }));
    }
  } catch {
    // Expected whenever GEMINI_API_KEY is unset or quota is exhausted —
    // deterministicInsights (already assigned above) is the honest,
    // always-real fallback, not a degraded/fake state.
  }

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

        <div className="mt-4 flex justify-end">
          <Link href="/government/issues" className="text-xs font-medium text-civic-700 hover:underline">
            View all issues (paginated) →
          </Link>
        </div>

        {/* A. Overview */}
        <div className="mt-4">
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
            On-time resolution data unavailable — no configured SLA.
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
            {/* B. Attention Required */}
            <section className="mt-10">
              <h2 className="text-lg font-semibold text-foreground">Needs Attention</h2>
              <p className="mt-1 text-sm text-foreground-muted">Where to focus today — real, linked issues.</p>
              <div className="mt-4">
                <AttentionRequiredSection needsAttention={needsAttention} actionCounts={actionCounts} basePath="/government/issues" />
              </div>
            </section>

            {/* B2. Civic Incidents */}
            <section className="mt-10">
              <h2 className="text-lg font-semibold text-foreground">Civic Incidents</h2>
              <p className="mt-1 text-sm text-foreground-muted">
                Multiple citizen reports that likely describe the same real-world problem, grouped so a
                department can resolve it once.
              </p>
              <div className="mt-4">
                <IncidentsSection incidents={incidents} />
              </div>
            </section>

            {/* C. Issue Trends */}
            <section className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="rounded-2xl border border-border bg-white p-6">
                <h2 className="text-lg font-semibold text-foreground">Issue Aging</h2>
                <p className="mt-1 text-xs text-foreground-muted">How long currently-pending issues have been waiting.</p>
                <div className="mt-4">
                  <AgingBucketsChart buckets={aging} />
                </div>
              </div>
              <div className="rounded-2xl border border-border bg-white p-6">
                <h2 className="text-lg font-semibold text-foreground">Category Trends</h2>
                <div className="mt-4">
                  <CategoryTrendsChart trends={categoryTrends} days={30} />
                </div>
              </div>
            </section>

            {/* D. Department Performance */}
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

              <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
                <div className="rounded-2xl border border-border bg-white p-6">
                  <h3 className="text-sm font-semibold text-foreground">Workload Distribution</h3>
                  <p className="mt-1 text-xs text-foreground-muted">Active issues per department — an operational view, not a ranking.</p>
                  <div className="mt-4">
                    <WorkloadDistribution workload={departmentWorkload} />
                  </div>
                </div>
                <div className="rounded-2xl border border-border bg-white p-6">
                  <h3 className="text-sm font-semibold text-foreground">Department Trend</h3>
                  <div className="mt-4">
                    <DepartmentTrendCard trends={departmentTrends} />
                  </div>
                </div>
              </div>
            </section>

            {/* E. Geographic Concentration */}
            <section className="mt-10">
              <h2 className="text-lg font-semibold text-foreground">Government Area Map</h2>
              <p className="mt-1 text-sm text-foreground-muted">
                Markers show priority for every issue in your jurisdiction.
              </p>
              <div className="mt-4">
                <MapPreview issues={issues} />
              </div>
            </section>

            {/* F. Follow-ups */}
            <section className="mt-10">
              <h2 className="text-lg font-semibold text-foreground">Follow-up Center</h2>
              <p className="mt-1 text-sm text-foreground-muted">
                Every scheduled reminder you can see, jurisdiction-wide — reuses the existing reminder system.
              </p>
              <div className="mt-4 rounded-2xl border border-border bg-white p-6">
                <FollowUpCenter groups={followUpCenter} />
              </div>
            </section>

            {followUpIssues.length > 0 && (
              <section className="mt-10">
                <h2 className="text-lg font-semibold text-foreground">Follow-up Notes</h2>
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

            {/* G. Resolution Quality */}
            <section className="mt-10">
              <h2 className="text-lg font-semibold text-foreground">Resolution Quality</h2>
              <p className="mt-1 text-sm text-foreground-muted">
                Factual operational counts — never an interpretation of department performance.
              </p>
              <div className="mt-4 rounded-2xl border border-border bg-white p-6">
                <ResolutionQualityCard quality={resolutionQuality} />
              </div>
            </section>

            {/* H. AI Insights */}
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
