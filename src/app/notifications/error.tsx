"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/ui/ErrorState";

export default function NotificationsError({
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
    <ErrorState
      title="Notifications couldn't be loaded"
      description="Something went wrong loading your notifications. You can try again, or come back later."
      onRetry={reset}
    />
  );
}
