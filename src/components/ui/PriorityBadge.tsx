import type { Priority } from "@/lib/types";
import { cn } from "@/lib/utils";

const config: Record<Priority, { label: string; text: string; bg: string; dot: string }> = {
  CRITICAL: {
    label: "Critical",
    text: "text-priority-critical",
    bg: "bg-priority-critical-bg",
    dot: "bg-priority-critical",
  },
  HIGH: {
    label: "High",
    text: "text-priority-high",
    bg: "bg-priority-high-bg",
    dot: "bg-priority-high",
  },
  MEDIUM: {
    label: "Medium",
    text: "text-priority-medium",
    bg: "bg-priority-medium-bg",
    dot: "bg-priority-medium",
  },
  LOW: {
    label: "Low",
    text: "text-priority-low",
    bg: "bg-priority-low-bg",
    dot: "bg-priority-low",
  },
};

export function PriorityBadge({ priority, className }: { priority: Priority; className?: string }) {
  const c = config[priority];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
        c.text,
        c.bg,
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", c.dot)} aria-hidden="true" />
      {c.label}
    </span>
  );
}
