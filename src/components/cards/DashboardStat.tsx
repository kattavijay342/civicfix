import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface DashboardStatProps {
  icon: LucideIcon;
  label: string;
  value: string;
  tone?: "default" | "civic";
  trend?: string;
  className?: string;
}

export function DashboardStat({ icon: Icon, label, value, tone = "default", trend, className }: DashboardStatProps) {
  return (
    <div className={cn("rounded-2xl border border-border bg-white p-5", className)}>
      <div className="flex items-start justify-between">
        <div
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-lg",
            tone === "civic" ? "bg-civic-600 text-white" : "bg-surface-muted text-foreground-muted",
          )}
        >
          <Icon className="h-4.5 w-4.5" aria-hidden="true" />
        </div>
        {trend && (
          <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[10px] font-semibold text-foreground-muted">
            {trend}
          </span>
        )}
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      <p className="mt-1 text-xs font-medium text-foreground-muted">{label}</p>
    </div>
  );
}
