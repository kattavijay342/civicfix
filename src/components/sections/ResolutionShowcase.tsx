import { BeforeAfterCard } from "@/components/cards/BeforeAfterCard";
import { Reveal } from "@/components/ui/Reveal";

export function ResolutionShowcase() {
  return (
    <section className="bg-white py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-center lg:gap-16">
          <Reveal>
            <span className="text-sm font-semibold text-civic-700">Resolution Tracking</span>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Every report is tracked to resolution
            </h2>
            <p className="mt-3 max-w-md text-base leading-relaxed text-foreground-muted">
              CivicFix keeps a visible record from the first report to the final fix — the
              department, the date, and the outcome.
            </p>
          </Reveal>
          <Reveal delayMs={120}>
            <BeforeAfterCard
              beforeSrc="/images/before-pothole.jpg"
              beforeAlt="Damaged road with a large pothole before repair"
              afterSrc="/images/after-road-repair.jpg"
              afterAlt="Road repair crew resurfacing the damaged road"
              title="Large pothole blocking left lane"
              department="Roads Department"
              resolvedDate="Sep 4, 2026"
            />
          </Reveal>
        </div>
      </div>
    </section>
  );
}
