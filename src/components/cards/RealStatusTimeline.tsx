import { FileEdit, Sparkles, Route, CircleDot, Loader2, CheckCircle2, RotateCcw, Circle } from "lucide-react";
import type { StatusHistoryEntry } from "@/lib/data/report-detail";
import type { IssueStatus } from "@/lib/types";

const CANONICAL_ORDER: IssueStatus[] = ["REPORTED", "AI_ANALYZED", "ROUTED", "ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED"];

const ICON_BY_STATUS: Record<IssueStatus, typeof FileEdit> = {
  REPORTED: FileEdit,
  AI_ANALYZED: Sparkles,
  ROUTED: Route,
  ACKNOWLEDGED: CircleDot,
  IN_PROGRESS: Loader2,
  RESOLVED: CheckCircle2,
  REOPENED: RotateCcw,
};

/** Boilerplate notes already implied by the label itself — not worth
 * repeating as a subtitle. Anything else (a department's real action notes,
 * a citizen's reopen comment) is shown, because it's real information the
 * generic label doesn't convey. */
const REDUNDANT_NOTES = new Set([
  "Report submitted",
  "AI analysis complete",
  "AI analysis complete (retry)",
  "Routed to configured department",
]);

function labelFor(entry: StatusHistoryEntry, reporterId: string, departmentName: string | null): string {
  switch (entry.newStatus) {
    case "REPORTED":
      return "Reported";
    case "AI_ANALYZED":
      return "AI analyzed your report";
    case "ROUTED":
      return departmentName ? `Routed to ${departmentName}` : "Routed to a department";
    case "ACKNOWLEDGED":
      return "Department acknowledged";
    case "IN_PROGRESS":
      return "Work started";
    case "RESOLVED":
      return entry.oldStatus === "REOPENED" ? "Resolution submitted again" : "Resolution submitted";
    case "REOPENED":
      return entry.changedBy === reporterId
        ? "You reported this wasn't actually fixed — reopened"
        : "Reopened";
  }
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Real, event-driven status timeline — renders report.statusHistory
 * (append-only, real timestamps, real notes) exactly as it happened.
 * Stages that haven't occurred yet render as upcoming placeholders with no
 * timestamp, never a fabricated one (Phase 6D §3). Also serves as the
 * "track your issue" plain-language progress view (§14) — one component,
 * not a second competing UI. The sample-data path (SampleReportDetail) has
 * no real status_history and keeps using the original IssueTimeline.
 */
export function RealStatusTimeline({
  history,
  status,
  reporterId,
  departmentName,
}: {
  history: StatusHistoryEntry[];
  status: IssueStatus;
  reporterId: string;
  departmentName: string | null;
}) {
  const entries = history;

  const upcoming: IssueStatus[] =
    status === "REOPENED"
      ? ["ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED"]
      : status === "RESOLVED"
        ? []
        : CANONICAL_ORDER.slice(CANONICAL_ORDER.indexOf(status) + 1);

  return (
    <ol className="flex flex-col">
      {entries.map((entry, i) => {
        const Icon = ICON_BY_STATUS[entry.newStatus];
        const isLast = i === entries.length - 1 && upcoming.length === 0;
        const showNote = entry.notes && !REDUNDANT_NOTES.has(entry.notes);
        return (
          <li key={`${entry.newStatus}-${entry.createdAt}`} className="relative flex gap-4 pb-7 last:pb-0">
            {!isLast && (
              <span
                className="absolute left-[19px] top-10 h-[calc(100%-2.25rem)] w-px bg-civic-300"
                aria-hidden="true"
              />
            )}
            <span className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-civic-200 bg-civic-50 text-civic-700">
              <Icon className="h-4.5 w-4.5" aria-hidden="true" />
            </span>
            <div className="pt-2">
              <p className="text-sm font-semibold text-foreground">
                {labelFor(entry, reporterId, departmentName)}
              </p>
              <p className="text-xs text-foreground-muted">{formatDateTime(entry.createdAt)}</p>
              {showNote && <p className="mt-1 text-xs text-foreground-muted">{entry.notes}</p>}
            </div>
          </li>
        );
      })}
      {upcoming.map((step, i) => {
        const Icon = ICON_BY_STATUS[step];
        const isLast = i === upcoming.length - 1;
        return (
          <li key={step} className="relative flex gap-4 pb-7 last:pb-0">
            {!isLast && (
              <span className="absolute left-[19px] top-10 h-[calc(100%-2.25rem)] w-px bg-border" aria-hidden="true" />
            )}
            <span className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-surface-muted text-foreground-muted">
              <Icon className="h-4.5 w-4.5" aria-hidden="true" />
            </span>
            <div className="pt-2">
              <p className="text-sm font-semibold text-foreground-muted">
                {step === "ACKNOWLEDGED" && "Department acknowledgement"}
                {step === "IN_PROGRESS" && "Work in progress"}
                {step === "RESOLVED" && "Resolution"}
              </p>
              <p className="flex items-center gap-1 text-xs text-foreground-muted/70">
                <Circle className="h-2.5 w-2.5" aria-hidden="true" />
                Not yet reached
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
