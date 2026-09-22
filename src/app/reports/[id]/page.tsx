import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, MapPin, Building2, CalendarDays, MessageSquare, Search, AlertTriangle, CheckCircle2, Clock, XCircle, Sparkles as SparklesIcon } from "lucide-react";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { IssueTimeline } from "@/components/cards/IssueTimeline";
import { RealStatusTimeline } from "@/components/cards/RealStatusTimeline";
import { BeforeAfterCard } from "@/components/cards/BeforeAfterCard";
import { AIAnalysisDetails } from "@/components/cards/AIAnalysisDetails";
import { DuplicateIssueCard } from "@/components/cards/DuplicateIssueCard";
import { CitizenIncidentNote } from "@/components/cards/CitizenIncidentNote";
import { EmptyState } from "@/components/ui/EmptyState";
import { CTAButton } from "@/components/ui/CTAButton";
import { sampleIssues } from "@/lib/sample-data";
import { categoryAIPresets } from "@/lib/ai-presets";
import { categoryLabels } from "@/lib/categories";
import { agingLabel, agingClass } from "@/lib/aging";
import { locationHeadline, locationBreakdown } from "@/lib/location-format";
import { getReportDetail } from "@/lib/data/report-detail";
import { getReportReminders } from "@/lib/data/reminders";
import { getCitizenIncidentNote } from "@/lib/data/incidents";
import { getSessionProfile } from "@/lib/supabase/server";
import { buildCitizenSummary, STATUS_EXPLANATIONS } from "@/lib/citizen-summary";
import { RetryAnalysisButton } from "@/app/report/analysis/RetryAnalysisButton";
import { FollowUpForm } from "@/components/report/FollowUpForm";
import { ReminderForm } from "@/components/report/ReminderForm";
import { ReportLocationMap } from "@/components/report/ReportLocationMap";
import { ReminderRow } from "@/components/report/ReminderRow";
import { DepartmentActionsPanel } from "@/components/report/DepartmentActionsPanel";
import { ResolutionFeedbackForm } from "@/components/report/ResolutionFeedbackForm";
import { cn } from "@/lib/utils";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function daysBetween(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24)));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  if (UUID_RE.test(id)) {
    const report = await getReportDetail(id);
    return { title: report ? `${report.title} — CivicFix` : "Report not found — CivicFix" };
  }
  const issue = sampleIssues.find((i) => i.id === id);
  return { title: issue ? `${issue.title} — CivicFix` : "Report not found — CivicFix" };
}

function NotFound({ id }: { id: string }) {
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
          description={`No report with ID "${id}" exists, or you don't have access to view it.`}
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

export default async function ReportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (UUID_RE.test(id)) {
    return <RealReportDetail id={id} />;
  }

  return <SampleReportDetail id={id} />;
}

