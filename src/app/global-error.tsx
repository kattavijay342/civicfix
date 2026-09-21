"use client";

import { useEffect } from "react";

/**
 * Catches errors thrown by the root layout itself (e.g. the session/profile
 * fetch in layout.tsx) — a plain src/app/error.tsx only catches errors in
 * its siblings/children, not in the layout that renders it. Must render its
 * own <html>/<body> since it replaces the root layout entirely.
 */
export default function GlobalError({
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
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-white px-4 antialiased">
        <div className="mx-auto max-w-md text-center">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">
            Something went wrong
          </h1>
          <p className="mt-2 text-sm text-neutral-600">
            An unexpected error occurred while loading CivicFix. You can try again, or come back
            later.
          </p>
          <button
            type="button"
            onClick={reset}
            className="mt-6 inline-flex items-center justify-center rounded-full bg-neutral-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-700"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
