"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/ui/ErrorState";

export default function ReportDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="bg-surface-muted">
      <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6 lg:px-8">
        <ErrorState
          title="Couldn't load this report"
          description="Something went wrong loading this report. You can try again, or come back later."
          onRetry={reset}
        />
      </div>
    </div>
  );
}
