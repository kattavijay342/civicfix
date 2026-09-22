import Link from "next/link";
import { AlertOctagon } from "lucide-react";
import { IncidentCard } from "@/components/cards/IncidentCard";
import { EmptyState } from "@/components/ui/EmptyState";
import type { CivicIncident } from "@/lib/types";

/** Government/department dashboard preview — the top few incidents by
 * recency, with a link to the full filterable list
 * (/government/incidents). Reused as-is by both dashboards since RLS
 * already scopes `incidents` to what each caller is authorized to see. */
export function IncidentsSection({ incidents, previewCount = 4 }: { incidents: CivicIncident[]; previewCount?: number }) {
  if (incidents.length === 0) {
    return (
      <EmptyState
        icon={<AlertOctagon className="h-5 w-5" aria-hidden="true" />}
        title="No civic incidents yet"
        description="When several citizen reports strongly indicate the same real-world problem, they're grouped here automatically."
      />
    );
  }

  return (
    <div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {incidents.slice(0, previewCount).map((incident) => (
          <IncidentCard key={incident.id} incident={incident} />
        ))}
      </div>
      <Link
        href="/government/incidents"
        className="mt-4 inline-flex items-center text-xs font-medium text-civic-700 hover:underline"
      >
        View all {incidents.length} incident{incidents.length === 1 ? "" : "s"} →
      </Link>
    </div>
  );
}
