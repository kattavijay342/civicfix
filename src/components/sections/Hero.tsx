import Image from "next/image";
import { ArrowRight, Sparkles, AlertTriangle, Building2 } from "lucide-react";
import { CTAButton } from "@/components/ui/CTAButton";
import { Reveal } from "@/components/ui/Reveal";

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-white">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[620px] bg-[radial-gradient(60%_50%_at_50%_0%,var(--color-civic-100),transparent)]"
        aria-hidden="true"
      />
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-16 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:items-center lg:gap-10 lg:py-24 lg:px-8">
        <Reveal>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-civic-200 bg-civic-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-civic-700">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            AI Civic Problem Solver
          </span>
          <h1 className="mt-5 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-[3.4rem] lg:leading-[1.08]">
            See a problem.
            <br />
            Turn it into{" "}
            <span className="relative inline-block text-civic-600">
              action.
              <svg
                viewBox="0 0 160 12"
                className="absolute -bottom-1.5 left-0 h-2.5 w-full text-civic-300"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <path
                  d="M2 8.5C34 2.5 100 2.5 158 8.5"
                  stroke="currentColor"
                  strokeWidth="4"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
            </span>
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-foreground-muted">
            CivicFix uses AI to understand everyday civic problems and turn them into clear,
            actionable reports.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <CTAButton href="/report" size="lg" icon={<ArrowRight className="h-4 w-4" />}>
              Report a Problem
            </CTAButton>
            <CTAButton href="/#how-it-works" size="lg" variant="secondary">
              See How It Works
            </CTAButton>
          </div>
          <dl className="mt-12 grid max-w-md grid-cols-3 gap-6 border-t border-border pt-6">
            <div>
              <dt className="text-xs font-medium text-foreground-muted">Issue types</dt>
              <dd className="mt-1 text-xl font-semibold text-foreground">8+</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-foreground-muted">Avg. routing time</dt>
              <dd className="mt-1 text-xl font-semibold text-foreground">&lt; 1 min</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-foreground-muted">Manual assignment</dt>
              <dd className="mt-1 text-xl font-semibold text-foreground">0</dd>
            </div>
          </dl>
        </Reveal>

        <Reveal delayMs={150} className="relative mx-auto w-full max-w-md">
          <div
            className="absolute -right-8 -top-8 hidden h-40 w-56 -rotate-3 overflow-hidden rounded-2xl border border-border shadow-lg sm:block"
            aria-hidden="true"
          >
            <Image
              src="/images/city-bg.jpg"
              alt=""
              fill
              sizes="224px"
              className="object-cover opacity-90"
            />
          </div>

          <div className="relative overflow-hidden rounded-3xl border border-border shadow-[0_30px_70px_-30px_rgba(20,64,47,0.4)]">
            <div className="relative aspect-[4/3] w-full">
              <Image
                src="/images/hero-pothole.jpg"
                alt="A large pothole in a damaged road, the kind of civic issue citizens report on CivicFix"
                fill
                priority
                sizes="(min-width: 1024px) 480px, 90vw"
                className="object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/35 via-black/0 to-black/0" />
            </div>
          </div>

          <div className="relative -mt-16 ml-4 mr-4 rounded-2xl border border-border bg-white/97 p-5 shadow-[0_20px_50px_-20px_rgba(20,64,47,0.35)] backdrop-blur sm:ml-8 sm:mr-0 sm:w-80">
            <div className="flex items-center gap-2 border-b border-border pb-3">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-civic-600 text-white">
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <span className="text-sm font-semibold text-foreground">AI Analysis</span>
              <span className="ml-auto flex items-center gap-1 rounded-full bg-priority-critical-bg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-priority-critical">
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                High Severity
              </span>
            </div>

            <p className="mt-3 text-sm font-semibold text-foreground">Pothole Detected</p>

            <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <div>
                <span className="text-foreground-muted">Category</span>
                <p className="mt-0.5 font-semibold text-foreground">Road Infrastructure</p>
              </div>
              <div>
                <span className="text-foreground-muted">Severity Score</span>
                <p className="mt-0.5 font-semibold text-foreground">82 / 100</p>
              </div>
            </div>

            <div className="mt-3">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
                <div className="h-full w-[82%] rounded-full bg-priority-high" />
              </div>
            </div>

            <div className="mt-3 flex items-center gap-1.5 text-xs">
              <Building2 className="h-3.5 w-3.5 text-foreground-muted" aria-hidden="true" />
              <span className="text-foreground-muted">Suggested Authority</span>
            </div>
            <p className="text-sm font-semibold text-civic-700">Municipal Roads Department</p>

            <CTAButton href="/report" size="md" className="mt-4 w-full justify-center">
              Generate Complaint <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </CTAButton>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
