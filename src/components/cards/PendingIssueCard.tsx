import type { PendingByPriority } from "@/lib/types";
import { cn } from "@/lib/utils";

const dotClass: Record<PendingByPriority["priority"], string> = {
  CRITICAL: "bg-priority-critical",
  HIGH: "bg-priority-high",
  MEDIUM: "bg-priority-medium",
  LOW: "bg-priority-low",
};

const label: Record<PendingByPriority["priority"], string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

export function PendingIssueCard({ item }: { item: PendingByPriority }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-border bg-white px-4 py-3">
      <span className="flex items-center gap-2 text-sm font-medium text-foreground">
        <span className={cn("h-2 w-2 rounded-full", dotClass[item.priority])} aria-hidden="true" />
        {label[item.priority]}
      </span>
      <span className="text-sm font-semibold text-foreground">{item.count}</span>
    </div>
  );
}
