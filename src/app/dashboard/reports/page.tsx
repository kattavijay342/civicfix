import type { Metadata } from "next";
import { CTAButton } from "@/components/ui/CTAButton";
import { IssueCard } from "@/components/cards/IssueCard";
import { sampleIssues } from "@/lib/sample-data";
import { ArrowRight } from "lucide-react";

export const metadata: Metadata = {
  title: "My Reports — CivicFix",
};

export default function MyReportsPage() {
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

      <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {sampleIssues.map((issue) => (
          <IssueCard key={issue.id} issue={issue} />
        ))}
      </div>

      <p className="mt-6 text-center text-xs text-foreground-muted">
        Shown with sample data for preview — this becomes your personal report history once
        accounts are connected.
      </p>
    </div>
  );
}
