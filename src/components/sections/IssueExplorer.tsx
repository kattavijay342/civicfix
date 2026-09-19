import { CTAButton } from "@/components/ui/CTAButton";
import { IssueCard } from "@/components/cards/IssueCard";
import { Reveal } from "@/components/ui/Reveal";
import { sampleIssues } from "@/lib/sample-data";

export function IssueExplorer() {
  return (
    <section id="explore" className="scroll-mt-16 bg-surface-muted py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <span className="text-sm font-semibold text-civic-700">Explore Issues</span>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              See what&apos;s being reported and tracked
            </h2>
            <p className="mt-3 max-w-xl text-base leading-relaxed text-foreground-muted">
              Sample issues shown for preview — every card carries priority, status, and
              department at a glance.
            </p>
          </div>
          <CTAButton href="/report" variant="secondary">
            Report a Problem
          </CTAButton>
        </Reveal>

        <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {sampleIssues.map((issue, i) => (
            <Reveal key={issue.id} delayMs={i * 70}>
              <IssueCard issue={issue} />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
