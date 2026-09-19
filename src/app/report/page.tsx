import type { Metadata } from "next";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { getSessionProfile } from "@/lib/supabase/server";
import { EmptyState } from "@/components/ui/EmptyState";
import { CTAButton } from "@/components/ui/CTAButton";
import { ReportForm } from "./ReportForm";

export const metadata: Metadata = {
  title: "Report a Problem — CivicFix",
};

export default async function ReportPage() {
  const session = await getSessionProfile();

  if (!session) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
        <EmptyState
          icon={<KeyRound className="h-5 w-5" aria-hidden="true" />}
          title="Sign in to report a problem"
          description="Reports are tied to your account so you can track their status and see the resolution."
          action={
            <CTAButton href="/sign-in">Sign In</CTAButton>
          }
        />
      </div>
    );
  }

  return <ReportForm profile={session.profile} />;
}
