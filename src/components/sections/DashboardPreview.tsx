import { ListChecks, CheckCircle2, Clock, TrendingUp, ArrowRight } from "lucide-react";
import { DashboardStat } from "@/components/cards/DashboardStat";
import { DepartmentPerformanceCard } from "@/components/cards/DepartmentPerformanceCard";
import { PendingIssueCard } from "@/components/cards/PendingIssueCard";
import { CTAButton } from "@/components/ui/CTAButton";
import { Reveal } from "@/components/ui/Reveal";
import { areaOverview, departmentPerformance, pendingByPriority } from "@/lib/sample-data";

export function DashboardPreview() {
  return (
    <section id="dashboard" className="scroll-mt-16 bg-white py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="mx-auto max-w-2xl text-center">
          <span className="text-sm font-semibold text-civic-700">For Government Teams</span>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Monitor, follow up, and track performance
          </h2>
          <p className="mt-3 text-base leading-relaxed text-foreground-muted">
            Government users don&apos;t assign issues manually — AI already routed them. This view
            is for oversight: what&apos;s pending, what&apos;s at risk, who&apos;s performing.
          </p>
        </Reveal>

        <Reveal delayMs={100} className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <DashboardStat icon={ListChecks} label="Total Issues" value={String(areaOverview.totalIssues)} tone="civic" />
          <DashboardStat icon={CheckCircle2} label="Resolved" value={String(areaOverview.resolved)} />
          <DashboardStat icon={Clock} label="Pending" value={String(areaOverview.pending)} />
          <DashboardStat icon={TrendingUp} label="Resolution Rate" value={`${areaOverview.resolutionRate}%`} />
        </Reveal>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-5">
          <Reveal delayMs={150} className="min-w-0 rounded-2xl border border-border bg-white p-6 lg:col-span-3">
            <h3 className="text-sm font-semibold text-foreground">Department Performance</h3>
            <div className="mt-3 divide-y divide-border">
              {departmentPerformance.map((dept) => (
                <DepartmentPerformanceCard key={dept.name} department={dept} />
              ))}
            </div>
          </Reveal>

          <Reveal delayMs={200} className="min-w-0 rounded-2xl border border-border bg-white p-6 lg:col-span-2">
            <h3 className="text-sm font-semibold text-foreground">Pending Issues</h3>
            <div className="mt-3 flex flex-col gap-2.5">
              {pendingByPriority.map((item) => (
                <PendingIssueCard key={item.priority} item={item} />
              ))}
            </div>
          </Reveal>
        </div>

        <Reveal delayMs={250} className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <CTAButton href="/government" variant="secondary" icon={<ArrowRight className="h-4 w-4" />}>
            Open Government Dashboard
          </CTAButton>
          <CTAButton href="/dashboard" variant="ghost">
            Open Citizen Dashboard
          </CTAButton>
        </Reveal>

        <p className="mt-6 text-center text-xs text-foreground-muted">
          Preview built with sample data — connects to live department and issue data in a later
          phase.
        </p>
      </div>
    </section>
  );
}
