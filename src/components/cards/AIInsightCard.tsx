import { TrendingUp, TrendingDown, Sparkles } from "lucide-react";
import type { AIInsight } from "@/lib/types";
import { cn } from "@/lib/utils";

const toneIcon = { up: TrendingUp, down: TrendingDown, neutral: Sparkles } as const;
const toneClass = {
  up: "bg-civic-50 text-civic-700",
  down: "bg-priority-critical-bg text-priority-critical",
  neutral: "bg-priority-low-bg text-priority-low",
} as const;

export function AIInsightCard({ insight }: { insight: AIInsight }) {
  const Icon = toneIcon[insight.tone];
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-border bg-white p-4">
      <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", toneClass[insight.tone])}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <p className="text-sm leading-relaxed text-foreground">{insight.text}</p>
    </div>
  );
}
