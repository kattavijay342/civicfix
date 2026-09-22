import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Building2, CalendarDays, ListChecks, Sparkles, Users } from "lucide-react";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { IssueCard } from "@/components/cards/IssueCard";
import { IncidentMap } from "@/components/incident/IncidentMap";
import { IncidentActionsPanel } from "@/components/incident/IncidentActionsPanel";
import { categoryLabels } from "@/lib/categories";
import { agingLabel, agingClass } from "@/lib/aging";
import { getSessionProfile } from "@/lib/supabase/server";
import { getIncidentDetail } from "@/lib/data/incidents";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const detail = await getIncidentDetail(id);
  return { title: detail ? `${detail.incident.incidentCode} — CivicFix` : "Incident not found — CivicFix" };
}

const RELATIONSHIP_LABELS: Record<string, string> = {
  primary: "Founding report",
  duplicate: "Duplicate report",
  related: "Related report",
  supporting: "AI-confirmed match",
  candidate: "Low-confidence candidate (awaiting review)",
};

function daysBetween(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24)));
}

export default async function IncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSessionProfile();
  if (!session) redirect("/sign-in");
  if (session.profile.role === "citizen") redirect("/dashboard");

  const detail = await getIncidentDetail(id);
  if (!detail) notFound();

  const { incident, links } = detail;
  const confirmedLinks = links.filter((l) => l.relationshipType !== "candidate");
  const candidateLinks = links.filter((l) => l.relationshipType === "candidate");
  const age = incident.status === "RESOLVED" ? 0 : daysBetween(incident.createdAt);

  return (
    <div className="bg-surface-muted">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
        <Link
          href="/government/incidents"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to incidents
        </Link>

        <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <PriorityBadge priority={incident.priority} />
              <StatusBadge status={incident.status} />
              <span className="rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-semibold text-foreground-muted">
                {incident.incidentCode}
              </span>
              {incident.detectionMethod === "ai_confirmed" && (
                <span className="inline-flex items-center gap-1 rounded-full bg-civic-50 px-2.5 py-1 text-[11px] font-medium text-civic-700">
                  <Sparkles className="h-3 w-3" aria-hidden="true" />
                  AI-confirmed match
                </span>
              )}
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              {incident.title}
            </h1>
          </div>
          <span className={agingClass(age)}>{agingLabel(age)}</span>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
          <div className="flex flex-col gap-6">
            <div className="rounded-2xl border border-border bg-white p-6">
              <h2 className="text-sm font-semibold text-foreground">Incident Map</h2>
              <p className="mt-1 text-xs text-foreground-muted">
                {links.length} citizen report{links.length === 1 ? "" : "s"} → 1 civic incident.
              </p>
              <div className="mt-4">
                <IncidentMap links={links} />
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-white p-6">
              <h2 className="text-sm font-semibold text-foreground">Linked Reports</h2>
              <p className="mt-1 text-xs text-foreground-muted">
                Every citizen report the underlying detection linked to this incident, scoped to what you&apos;re
                authorized to see.
              </p>
              {confirmedLinks.length === 0 ? (
                <p className="mt-4 text-sm text-foreground-muted">No linked reports visible.</p>
              ) : (
                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {confirmedLinks.map((link) => (
                    <div key={link.report.id} className="flex flex-col gap-1.5">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-civic-700">
                        {RELATIONSHIP_LABELS[link.relationshipType]}
                      </span>
                      <IssueCard issue={link.report} />
                    </div>
                  ))}
                </div>
              )}

              {candidateLinks.length > 0 && (
                <div className="mt-6 border-t border-border pt-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
                    Awaiting review ({candidateLinks.length})
                  </h3>
                  <p className="mt-1 text-xs text-foreground-muted">
                    Weak signals only — not yet counted in this incident&apos;s priority, severity, or affected-citizen
                    totals.
                  </p>
                  <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {candidateLinks.map((link) => (
                      <IssueCard key={link.report.id} issue={link.report} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-6">
            <div className="rounded-2xl border border-border bg-white p-6">
              <h2 className="text-sm font-semibold text-foreground">Incident Summary</h2>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="flex items-center gap-1.5 text-foreground-muted">
                    <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Department
                  </dt>
                  <dd className="font-semibold text-foreground">{incident.department ?? "Not yet routed"}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                  <dt className="text-foreground-muted">Category</dt>
                  <dd className="font-semibold text-foreground">{categoryLabels[incident.category]}</dd>
                </div>
                {incident.subcategory && (
                  <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                    <dt className="text-foreground-muted">Subcategory</dt>
                    <dd className="font-semibold text-foreground">{incident.subcategory}</dd>
                  </div>
                )}
                <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                  <dt className="flex items-center gap-1.5 text-foreground-muted">
                    <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
                    Linked reports
                  </dt>
                  <dd className="font-semibold text-foreground">{incident.linkedReportCount}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                  <dt className="flex items-center gap-1.5 text-foreground-muted">
                    <Users className="h-3.5 w-3.5" aria-hidden="true" />
                    Affected citizens
                  </dt>
                  <dd className="font-semibold text-foreground">{incident.affectedCitizenCount}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                  <dt className="flex items-center gap-1.5 text-foreground-muted">
                    <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                    First reported
                  </dt>
                  <dd className="font-semibold text-foreground">
                    {new Date(incident.earliestReportAt).toLocaleDateString()}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                  <dt className="text-foreground-muted">Detection confidence</dt>
                  <dd className="font-semibold text-foreground">{Math.round(incident.confidence * 100)}%</dd>
                </div>
              </dl>
              <p className="mt-4 border-t border-border pt-3 text-[11px] text-foreground-muted">
                {incident.detectionMethod === "ai_confirmed"
                  ? "AI-confirmed: deterministic signals were ambiguous, so one AI semantic check confirmed this grouping."
                  : "Rule-based incident match: deterministic geography, category, timing, and text-overlap signals were strong enough to link these reports automatically."}
              </p>
            </div>

            {(session.profile.role === "government" ||
              session.profile.role === "admin" ||
              session.profile.role === "department_incharge") && (
              <IncidentActionsPanel incidentId={incident.id} status={incident.status} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
