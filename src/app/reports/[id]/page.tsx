import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, MapPin, Building2, CalendarDays, MessageSquare, Search } from "lucide-react";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { IssueTimeline } from "@/components/cards/IssueTimeline";
import { EmptyState } from "@/components/ui/EmptyState";
import { CTAButton } from "@/components/ui/CTAButton";
import { sampleIssues } from "@/lib/sample-data";
import { categoryAIPresets } from "@/lib/ai-presets";
import { categoryLabels } from "@/lib/categories";
import { agingLabel, agingClass } from "@/lib/aging";
import { locationHeadline, locationBreakdown } from "@/lib/location-format";
import { cn } from "@/lib/utils";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const issue = sampleIssues.find((i) => i.id === id);
  return { title: issue ? `${issue.title} — CivicFix` : "Report not found — CivicFix" };
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export default async function ReportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const issue = sampleIssues.find((i) => i.id === id);

  if (!issue) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to dashboard
        </Link>
        <div className="mt-8">
          <EmptyState
            icon={<Search className="h-5 w-5" aria-hidden="true" />}
            title="Report not found"
            description={`No report with ID "${id}" exists in the sample data set.`}
            action={
              <CTAButton href="/dashboard" variant="secondary">
                Back to dashboard
              </CTAButton>
            }
          />
        </div>
      </div>
    );
  }

  const preset = categoryAIPresets[issue.category];
  const description = issue.description ?? preset.complaintEn.description;
  const severity = issue.severity ?? preset.severity;
  const confidence = issue.confidence ?? preset.confidence;
  const aiExplanation = issue.aiExplanation ?? preset.explanationEn;
  const inCharge = issue.inCharge ?? preset.inCharge;

  return (
    <div className="bg-surface-muted">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to dashboard
        </Link>

        <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <PriorityBadge priority={issue.priority} />
              <StatusBadge status={issue.status} />
              <span className="rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-semibold text-foreground-muted">
                {issue.id}
              </span>
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              {issue.title}
            </h1>
          </div>
          <span className={cn("text-sm", agingClass(issue.daysPending))}>{agingLabel(issue.daysPending)}</span>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
          <div className="flex flex-col gap-6">
            {issue.imageUrl && (
              <div className="relative aspect-[16/10] overflow-hidden rounded-2xl border border-border">
                <Image
                  src={issue.imageUrl}
                  alt={`Photo evidence of: ${issue.title}, ${locationHeadline(issue.location)}`}
                  fill
                  sizes="(min-width: 1024px) 640px, 90vw"
                  className="object-cover"
                />
              </div>
            )}

            <div className="rounded-2xl border border-border bg-white p-6">
              <h2 className="text-sm font-semibold text-foreground">Problem Description</h2>
              <p className="mt-2 text-sm leading-relaxed text-foreground-muted">{description}</p>

              <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4 text-xs">
                <div>
                  <dt className="flex items-center gap-1 text-foreground-muted">
                    <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                    Reported
                  </dt>
                  <dd className="mt-1 font-semibold text-foreground">{formatDate(issue.reportedDate)}</dd>
                </div>
                <div>
                  <dt className="text-foreground-muted">Category</dt>
                  <dd className="mt-1 font-semibold text-foreground">{categoryLabels[issue.category]}</dd>
                </div>
                <div>
                  <dt className="flex items-center gap-1 text-foreground-muted">
                    <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                    Follow-ups
                  </dt>
                  <dd className="mt-1 font-semibold text-foreground">{issue.followUps ?? 0}</dd>
                </div>
              </dl>
            </div>

            <div className="rounded-2xl border border-border bg-white p-6">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <MapPin className="h-4 w-4 text-civic-700" aria-hidden="true" />
                Location
              </h2>
              <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
                {locationBreakdown(issue.location).map((row) => (
                  <div key={row.label} className={row.label === "Specific Location" ? "col-span-2" : undefined}>
                    <dt className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                      {row.label}
                    </dt>
                    <dd className="mt-0.5 font-semibold text-foreground">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="rounded-2xl border border-border bg-white p-6">
              <h2 className="text-sm font-semibold text-foreground">AI Analysis</h2>
              <div className="mt-4 grid grid-cols-2 gap-4 text-xs">
                <div>
                  <span className="text-foreground-muted">Severity</span>
                  <p className="mt-1 text-sm font-semibold text-foreground">{severity} / 100</p>
                </div>
                <div>
                  <span className="text-foreground-muted">Confidence</span>
                  <p className="mt-1 text-sm font-semibold text-foreground">{confidence}%</p>
                </div>
              </div>
              <p className="mt-4 border-t border-border pt-4 text-sm leading-relaxed text-foreground-muted">
                {aiExplanation}
              </p>
              <p className="mt-3 text-[11px] text-foreground-muted">
                Sample analysis shown for preview — not generated by a live AI model.
              </p>
            </div>

            {(issue.lastFollowUp || issue.nextFollowUp) && (
              <div className="rounded-2xl border border-border bg-white p-6">
                <h2 className="text-sm font-semibold text-foreground">Follow-up</h2>
                {issue.lastFollowUp && (
                  <p className="mt-2 text-sm text-foreground-muted">
                    <span className="font-semibold text-foreground">Last follow-up:</span> {issue.lastFollowUp}
                  </p>
                )}
                {issue.nextFollowUp && (
                  <p className="mt-1 text-sm text-civic-700">
                    <span className="font-semibold">Next follow-up:</span> {issue.nextFollowUp}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-6">
            <div className="rounded-2xl border border-border bg-white p-6">
              <h2 className="text-sm font-semibold text-foreground">Routing</h2>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="flex items-center gap-1.5 text-foreground-muted">
                    <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Department
                  </dt>
                  <dd className="font-semibold text-foreground">{issue.department}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                  <dt className="text-foreground-muted">In-charge</dt>
                  <dd className="text-right font-semibold text-foreground">{inCharge}</dd>
                </div>
              </dl>
            </div>

            <div className="rounded-2xl border border-border bg-white p-6">
              <h2 className="text-sm font-semibold text-foreground">Status Timeline</h2>
              <div className="mt-5">
                <IssueTimeline status={issue.status} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
