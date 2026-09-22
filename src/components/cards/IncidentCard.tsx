import Link from "next/link";
import { Building2, Users, CalendarDays, Sparkles, ListChecks } from "lucide-react";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { categoryLabels } from "@/lib/categories";
import { agingLabel, agingClass } from "@/lib/aging";
import type { CivicIncident } from "@/lib/types";

function daysBetween(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24)));
}

/** List-row card for a Civic Incident — mirrors IssueCard's visual language
 * (same badges, same aging helper) without an image, since an incident has
 * no single photo of its own. */
export function IncidentCard({ incident }: { incident: CivicIncident }) {
  const age = incident.status === "RESOLVED" ? 0 : daysBetween(incident.createdAt);

  return (
    <Link
      href={`/government/incidents/${incident.id}`}
      className="group flex flex-col gap-3 rounded-2xl border border-border bg-white p-5 transition-all duration-300 hover:-translate-y-1 hover:border-civic-200 hover:shadow-[0_16px_40px_-22px_rgba(20,64,47,0.32)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-civic-500"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-semibold text-foreground-muted">
          {incident.incidentCode}
        </span>
        <PriorityBadge priority={incident.priority} />
        <StatusBadge status={incident.status} />
        {incident.detectionMethod === "ai_confirmed" && (
          <span className="inline-flex items-center gap-1 rounded-full bg-civic-50 px-2.5 py-1 text-[11px] font-medium text-civic-700">
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            AI-confirmed
          </span>
        )}
      </div>

      <h3 className="text-[15px] font-semibold leading-snug text-foreground">{incident.title}</h3>
      <p className="text-xs font-medium text-civic-700">{categoryLabels[incident.category]}</p>

      <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-2 text-xs text-foreground-muted">
        <div className="flex items-center gap-1.5">
          <ListChecks className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <dt className="sr-only">Linked reports</dt>
          <dd>
            {incident.linkedReportCount} linked report{incident.linkedReportCount === 1 ? "" : "s"}
          </dd>
        </div>
        <div className="flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <dt className="sr-only">Affected citizens</dt>
          <dd>
            {incident.affectedCitizenCount} citizen{incident.affectedCitizenCount === 1 ? "" : "s"}
          </dd>
        </div>
        <div className="flex items-center gap-1.5">
          <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <dt className="sr-only">Department</dt>
          <dd>{incident.department ?? "Not yet routed"}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <CalendarDays className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <dt className="sr-only">Age</dt>
          <dd className={agingClass(age)}>{agingLabel(age)}</dd>
        </div>
      </dl>
    </Link>
  );
}
