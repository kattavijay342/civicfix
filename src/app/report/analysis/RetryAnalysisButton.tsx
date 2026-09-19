"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { retryAiAnalysis } from "@/lib/actions/reports";

export function RetryAnalysisButton({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await retryAiAnalysis(reportId);
            if (result.error) setError(result.error);
            else router.refresh();
          })
        }
        className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium text-foreground shadow-sm ring-1 ring-border transition hover:ring-civic-300 disabled:opacity-60"
      >
        <RefreshCw className={pending ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden="true" />
        {pending ? "Retrying…" : "Retry AI analysis"}
      </button>
      {error && <p className="mt-2 text-xs font-medium text-priority-critical">{error}</p>}
    </div>
  );
}
