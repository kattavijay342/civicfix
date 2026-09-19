import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ArrowRight, FileEdit } from "lucide-react";
import { CTAButton } from "@/components/ui/CTAButton";
import { IssueCard } from "@/components/cards/IssueCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { getSessionProfile } from "@/lib/supabase/server";
import { getCitizenIssues } from "@/lib/data/citizen";

export const metadata: Metadata = {
  title: "My Reports — CivicFix",
};

export default async function MyReportsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/sign-in");

  const issues = await getCitizenIssues(session.user.id);

  return (
    <div>
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            My Reports
          </h1>
          <p className="mt-1 text-sm text-foreground-muted">
            Every issue you&apos;ve reported, in one place.
          </p>
        </div>
        <CTAButton href="/report" icon={<ArrowRight className="h-4 w-4" />}>
          Report a Problem
        </CTAButton>
      </div>

      {issues.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={<FileEdit className="h-5 w-5" aria-hidden="true" />}
            title="No reports yet"
            description="Reports you submit will appear here so you can track their status."
            action={<CTAButton href="/report">Report a Problem</CTAButton>}
          />
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {issues.map((issue) => (
            <IssueCard key={issue.id} issue={issue} />
          ))}
        </div>
      )}
    </div>
  );
}
