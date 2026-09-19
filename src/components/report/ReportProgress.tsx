import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const steps = ["Report", "Review", "AI Analysis", "Complaint"];

export function ReportProgress({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:gap-2" aria-label="Report progress">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <span
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap sm:text-xs",
                active
                  ? "bg-civic-600 text-white"
                  : done
                    ? "bg-civic-50 text-civic-700"
                    : "bg-surface-muted text-foreground-muted",
              )}
            >
              <span
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                  active ? "bg-white/25 text-white" : done ? "bg-civic-100 text-civic-700" : "bg-white text-foreground-muted",
                )}
              >
                {done ? <Check className="h-2.5 w-2.5" aria-hidden="true" /> : i + 1}
              </span>
              {label}
            </span>
            {i < steps.length - 1 && <span className="h-px w-3 shrink-0 bg-border sm:w-5" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}
