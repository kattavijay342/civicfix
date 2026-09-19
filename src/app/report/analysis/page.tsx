"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, ArrowRight, Sparkles, Building2, FileText, MapPin } from "lucide-react";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import { DuplicateIssueCard } from "@/components/cards/DuplicateIssueCard";
import { JurisdictionChain } from "@/components/cards/JurisdictionChain";
import { ReportProgress } from "@/components/report/ReportProgress";
import { loadReportDraft, DEFAULT_DRAFT, type ReportDraft } from "@/lib/report-draft";
import { categoryAIPresets } from "@/lib/ai-presets";
import { categoryLabels } from "@/lib/categories";
import { duplicateGroups } from "@/lib/sample-data";

export default function AnalysisPage() {
  const router = useRouter();
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [analyzing, setAnalyzing] = useState(true);
  const [dupDismissed, setDupDismissed] = useState(false);

  useEffect(() => {
    // sessionStorage is only available client-side; reading it here (rather
    // than during render) avoids an SSR/hydration content mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(loadReportDraft() ?? DEFAULT_DRAFT);
    const t = setTimeout(() => setAnalyzing(false), 1500);
    return () => clearTimeout(t);
  }, []);

  if (!draft) return null;

  const preset = categoryAIPresets[draft.category];

  return (
    <div className="bg-surface-muted">
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
        <Link
          href="/report"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to edit report
        </Link>

        <div className="mt-6">
          <span className="text-sm font-semibold text-civic-700">AI Analysis</span>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
            {analyzing ? "Analyzing your report…" : "Here's what AI found"}
          </h1>
          <div className="mt-4">
            <ReportProgress current={2} />
          </div>
        </div>

        {analyzing ? (
          <div className="mt-10 flex flex-col items-center justify-center rounded-2xl border border-border bg-white py-24">
            <span className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-civic-600 text-white shadow-lg">
              <Sparkles className="h-7 w-7" aria-hidden="true" />
              <span className="absolute -right-1 -top-1 h-3 w-3 animate-ping rounded-full bg-civic-400" aria-hidden="true" />
              <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-civic-300" aria-hidden="true" />
            </span>
            <p className="mt-5 text-sm font-medium text-foreground-muted">
              Reading the photo and description…
            </p>
            <div className="mt-4 h-1.5 w-48 overflow-hidden rounded-full bg-surface-muted">
              <div className="h-full w-2/3 animate-pulse rounded-full bg-civic-500" />
            </div>
          </div>
        ) : (
          <div className="mt-8 grid gap-6 lg:grid-cols-[1.1fr_1fr]">
            <div className="flex flex-col gap-6">
              <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-border">
                <Image
                  src={draft.imageDataUrl ?? "/images/hero-pothole.jpg"}
                  alt="Submitted photo of the reported civic issue"
                  fill
                  sizes="(min-width: 1024px) 560px, 90vw"
                  className="object-cover"
                />
                {draft.imageIsDemo && (
                  <span className="absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-white">
                    Demo image
                  </span>
                )}
              </div>

              {!dupDismissed && (
                <DuplicateIssueCard
                  group={duplicateGroups[0]}
                  category={categoryLabels[draft.category]}
                  status="In Progress"
                  dismissible
                  onContinue={() => setDupDismissed(true)}
                />
              )}
            </div>

            <div className="flex flex-col gap-6">
              <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-[0_20px_50px_-28px_rgba(20,64,47,0.3)]">
                <div className="flex items-center gap-2 border-b border-border px-6 py-4">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-civic-600 text-white">
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  <span className="text-sm font-semibold text-foreground">AI Analysis</span>
                  <span className="ml-auto rounded-full bg-priority-medium-bg px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-priority-medium">
                    Demo Analysis
                  </span>
                </div>

                <div className="space-y-5 px-6 py-5">
                  <p className="text-base font-semibold text-foreground">{preset.problemLabel}</p>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                        Priority
                      </span>
                      <div className="mt-1.5">
                        <PriorityBadge priority={preset.priority} />
                      </div>
                    </div>
                    <div>
                      <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                        Severity
                      </span>
                      <p className="mt-1.5 text-sm font-semibold text-foreground">{preset.severity} / 100</p>
                    </div>
                    <div>
                      <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                        Confidence
                      </span>
                      <p className="mt-1.5 text-sm font-semibold text-foreground">{preset.confidence}%</p>
                    </div>
                    <div>
                      <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                        Category
                      </span>
                      <p className="mt-1.5 text-sm font-semibold text-foreground">{categoryLabels[draft.category]}</p>
                    </div>
                  </div>

                  <div className="border-t border-border pt-4">
                    <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                      Suggested Department
                    </span>
                    <p className="mt-1 text-sm font-semibold text-civic-700">{preset.departmentLabel}</p>
                    <span className="mt-3 block text-xs font-medium uppercase tracking-wide text-foreground-muted">
                      Suggested In-charge
                    </span>
                    <p className="mt-1 text-sm font-semibold text-foreground">{preset.inCharge}</p>
                  </div>

                  <div className="border-t border-border pt-4">
                    <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                      AI Explanation
                    </span>
                    <p className="mt-1.5 text-sm leading-relaxed text-foreground-muted">{preset.explanationEn}</p>
                  </div>
                </div>

                <div className="border-t border-border bg-surface-muted/60 px-6 py-3">
                  <p className="text-[11px] leading-relaxed text-foreground-muted">
                    Sample analysis for UI preview — not generated by a live AI model in Phase 1A.
                  </p>
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-white p-6">
                <h2 className="text-sm font-semibold text-foreground">AI Routing</h2>
                <ol className="mt-4 flex flex-col gap-3">
                  {[
                    { icon: FileText, label: "Citizen Report" },
                    { icon: Sparkles, label: "AI Analysis" },
                    { icon: Building2, label: `${preset.department} Department` },
                    { icon: MapPin, label: preset.inCharge },
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
                  Government users don&apos;t assign this manually — AI already identified the
                  department and in-charge.
                </p>
              </div>

              <JurisdictionChain location={draft.location} />

              <button
                type="button"
                onClick={() => router.push("/report/complaint")}
                className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-civic-600 px-6 py-3.5 text-base font-medium text-white shadow-sm transition-all hover:bg-civic-700"
              >
                Generate Complaint
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
