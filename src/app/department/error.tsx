"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/ui/ErrorState";

export default function DepartmentError({
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
    <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <ErrorState
        title="Couldn't load assigned reports"
        description="Something went wrong loading your assigned reports. You can try again, or come back later."
        onRetry={reset}
      />
    </div>
  );
}
