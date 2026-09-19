import { FileEdit, Sparkles, Route, Loader2, CheckCircle2 } from "lucide-react";
import type { IssueStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const steps = [
  { key: "reported", label: "Reported", icon: FileEdit },
  { key: "analyzed", label: "AI Analyzed", icon: Sparkles },
  { key: "routed", label: "Automatically Routed", icon: Route },
  { key: "progress", label: "In Progress", icon: Loader2 },
  { key: "resolved", label: "Resolved", icon: CheckCircle2 },
] as const;

const completedCountByStatus: Record<IssueStatus, number> = {
  REPORTED: 1,
  ASSIGNED: 3,
  IN_PROGRESS: 4,
  RESOLVED: 5,
};

export function IssueTimeline({ status }: { status: IssueStatus }) {
  const completed = completedCountByStatus[status];

  return (
    <ol className="flex flex-col">
      {steps.map((step, i) => {
        const Icon = step.icon;
        const isDone = i < completed;
        const isCurrent = i === completed && status !== "RESOLVED";
        const isLast = i === steps.length - 1;
        return (
          <li key={step.key} className="relative flex gap-4 pb-7 last:pb-0">
            {!isLast && (
              <span
                className={cn(
                  "absolute left-[19px] top-10 h-[calc(100%-2.25rem)] w-px",
                  isDone ? "bg-civic-300" : "bg-border",
                )}
                aria-hidden="true"
              />
            )}
            <span
              className={cn(
                "relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border",
                isDone
                  ? "border-civic-200 bg-civic-50 text-civic-700"
                  : isCurrent
                    ? "border-civic-300 bg-civic-600 text-white"
                    : "border-border bg-surface-muted text-foreground-muted",
              )}
            >
              <Icon
                className={cn("h-4.5 w-4.5", status === "IN_PROGRESS" && step.key === "progress" && "animate-spin")}
                aria-hidden="true"
              />
            </span>
            <div className="pt-2">
              <p className={cn("text-sm font-semibold", isDone || isCurrent ? "text-foreground" : "text-foreground-muted")}>
                {step.label}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
