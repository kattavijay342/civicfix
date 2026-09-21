"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/ui/ErrorState";

export default function AdminError({
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
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
      <ErrorState
        title="Couldn't load the admin panel"
        description="Something went wrong loading departments and users. You can try again, or come back later."
        onRetry={reset}
      />
    </div>
  );
}
