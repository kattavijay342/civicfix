import { ArrowRight } from "lucide-react";
import { CTAButton } from "@/components/ui/CTAButton";
import { Reveal } from "@/components/ui/Reveal";

export function FinalCTA() {
  return (
    <section className="bg-civic-900 py-20 sm:py-24">
      <Reveal className="mx-auto flex max-w-3xl flex-col items-center px-4 text-center sm:px-6 lg:px-8">
        <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Turn the next civic problem into action
        </h2>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-civic-100">
          Report an issue in minutes, or explore how CivicFix routes and tracks it end to end.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <CTAButton href="/report" size="lg" icon={<ArrowRight className="h-4 w-4" />}>
            Report a Problem
          </CTAButton>
          <CTAButton href="/#how-it-works" size="lg" variant="secondary" className="bg-transparent text-white border-white/30 hover:bg-white/10 hover:border-white/50">
            Explore CivicFix
          </CTAButton>
        </div>
      </Reveal>
    </section>
  );
}
