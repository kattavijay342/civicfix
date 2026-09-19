import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface ProblemTypeCardProps {
  icon: LucideIcon;
  label: string;
  description: string;
  accent: "civic" | "amber" | "blue" | "rose";
  className?: string;
}

const accentClasses: Record<ProblemTypeCardProps["accent"], string> = {
  civic: "bg-civic-50 text-civic-700 group-hover:bg-civic-600",
  amber: "bg-priority-medium-bg text-priority-medium group-hover:bg-priority-medium",
  blue: "bg-priority-low-bg text-priority-low group-hover:bg-priority-low",
  rose: "bg-priority-critical-bg text-priority-critical group-hover:bg-priority-critical",
};

export function ProblemTypeCard({ icon: Icon, label, description, accent, className }: ProblemTypeCardProps) {
  return (
    <div
      className={cn(
        "group flex h-full flex-col gap-3 rounded-2xl border border-border bg-white p-5 transition-all duration-300 hover:-translate-y-1 hover:border-civic-200 hover:shadow-[0_16px_36px_-22px_rgba(20,64,47,0.3)]",
        className,
      )}
    >
      <div
        className={cn(
          "flex h-11 w-11 items-center justify-center rounded-xl transition-colors duration-300 group-hover:text-white",
          accentClasses[accent],
        )}
      >
        <Icon className="h-5 w-5" aria-hidden="true" />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-foreground">{label}</h3>
        <p className="mt-1 text-xs leading-relaxed text-foreground-muted">{description}</p>
      </div>
    </div>
  );
}
