import Image from "next/image";
import { Sparkles, MapPin } from "lucide-react";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import type { Priority } from "@/lib/types";

interface AIAnalysisCardProps {
  imageSrc: string;
  imageAlt: string;
  problem: string;
  location: string;
  priority: Priority;
  confidence: number;
  department: string;
}

export function AIAnalysisCard({
  imageSrc,
  imageAlt,
  problem,
  location,
  priority,
  confidence,
  department,
}: AIAnalysisCardProps) {
  return (
    <div className="w-full max-w-md overflow-hidden rounded-3xl border border-border bg-white shadow-[0_24px_60px_-28px_rgba(20,64,47,0.3)]">
      <div className="relative h-44 w-full">
        <Image src={imageSrc} alt={imageAlt} fill sizes="448px" className="object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-black/5 to-transparent" />
        <div className="absolute left-4 top-4 flex items-center gap-2 rounded-full bg-white/95 px-3 py-1.5 shadow-sm">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-civic-600 text-white">
            <Sparkles className="h-3 w-3" aria-hidden="true" />
          </span>
          <span className="text-xs font-semibold text-foreground">AI Civic Analysis</span>
        </div>
      </div>

      <div className="space-y-5 px-6 py-5">
        <div>
          <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
            Problem
          </span>
          <p className="mt-1 text-sm font-medium leading-relaxed text-foreground">{problem}</p>
          <p className="mt-1 flex items-center gap-1 text-xs text-foreground-muted">
            <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
            {location}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
              Priority
            </span>
            <div className="mt-1.5">
              <PriorityBadge priority={priority} />
            </div>
          </div>
          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
              Confidence
            </span>
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-muted">
                <div
                  className="h-full rounded-full bg-civic-500"
                  style={{ width: `${confidence}%` }}
                />
              </div>
              <span className="text-xs font-semibold text-foreground">{confidence}%</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 border-t border-border pt-4">
          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
              Department
            </span>
            <p className="mt-1 text-sm font-semibold text-foreground">{department}</p>
          </div>
          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
              Status
            </span>
            <p className="mt-1 text-sm font-semibold text-civic-700">Automatically Routed</p>
          </div>
        </div>
      </div>

      <div className="border-t border-border bg-surface-muted/60 px-6 py-3">
        <p className="text-[11px] leading-relaxed text-foreground-muted">
          Illustrative preview of the AI routing concept — not a live model output.
        </p>
      </div>
    </div>
  );
}
