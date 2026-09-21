import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, Sparkles, Building2, MapPin, AlertTriangle } from "lucide-react";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import { ReportProgress } from "@/components/report/ReportProgress";
import { JurisdictionChain } from "@/components/cards/JurisdictionChain";
import { AIAnalysisDetails } from "@/components/cards/AIAnalysisDetails";
import { categoryLabels } from "@/lib/categories";
import { getReportDetail } from "@/lib/data/report-detail";
import { RetryAnalysisButton } from "./RetryAnalysisButton";

export default async function AnalysisPage({
  searchParams,
}: {
  searchParams: Promise<{ reportId?: string }>;
}) {
  const { reportId } = await searchParams;
  if (!reportId) notFound();

  const report = await getReportDetail(reportId);
  if (!report) notFound();

  const { aiAnalysis } = report;

  return (
    <div className="bg-surface-muted">
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
        <Link
          href="/report"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Report another problem
        </Link>

        <div className="mt-6">
          <span className="text-sm font-semibold text-civic-700">AI Analysis</span>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
            {aiAnalysis ? "Here's what AI found" : "Report saved"}
          </h1>
          <div className="mt-4">
            <ReportProgress current={aiAnalysis ? 2 : 1} />
          </div>
        </div>

        {!aiAnalysis ? (
          <div className="mt-10 flex flex-col items-center rounded-2xl border border-priority-medium/30 bg-priority-medium-bg px-6 py-14 text-center">
            <AlertTriangle className="h-8 w-8 text-priority-medium" aria-hidden="true" />
            <h3 className="mt-4 text-base font-semibold text-foreground">
              AI analysis is temporarily unavailable.
            </h3>
            <p className="mt-1.5 max-w-sm text-sm text-foreground-muted">
              Your report was saved successfully and is safe — report #{report.id.slice(0, 8)}. You can retry
              analysis now, or check back later; it will also be retried the next time you open this page.
            </p>
            <RetryAnalysisButton reportId={report.id} />
            <Link
              href={`/reports/${report.id}`}
              className="mt-4 text-sm font-medium text-civic-700 hover:underline"
            >
              View report details anyway
            </Link>
          </div>
        ) : (
          <div className="mt-8 grid gap-6 lg:grid-cols-[1.1fr_1fr]">
            <div className="flex flex-col gap-6">
              <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-border bg-surface-muted">
                {report.media[0]?.url ? (
                  <Image
                    src={report.media[0].url}
                    alt="Submitted photo of the reported civic issue"
                    fill
                    sizes="(min-width: 1024px) 560px, 90vw"
                    className="object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-foreground-muted">
                    No photo attached
                  </div>
                )}
              </div>

              {report.duplicateOf && (
                <div className="rounded-2xl border border-priority-medium/30 bg-priority-medium-bg p-5">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    <AlertTriangle className="h-4 w-4 text-priority-medium" aria-hidden="true" />
                    {report.duplicateOf.relationType === "related"
                      ? "Flagged as a related issue"
                      : "Flagged as a possible duplicate"}
                  </p>
                  <p className="mt-1.5 text-sm text-foreground-muted">
                    {report.duplicateOf.relationType === "related" ? "Related to" : "Similar to"}{" "}
                    <Link href={`/reports/${report.duplicateOf.id}`} className="font-medium text-civic-700 hover:underline">
                      &ldquo;{report.duplicateOf.title}&rdquo;
                    </Link>
                    . A government reviewer will check both.
                  </p>
                  {report.duplicateOf.reason && (
                    <p className="mt-1.5 text-xs text-foreground-muted">Why: {report.duplicateOf.reason}</p>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-6">
              <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-[0_20px_50px_-28px_rgba(20,64,47,0.3)]">
                <div className="flex items-center gap-2 border-b border-border px-6 py-4">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-civic-600 text-white">
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  <span className="text-sm font-semibold text-foreground">AI Analysis</span>
                  <span className="ml-auto rounded-full bg-civic-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-civic-700">
                    {aiAnalysis.model}
                  </span>
                </div>

                <div className="space-y-5 px-6 py-5">
                  <p className="text-base font-semibold text-foreground">{aiAnalysis.problemSummary}</p>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                        Priority
                      </span>
                      <div className="mt-1.5">
                        <PriorityBadge priority={aiAnalysis.priority} />
                      </div>
                    </div>
                    <div>
                      <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                        Severity
                      </span>
                      <div className="mt-1.5">
                        <PriorityBadge priority={aiAnalysis.severity} />
                      </div>
                    </div>
                    <div>
                      <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                        Confidence
                      </span>
                      <p className="mt-1.5 text-sm font-semibold text-foreground">
                        {Math.round(aiAnalysis.confidence * 100)}%
                      </p>
                    </div>
                    <div>
                      <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                        Category
                      </span>
                      <p className="mt-1.5 text-sm font-semibold text-foreground">{categoryLabels[report.category]}</p>
                    </div>
                  </div>

                  <div className="border-t border-border pt-4">
                    <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                      AI-Recommended Department
                    </span>
                    <p className="mt-1 text-sm font-semibold text-civic-700">{aiAnalysis.recommendedDepartment}</p>
                    <p className="mt-1 text-[11px] text-foreground-muted">
                      A recommendation only — actual routing below comes from CivicFix&apos;s configured department
                      mapping.
                    </p>
                  </div>

                  <AIAnalysisDetails aiAnalysis={aiAnalysis} />
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-white p-6">
                <h2 className="text-sm font-semibold text-foreground">Routing</h2>
                <ol className="mt-4 flex flex-col gap-3">
                  {[
                    { icon: Sparkles, label: "AI Analysis Complete" },
                    {
                      icon: Building2,
                      label: report.assignment ? report.assignment.departmentName : "Awaiting department routing",
                    },
                    ...(report.assignment?.inchargeName
                      ? [{ icon: MapPin, label: report.assignment.inchargeName }]
                      : []),
                  ].map((step, i, arr) => {
                    const Icon = step.icon;
                    return (
                      <li key={step.label} className="flex items-center gap-3 text-sm">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-civic-50 text-civic-700">
                          <Icon className="h-4 w-4" aria-hidden="true" />
                        </span>
                        <span className="font-medium text-foreground">{step.label}</span>
                        {i < arr.length - 1 && (
                          <span className="ml-auto text-foreground-muted" aria-hidden="true">
                            ↓
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ol>
                <p className="mt-4 border-t border-border pt-3 text-xs text-foreground-muted">
                  Government users don&apos;t assign this manually — routing follows CivicFix&apos;s configured
                  department mapping and jurisdiction.
                </p>
              </div>

              <JurisdictionChain location={report.location} />

              <div className="flex flex-col gap-2 sm:flex-row">
                <Link
                  href={`/reports/${report.id}`}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-civic-600 px-6 py-3.5 text-base font-medium text-white shadow-sm transition-all hover:bg-civic-700"
                >
                  View Full Report
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
                <Link
                  href={`/report/complaint?reportId=${report.id}`}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-full border border-border bg-white px-6 py-3.5 text-base font-medium text-foreground shadow-sm transition-all hover:border-civic-300"
                >
                  Generate Complaint Letter
                </Link>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
