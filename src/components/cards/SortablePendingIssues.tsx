"use client";

import { useMemo, useState } from "react";
import { PendingIssueDetailCard } from "@/components/cards/PendingIssueDetailCard";
import type { CivicIssue, Priority } from "@/lib/types";
import { cn } from "@/lib/utils";

type SortMode = "priority" | "longest" | "recent";

const priorityRank: Record<Priority, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

const sortOptions: { mode: SortMode; label: string }[] = [
  { mode: "priority", label: "Highest Priority" },
  { mode: "longest", label: "Longest Pending" },
  { mode: "recent", label: "Recently Reported" },
];

export function SortablePendingIssues({ issues }: { issues: CivicIssue[] }) {
  const [sortMode, setSortMode] = useState<SortMode>("priority");

  const sorted = useMemo(() => {
    const copy = [...issues];
    if (sortMode === "priority") {
      copy.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);
    } else if (sortMode === "longest") {
      copy.sort((a, b) => b.daysPending - a.daysPending);
    } else {
      copy.sort((a, b) => new Date(b.reportedDate).getTime() - new Date(a.reportedDate).getTime());
    }
    return copy;
  }, [issues, sortMode]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-foreground-muted">Sort by:</span>
        {sortOptions.map((opt) => (
          <button
            key={opt.mode}
            type="button"
            onClick={() => setSortMode(opt.mode)}
            className={cn(
              "min-h-10 rounded-full border px-3.5 py-2 text-xs font-medium transition",
              sortMode === opt.mode
                ? "border-civic-300 bg-civic-50 text-civic-700"
                : "border-border bg-white text-foreground-muted hover:border-civic-200 hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-col gap-4">
        {sorted.map((issue) => (
          <PendingIssueDetailCard key={issue.id} issue={issue} />
        ))}
      </div>
    </div>
  );
}
