import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, KeyRound } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { CTAButton } from "@/components/ui/CTAButton";

export const metadata: Metadata = {
  title: "Sign In — CivicFix",
};

export default function SignInPage() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-xl flex-col justify-center px-4 py-16 sm:px-6">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground-muted hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to home
      </Link>

      <div className="mt-8">
        <EmptyState
          icon={<KeyRound className="h-5 w-5" aria-hidden="true" />}
          title="Sign-in isn't connected yet"
          description="Citizen, government, and department accounts will be added once authentication and role-based access are built in a later phase. Nothing here is a working login."
          action={
            <CTAButton href="/#dashboard" variant="secondary">
              Preview the government dashboard
            </CTAButton>
          }
        />
      </div>
    </div>
  );
}
