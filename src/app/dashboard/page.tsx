import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ListChecks, AlertTriangle, Loader2, CheckCircle2, ArrowRight, FileEdit } from "lucide-react";
import { DashboardStat } from "@/components/cards/DashboardStat";
import { DonutChart } from "@/components/cards/DonutChart";
import { IssueCard } from "@/components/cards/IssueCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { CTAButton } from "@/components/ui/CTAButton";
import { getSessionProfile } from "@/lib/supabase/server";
import { getCitizenIssues, summarizeCitizenIssues, reportsByCategoryFrom } from "@/lib/data/citizen";

export const metadata: Metadata = {
  title: "Citizen Dashboard — CivicFix",
};

const chartColors = [
  "var(--color-priority-medium)",
  "var(--color-civic-500)",
  "var(--color-priority-low)",
  "var(--color-status-progress)",
  "var(--color-status-routed)",
  "var(--color-priority-critical)",
];

export default async function CitizenDashboardPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/sign-in");

  const issues = await getCitizenIssues(session.user.id);
  const overview = summarizeCitizenIssues(issues);
  const byCategory = reportsByCategoryFrom(issues);

  return (
    <div>
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            Good to see you, {session.profile.full_name?.split(" ")[0] ?? "Citizen"}!
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
        <DashboardStat icon={ListChecks} label="Total Reports" value={String(overview.totalReports)} tone="civic" />
        <DashboardStat icon={AlertTriangle} label="High Priority" value={String(overview.highPriority)} />
        <DashboardStat icon={Loader2} label="In Progress" value={String(overview.inProgress)} />
        <DashboardStat icon={CheckCircle2} label="Resolved" value={String(overview.resolved)} />
      </div>

      {issues.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={<FileEdit className="h-5 w-5" aria-hidden="true" />}
            title="No reports yet"
            description="Once you report a civic problem, it'll show up here with its status and AI analysis."
            action={<CTAButton href="/report">Report a Problem</CTAButton>}
          />
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-5">
          <div className="min-w-0 rounded-2xl border border-border bg-white p-6 lg:col-span-2">
            <h2 className="text-sm font-semibold text-foreground">Reports by Category</h2>
            <div className="mt-5">
              <DonutChart
                segments={byCategory.map((c, i) => ({
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
              {issues.slice(0, 4).map((issue) => (
                <IssueCard key={issue.id} issue={issue} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
