"use client";

import { useState } from "react";
import { Copy, X } from "lucide-react";
import type { DuplicateGroup } from "@/lib/types";
import { locationHeadline } from "@/lib/location-format";
import { CTAButton } from "@/components/ui/CTAButton";

interface DuplicateIssueCardProps {
  group: DuplicateGroup;
  distance?: string;
  category?: string;
  status?: string;
  onContinue?: () => void;
  dismissible?: boolean;
}

export function DuplicateIssueCard({
  group,
  distance = "~120m away",
  category,
  status,
  onContinue,
  dismissible = false,
}: DuplicateIssueCardProps) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div className="rounded-2xl border border-dashed border-civic-300 bg-civic-50/60 p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-civic-700 shadow-sm">
          <Copy className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-foreground">Similar Issue Detected</p>
            {dismissible && (
              <button
                type="button"
                onClick={() => setDismissed(true)}
                aria-label="Dismiss"
                className="text-foreground-muted hover:text-foreground"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-foreground-muted">
            This report appears similar to {group.similarCount} existing reports nearby, including{" "}
            &ldquo;{group.primary.title}&rdquo; near {locationHeadline(group.primary.location)}.
          </p>

          <dl className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
            <div>
              <dt className="text-foreground-muted">Distance</dt>
              <dd className="mt-0.5 font-semibold text-foreground">{distance}</dd>
            </div>
            {category && (
              <div>
                <dt className="text-foreground-muted">Category</dt>
                <dd className="mt-0.5 font-semibold text-foreground">{category}</dd>
              </div>
            )}
            {status && (
              <div>
                <dt className="text-foreground-muted">Status</dt>
                <dd className="mt-0.5 font-semibold text-foreground">{status}</dd>
              </div>
            )}
          </dl>

          <div className="mt-3 flex flex-wrap gap-2">
            <CTAButton href={`/reports/${group.primary.id}`} variant="secondary" size="md" className="!px-3 !py-1.5 text-xs">
              View Existing Issue
            </CTAButton>
            {onContinue && (
              <button
                type="button"
                onClick={onContinue}
                className="rounded-full px-3 py-1.5 text-xs font-medium text-civic-700 transition hover:bg-civic-100"
              >
                Continue Report
              </button>
            )}
          </div>

          <p className="mt-2 text-[11px] font-medium text-foreground-muted">
            UI preview only — matching and grouping are not connected to a real duplicate-detection
            model yet.
          </p>
        </div>
      </div>
    </div>
  );
}
