import type { Metadata } from "next";
import { ListChecks, AlertTriangle, Loader2, CheckCircle2, ArrowRight } from "lucide-react";
import { DashboardStat } from "@/components/cards/DashboardStat";
import { DonutChart } from "@/components/cards/DonutChart";
import { IssueCard } from "@/components/cards/IssueCard";
import { CTAButton } from "@/components/ui/CTAButton";
import { citizenOverview, reportsByCategory, sampleIssues } from "@/lib/sample-data";

export const metadata: Metadata = {
  title: "Citizen Dashboard — CivicFix",
};

const chartColors = [
  "var(--color-priority-medium)",
  "var(--color-civic-500)",
  "var(--color-priority-low)",
  "var(--color-status-progress)",
  "var(--color-status-assigned)",
  "var(--color-priority-critical)",
];

export default function CitizenDashboardPage() {
  return (
    <div>
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            Good to see you, Citizen!
          </h1>
          <p className="mt-1 text-sm text-foreground-muted">
            Here&apos;s what&apos;s happening with your civic reports.
          </p>
        </div>
        <CTAButton href="/report" icon={<ArrowRight className="h-4 w-4" />}>
          Report a Problem
        </CTAButton>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <DashboardStat
          icon={ListChecks}
          label="Total Reports"
          value={String(citizenOverview.totalReports)}
          tone="civic"
          trend="+2 this month"
        />
        <DashboardStat
          icon={AlertTriangle}
          label="High Priority"
          value={String(citizenOverview.highPriority)}
          trend="1 critical"
        />
        <DashboardStat
          icon={Loader2}
          label="In Progress"
          value={String(citizenOverview.inProgress)}
          trend="Being worked on"
        />
        <DashboardStat
          icon={CheckCircle2}
          label="Resolved"
          value={String(citizenOverview.resolved)}
          trend="+1 this week"
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div className="min-w-0 rounded-2xl border border-border bg-white p-6 lg:col-span-2">
          <h2 className="text-sm font-semibold text-foreground">Reports by Category</h2>
          <div className="mt-5">
            <DonutChart
              segments={reportsByCategory.map((c, i) => ({
                label: c.label,
                value: c.count,
                color: chartColors[i % chartColors.length],
              }))}
            />
          </div>
        </div>

        <div className="min-w-0 rounded-2xl border border-border bg-white p-6 lg:col-span-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">Recent Reports</h2>
            <a href="/dashboard/reports" className="text-xs font-medium text-civic-700 hover:underline">
              View all
            </a>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {sampleIssues.slice(0, 4).map((issue) => (
              <IssueCard key={issue.id} issue={issue} />
            ))}
          </div>
        </div>
      </div>

      <p className="mt-6 text-center text-xs text-foreground-muted">
        Shown with sample data for preview — this becomes your personal report history once
        accounts are connected.
      </p>
    </div>
  );
}