async function RealReportDetail({ id }: { id: string }) {
  const [report, session] = await Promise.all([getReportDetail(id), getSessionProfile()]);

  if (!report) return <NotFound id={id} />;

  const reminders = session ? await getReportReminders(report.id, session.user.id) : [];
  const isOwner = session?.user.id === report.reporterId;
  const incidentNote = isOwner ? await getCitizenIncidentNote(report.id) : null;
  const isGovOrAdmin = session?.profile.role === "government" || session?.profile.role === "admin";
  const aiPending = !report.aiAnalysis && report.status === "REPORTED";
  // agingLabel() treats 0 as "Resolved", so an unresolved same-day report
  // must never compute to 0 — floor it at 1.
  const daysPending = report.status === "RESOLVED" ? 0 : Math.max(1, daysBetween(report.createdAt));

  // A citizen's feedback is only "for" the resolution it was submitted
  // after — a fresh reopen -> re-resolve cycle needs fresh feedback, so
  // stale feedback from a previous cycle doesn't silently hide the form.
  const feedbackIsForCurrentResolution =
    report.resolutionFeedback && report.resolutionEvidence
      ? new Date(report.resolutionFeedback.updatedAt) >= new Date(report.resolutionEvidence.resolvedAt)
      : !!report.resolutionFeedback;
  const showFeedbackForm = isOwner && report.status === "RESOLVED" && !feedbackIsForCurrentResolution;

  const departmentAcknowledged = report.statusHistory.some((h) => h.newStatus === "ACKNOWLEDGED");

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
              {report.priority && <PriorityBadge priority={report.priority} />}
              <StatusBadge status={report.status} />
              <span className="rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-semibold text-foreground-muted">
                #{report.id.slice(0, 8)}
              </span>
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              {report.title}
            </h1>
          </div>
          <span className={cn("text-sm", agingClass(daysPending))}>{agingLabel(daysPending)}</span>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          {report.aiAnalysis && (
            <span className="inline-flex items-center gap-1 rounded-full bg-civic-50 px-2.5 py-1 font-medium text-civic-700">
              <SparklesIcon className="h-3 w-3" aria-hidden="true" />
              AI analyzed
            </span>
          )}
          {departmentAcknowledged && (
            <span className="inline-flex items-center gap-1 rounded-full bg-civic-50 px-2.5 py-1 font-medium text-civic-700">
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
              Department acknowledged
            </span>
          )}
          {report.resolutionEvidence && (
            <span className="inline-flex items-center gap-1 rounded-full bg-civic-50 px-2.5 py-1 font-medium text-civic-700">
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
              Resolution evidence submitted
            </span>
          )}
          {report.resolutionEvidence && feedbackIsForCurrentResolution && report.resolutionFeedback && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium",
                report.resolutionFeedback.confirmed ? "bg-civic-50 text-civic-700" : "bg-priority-critical-bg text-priority-critical"
              )}
            >
              {report.resolutionFeedback.confirmed ? (
                <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
              ) : (
                <XCircle className="h-3 w-3" aria-hidden="true" />
              )}
              {report.resolutionFeedback.confirmed ? "Citizen confirmed" : "Citizen reports still unresolved"}
            </span>
          )}
          {report.resolutionEvidence && !feedbackIsForCurrentResolution && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2.5 py-1 font-medium text-foreground-muted">
              <Clock className="h-3 w-3" aria-hidden="true" />
              Citizen confirmation pending
            </span>
          )}
        </div>

        <div className="mt-4 rounded-2xl border border-civic-100 bg-civic-50/50 p-5">
          <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-civic-800">
            <SparklesIcon className="h-3.5 w-3.5" aria-hidden="true" />
            Understand your report
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-foreground">{buildCitizenSummary(report)}</p>
          <p className="mt-2 border-t border-civic-100 pt-2 text-xs text-foreground-muted">
            <span className="font-medium text-foreground">Next:</span> {STATUS_EXPLANATIONS[report.status].nextStep.en}
          </p>
        </div>

        {incidentNote && (
          <div className="mt-4">
            <CitizenIncidentNote note={incidentNote} />
          </div>
        )}

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
          <div className="flex flex-col gap-6">
            {report.media[0]?.url && (
              <div className="relative aspect-[16/10] overflow-hidden rounded-2xl border border-border">
                <Image
                  src={report.media[0].url}
                  alt={`Photo evidence of: ${report.title}, ${locationHeadline(report.location)}`}
                  fill
                  sizes="(min-width: 1024px) 640px, 90vw"
                  className="object-cover"
                />
              </div>
            )}

            <div className="rounded-2xl border border-border bg-white p-6">
              <h2 className="text-sm font-semibold text-foreground">Problem Description</h2>
              <p className="mt-2 text-sm leading-relaxed text-foreground-muted">{report.description}</p>

              <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4 text-xs">
                <div>
                  <dt className="flex items-center gap-1 text-foreground-muted">
                    <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                    Reported
                  </dt>
                  <dd className="mt-1 font-semibold text-foreground">{formatDate(report.createdAt)}</dd>
                </div>
                <div>
                  <dt className="text-foreground-muted">Category</dt>
                  <dd className="mt-1 font-semibold text-foreground">{categoryLabels[report.category]}</dd>
                </div>
                <div>
                  <dt className="flex items-center gap-1 text-foreground-muted">
                    <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                    Follow-ups
                  </dt>
                  <dd className="mt-1 font-semibold text-foreground">{report.followUps.length}</dd>
                </div>
              </dl>
            </div>

            <div className="rounded-2xl border border-border bg-white p-6">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <MapPin className="h-4 w-4 text-civic-700" aria-hidden="true" />
                Location
              </h2>
              <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
                {locationBreakdown(report.location).map((row) => (
                  <div key={row.label} className={row.label === "Specific Location" ? "col-span-2" : undefined}>
                    <dt className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                      {row.label}
                    </dt>
                    <dd className="mt-0.5 font-semibold text-foreground">{row.value}</dd>
                  </div>
                ))}
              </dl>
              <ReportLocationMap latitude={report.location.latitude} longitude={report.location.longitude} />
            </div>

            <div className="rounded-2xl border border-border bg-white p-6">
              <h2 className="text-sm font-semibold text-foreground">AI Analysis</h2>
              {report.aiAnalysis ? (
                <>
                  <div className="mt-4 grid grid-cols-2 gap-4 text-xs">
                    <div>
                      <span className="text-foreground-muted">Priority</span>
                      <div className="mt-1">
                        <PriorityBadge priority={report.aiAnalysis.priority} />
                      </div>
                    </div>
                    <div>
                      <span className="text-foreground-muted">Severity</span>
                      <div className="mt-1">
                        <PriorityBadge priority={report.aiAnalysis.severity} />
                      </div>
                    </div>
                    <div>
                      <span className="text-foreground-muted">Confidence</span>
                      <p className="mt-1 text-sm font-semibold text-foreground">
                        {Math.round(report.aiAnalysis.confidence * 100)}%
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 border-t border-border pt-4 text-xs">
                    <span className="font-medium uppercase tracking-wide text-foreground-muted">
                      AI-Recommended Department
                    </span>
                    <p className="mt-1 text-sm font-semibold text-civic-700">
                      {report.aiAnalysis.recommendedDepartment}
                    </p>
                    <p className="mt-1 text-[11px] text-foreground-muted">
                      A recommendation only — actual routing uses CivicFix&apos;s configured department mapping
                      (see Routing).
                    </p>
                  </div>
                  <div className="mt-4 flex flex-col gap-4">
                    <AIAnalysisDetails aiAnalysis={report.aiAnalysis} />
                  </div>
                  <p className="mt-3 text-[11px] text-foreground-muted">
                    Generated by {report.aiAnalysis.model}.
                  </p>
                </>
              ) : aiPending ? (
                <div className="mt-3 flex flex-col items-start gap-2">
                  <p className="flex items-center gap-1.5 text-sm text-priority-medium">
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                    AI analysis is temporarily unavailable.
                  </p>
                  {isOwner && <RetryAnalysisButton reportId={report.id} />}
                </div>
              ) : (
                <p className="mt-3 text-sm text-foreground-muted">No AI analysis for this report.</p>
              )}
            </div>

            {(report.followUps.length > 0 || isGovOrAdmin) && (
              <div className="rounded-2xl border border-border bg-white p-6">
                <h2 className="text-sm font-semibold text-foreground">Follow-ups</h2>
                {report.followUps.length > 0 ? (
                  <ol className="mt-4 flex flex-col gap-4">
                    {report.followUps.map((f, i) => (
                      <li key={f.id} className="border-t border-border pt-4 first:border-t-0 first:pt-0">
                        <p className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
                          Follow-up #{report.followUps.length - i} · {formatDate(f.followUpDate)}
                        </p>
                        <p className="mt-1 text-sm text-foreground-muted">{f.notes}</p>
                        {f.nextFollowUpDate && (
                          <p className="mt-1 text-sm text-civic-700">
                            <span className="font-semibold">Next follow-up:</span> {formatDate(f.nextFollowUpDate)}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="mt-3 text-sm text-foreground-muted">No follow-ups recorded yet.</p>
                )}
                {isGovOrAdmin && <FollowUpForm reportId={report.id} />}
              </div>
            )}

            {(reminders.length > 0 || isGovOrAdmin) && (
              <div className="rounded-2xl border border-border bg-white p-6">
                <h2 className="text-sm font-semibold text-foreground">Reminders</h2>
                <p className="mt-1 text-xs text-foreground-muted">
                  Scheduled instructions for the department in-charge, delivered automatically as an
                  in-app notification when they come due.
                </p>
                {reminders.length > 0 ? (
                  <ul className="mt-4 flex flex-col gap-4">
                    {reminders.map((r) => (
                      <ReminderRow key={r.id} reminder={r} reportId={report.id} />
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm text-foreground-muted">No reminders scheduled yet.</p>
                )}
                {isGovOrAdmin &&
                  (report.assignment?.inchargeId ? (
                    <ReminderForm reportId={report.id} />
                  ) : (
                    <p className="mt-4 border-t border-border pt-4 text-xs text-foreground-muted">
                      A department in-charge must be assigned to this report before a reminder can be
                      scheduled.
                    </p>
                  ))}
              </div>
            )}

            {report.resolutionEvidence &&
              (report.resolutionEvidence.beforeUrl || report.media[0]?.url) &&
              report.resolutionEvidence.afterUrl ? (
                <BeforeAfterCard
                  beforeSrc={report.resolutionEvidence.beforeUrl ?? report.media[0]!.url!}
                  beforeAlt="Before resolution"
                  afterSrc={report.resolutionEvidence.afterUrl}
                  afterAlt="After resolution"
                  title={report.title}
                  department={report.assignment?.departmentName ?? "—"}
                  resolvedDate={formatDate(report.resolutionEvidence.resolvedAt)}
                />
              ) : (
                report.resolutionEvidence && (
                  <div className="rounded-2xl border border-dashed border-border bg-white p-6 text-sm text-foreground-muted">
                    Resolution evidence not provided.
                  </div>
                )
              )}
            {report.resolutionEvidence && (
              <p className="-mt-3 rounded-2xl border border-border bg-white px-6 py-4 text-sm text-foreground-muted">
                <span className="font-semibold text-foreground">Resolution notes:</span>{" "}
                {report.resolutionEvidence.notes}
              </p>
            )}

            {showFeedbackForm && <ResolutionFeedbackForm reportId={report.id} />}

            {report.duplicateOf && (
              <DuplicateIssueCard
                group={{
                  primary: {
                    id: report.duplicateOf.id,
                    title: report.duplicateOf.title,
                    location: report.duplicateOf.location,
                    category: report.duplicateOf.category,
                    status: report.duplicateOf.status,
                  },
                  similarCount: 1,
                  relationType: report.duplicateOf.relationType,
                  reason: report.duplicateOf.reason,
                }}
              />
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
                  <dd className="font-semibold text-foreground">
                    {report.assignment?.departmentName ?? "Not yet routed"}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                  <dt className="text-foreground-muted">In-charge</dt>
                  <dd className="text-right font-semibold text-foreground">
                    {report.assignment?.inchargeName ?? "Not yet assigned"}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="rounded-2xl border border-border bg-white p-6">
              <h2 className="text-sm font-semibold text-foreground">Status Timeline</h2>
              <div className="mt-5">
                <RealStatusTimeline
                  history={report.statusHistory}
                  status={report.status}
                  reporterId={report.reporterId}
                  departmentName={report.assignment?.departmentName ?? null}
                />
              </div>
            </div>

            {(session?.profile.role === "admin" ||
              (session?.profile.role === "department_incharge" &&
                session.profile.id === report.assignment?.inchargeId)) && (
              <DepartmentActionsPanel
                reportId={report.id}
                status={report.status}
                reopenNote={report.status === "REOPENED" ? report.resolutionFeedback?.comment : null}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SampleReportDetail({ id }: { id: string }) {
  const issue = sampleIssues.find((i) => i.id === id);

  if (!issue) return <NotFound id={id} />;

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

        <p className="mt-4 rounded-xl bg-priority-medium-bg px-3.5 py-2 text-xs font-medium text-priority-medium">
          Sample data shown for demonstration — this is not a real submitted report.
        </p>

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
