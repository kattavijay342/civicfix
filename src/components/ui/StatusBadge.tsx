import { CheckCircle2, CircleDot, ClipboardList, Loader2 } from "lucide-react";
import type { IssueStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export const statusLabels: Record<IssueStatus, string> = {
  REPORTED: "Reported",
  ASSIGNED: "Assigned",
  IN_PROGRESS: "In Progress",
  RESOLVED: "Resolved",
};

const config: Record<
  IssueStatus,
  { label: string; text: string; bg: string; icon: typeof CircleDot }
> = {
  REPORTED: {
    label: "Reported",
    text: "text-status-reported",
    bg: "bg-status-reported-bg",
    icon: ClipboardList,
  },
  ASSIGNED: {
    label: "Assigned",
    text: "text-status-assigned",
    bg: "bg-status-assigned-bg",
    icon: CircleDot,
  },
  IN_PROGRESS: {
    label: "In Progress",
    text: "text-status-progress",
    bg: "bg-status-progress-bg",
    icon: Loader2,
  },
  RESOLVED: {
    label: "Resolved",
    text: "text-status-resolved",
    bg: "bg-status-resolved-bg",
    icon: CheckCircle2,
  },
};

export function StatusBadge({ status, className }: { status: IssueStatus; className?: string }) {
  const c = config[status];
  const Icon = c.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
        c.text,
        c.bg,
        className,
      )}
    >
      <Icon
        className={cn("h-3.5 w-3.5", status === "IN_PROGRESS" && "animate-spin")}
        aria-hidden="true"
      />
      {c.label}
    </span>
  );
}
