import { Users } from "lucide-react";
import type { CitizenIncidentNote as CitizenIncidentNoteData } from "@/lib/data/incidents";

/**
 * The ONLY incident-related information a citizen ever sees (spec §13) —
 * a safe, aggregated count, never another citizen's name, contact info, or
 * report id/status. Backed by get_citizen_incident_note(), which itself
 * verifies server-side that the caller owns the report before returning
 * anything (supabase/migrations/0014_incident_intelligence.sql).
 */
export function CitizenIncidentNote({ note }: { note: CitizenIncidentNoteData }) {
  return (
    <div className="flex items-start gap-2.5 rounded-2xl border border-civic-100 bg-civic-50/50 p-5">
      <Users className="mt-0.5 h-4 w-4 shrink-0 text-civic-700" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-foreground">
          This issue has also been reported by other citizens.
        </p>
        <p className="mt-1 text-xs text-foreground-muted">
          Multiple report{note.otherReportCount === 1 ? "" : "s"} received in this area for the same problem —
          the department can act on it as a single issue.
        </p>
      </div>
    </div>
  );
}
