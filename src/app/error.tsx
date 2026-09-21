"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/ui/ErrorState";

export default function RootError({
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
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <ErrorState
        title="Something went wrong"
        description="An unexpected error occurred. You can try again, or come back later."
        onRetry={reset}
      />
    </div>
  );
}
