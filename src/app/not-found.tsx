import Link from "next/link";
import { MapPinOff } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { CTAButton } from "@/components/ui/CTAButton";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <EmptyState
        icon={<MapPinOff className="h-5 w-5" aria-hidden="true" />}
        title="Page not found"
        description="The page you're looking for doesn't exist or may have moved."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <CTAButton href="/">Back to home</CTAButton>
            <Link
              href="/dashboard"
              className="inline-flex items-center justify-center rounded-full border border-border px-5 py-2.5 text-sm font-semibold text-foreground transition hover:border-civic-300"
            >
              Go to dashboard
            </Link>
          </div>
        }
      />
    </div>
  );
}
