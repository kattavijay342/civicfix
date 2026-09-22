import { Fragment } from "react";
import Image from "next/image";
import {
  ArrowRight,
  Sparkles,
  Flag,
  PlayCircle,
  CheckCircle2,
  MapPin,
  Building2,
  FilePlus2,
  Cpu,
  Route,
  Wrench,
} from "lucide-react";
import { CTAButton } from "@/components/ui/CTAButton";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import { Reveal } from "@/components/ui/Reveal";

/** The CivicFix value flow — short labels only, no numbers/metrics. Reads
 * as one continuous journey (connected by a single line on desktop, a
 * vertical line on mobile), not a stats widget. */
const valueFlow = [
  { icon: FilePlus2, label: "Report a problem" },
  { icon: Cpu, label: "AI analyzes it" },
  { icon: Route, label: "Right department" },
  { icon: Wrench, label: "Action taken" },
  { icon: CheckCircle2, label: "Track resolution" },
];

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-white">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[620px] bg-[radial-gradient(60%_50%_at_50%_0%,var(--color-civic-100),transparent)]"
        aria-hidden="true"
      />
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-12 px-4 py-14 sm:px-6 lg:grid-cols-2 lg:items-center lg:gap-12 lg:py-20 lg:px-8">
        <Reveal>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-civic-200 bg-civic-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-civic-700">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            AI-Powered Civic Solutions
          </span>
          <h1 className="mt-5 text-4xl font-semibold tracking-tight text-foreground leading-[1.1] sm:text-5xl sm:leading-[1.08] lg:text-[3.75rem] lg:leading-[1.06]">
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
            Report civic issues and automatically route them to the appropriate government
            department using AI.
          </p>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
            <CTAButton href="/report" size="lg" className="shadow-[0_12px_28px_-12px_rgba(31,122,81,0.55)]">
              <Flag className="h-4 w-4" aria-hidden="true" />
              Report a Problem
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </CTAButton>
            <CTAButton href="/#how-it-works" size="lg" variant="secondary">
              <PlayCircle className="h-4.5 w-4.5 text-civic-600" aria-hidden="true" />
              See How It Works
            </CTAButton>
          </div>

          <div className="mt-10 border-t border-border pt-6">
            <p className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
              From report to resolution
            </p>

            {/* Desktop/tablet: one continuous horizontal line connecting every
                step. Mobile: a vertical line — same idea, space-constrained. */}
            <div className="mt-5 hidden items-start sm:flex">
              {valueFlow.map((step, i) => (
                <Fragment key={step.label}>
                  <div className="flex w-24 shrink-0 flex-col items-center gap-2 text-center">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-civic-50 text-civic-700 transition-colors duration-200 hover:bg-civic-100">
                      <step.icon className="h-4.5 w-4.5" aria-hidden="true" />
                    </span>
                    <span className="text-[13px] font-medium leading-tight text-foreground">{step.label}</span>
                  </div>
                  {i < valueFlow.length - 1 && (
                    <div className="mt-5 h-px flex-1 bg-civic-300" aria-hidden="true" />
                  )}
                </Fragment>
              ))}
            </div>

            <div className="mt-4 flex flex-col gap-3 sm:hidden">
              {valueFlow.map((step, i) => (
                <div key={step.label} className="flex items-start gap-3">
                  <div className="flex flex-col items-center">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-civic-50 text-civic-700">
                      <step.icon className="h-4.5 w-4.5" aria-hidden="true" />
                    </span>
                    {i < valueFlow.length - 1 && <div className="mt-1 h-5 w-px bg-civic-300" aria-hidden="true" />}
                  </div>
                  <span className="pt-2 text-sm font-medium text-foreground">{step.label}</span>
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        <Reveal delayMs={150} className="relative mx-auto w-full max-w-md">
          {/* Purely decorative civic-map motif behind the image — soft,
              blurred land-shape patches plus a few location dots, evoking
              "map" without being one. No map provider, no tiles, no API
              calls; safe to remove without affecting anything (it renders
              nothing but static SVG shapes). */}
          <svg
            viewBox="0 0 400 400"
            aria-hidden="true"
            focusable="false"
            className="pointer-events-none absolute -inset-10 -z-10 h-[calc(100%+5rem)] w-[calc(100%+5rem)] opacity-60 sm:-inset-16 sm:h-[calc(100%+8rem)] sm:w-[calc(100%+8rem)] sm:opacity-90"
          >
            <defs>
              <filter id="hero-map-blur" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="22" />
              </filter>
              <radialGradient id="hero-map-fade" cx="46%" cy="42%" r="62%">
                <stop offset="0%" stopColor="white" stopOpacity="1" />
                <stop offset="70%" stopColor="white" stopOpacity="0.5" />
                <stop offset="100%" stopColor="white" stopOpacity="0" />
              </radialGradient>
              <mask id="hero-map-mask">
                <rect width="400" height="400" fill="url(#hero-map-fade)" />
              </mask>
            </defs>
            <g mask="url(#hero-map-mask)">
              <g filter="url(#hero-map-blur)">
                <ellipse cx="70" cy="110" rx="90" ry="70" fill="var(--color-civic-100)" opacity="0.9" />
                <ellipse cx="335" cy="85" rx="100" ry="80" fill="var(--color-civic-50)" opacity="0.95" />
                <ellipse cx="260" cy="300" rx="120" ry="90" fill="var(--color-civic-100)" opacity="0.85" />
                <ellipse cx="55" cy="320" rx="80" ry="60" fill="var(--color-civic-50)" opacity="0.85" />
              </g>
              <g fill="var(--color-civic-300)">
                <circle cx="120" cy="75" r="4" />
                <circle cx="300" cy="195" r="4" />
                <circle cx="175" cy="330" r="5" />
              </g>
            </g>
          </svg>

          <div
            className="absolute -right-3 -top-6 z-10 hidden items-center gap-2 rounded-2xl border border-border bg-white px-4 py-2.5 shadow-[0_10px_28px_-14px_rgba(20,64,47,0.4)] sm:flex"
            aria-hidden="true"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-civic-600 text-white">
              <Sparkles className="h-4.5 w-4.5" aria-hidden="true" />
            </span>
            <span className="leading-tight">
              <span className="block text-sm font-semibold text-foreground">Civic AI</span>
              <span className="block text-xs text-foreground-muted">Actionable insight</span>
            </span>
          </div>

          {/* Dashed "routing" curve trailing to the pin below — purely
              decorative, not a real path/route. */}
          <svg
            viewBox="0 0 80 110"
            aria-hidden="true"
            focusable="false"
            className="pointer-events-none absolute -right-2 top-10 hidden h-28 w-20 opacity-70 sm:block"
          >
            <path
              d="M8 100 C 42 78, 18 34, 62 12"
              fill="none"
              stroke="var(--color-civic-300)"
              strokeWidth="2"
              strokeDasharray="4 6"
              strokeLinecap="round"
            />
          </svg>

          <span
            className="absolute -right-6 top-24 z-10 hidden h-9 w-9 items-center justify-center rounded-full bg-civic-600 text-white shadow-[0_10px_24px_-10px_rgba(20,64,47,0.45)] sm:flex"
            aria-hidden="true"
          >
            <MapPin className="h-4.5 w-4.5" aria-hidden="true" />
          </span>

          <div className="relative overflow-hidden rounded-3xl border border-border shadow-[0_24px_50px_-28px_rgba(20,64,47,0.4)]">
            <div className="relative aspect-[4/3] w-full">
              <Image
                src="/images/issue-drainage.jpg"
                alt="A waterlogged street in Kolkata after heavy rain — the kind of civic drainage problem citizens report on CivicFix"
                fill
                priority
                sizes="(min-width: 1024px) 480px, 90vw"
                className="object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/35 via-black/0 to-black/0" />
            </div>
          </div>

          <div className="relative -mt-14 ml-4 mr-4 rounded-2xl border border-border bg-white/97 p-3.5 shadow-[0_16px_36px_-20px_rgba(20,64,47,0.3)] backdrop-blur sm:ml-8 sm:mr-0 sm:w-[268px]">
            <div className="flex items-center gap-2 border-b border-border pb-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-civic-600 text-white">
                <Sparkles className="h-3 w-3" aria-hidden="true" />
              </span>
              <span className="text-sm font-semibold text-foreground">AI Analysis</span>
              <span className="ml-auto inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-civic-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-civic-700">
                <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                Detected
              </span>
            </div>

            <p className="mt-2 text-sm font-semibold text-foreground">Drainage blockage detected</p>

            <dl className="divide-y divide-border text-xs">
              <div className="flex items-center justify-between py-1">
                <dt className="text-foreground-muted">Priority</dt>
                <dd>
                  <PriorityBadge priority="HIGH" />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 py-1">
                <dt className="flex shrink-0 items-center gap-1.5 text-foreground-muted">
                  <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Department
                </dt>
                <dd className="text-right font-semibold text-civic-700">Municipal Drainage Department</dd>
              </div>
              <div className="flex items-center justify-between py-1">
                <dt className="text-foreground-muted">Location</dt>
                <dd className="flex items-center gap-1 font-semibold text-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-civic-600" aria-hidden="true" />
                  Confirmed
                </dd>
              </div>
            </dl>

            <CTAButton href="/report" size="md" className="mt-1.5 w-full justify-center">
              View Details <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </CTAButton>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
