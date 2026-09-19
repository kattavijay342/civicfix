import Image from "next/image";
import { Camera, Sparkles, FileCheck2, MapPin } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";

export function HowItWorks() {
  return (
    <section id="how-it-works" className="scroll-mt-16 bg-white py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="mx-auto max-w-2xl text-center">
          <span className="text-sm font-semibold text-civic-700">How It Works</span>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            From a photo to a resolved issue
          </h2>
          <p className="mt-3 text-base leading-relaxed text-foreground-muted">
            Three steps take a civic complaint from the street to the right desk — automatically.
          </p>
        </Reveal>

        <div className="mt-14 grid grid-cols-1 gap-6 md:grid-cols-3">
          {/* 01 — Capture */}
          <Reveal>
            <div className="group h-full overflow-hidden rounded-2xl border border-border bg-white transition-all duration-300 hover:-translate-y-1 hover:border-civic-200 hover:shadow-[0_16px_40px_-20px_rgba(20,64,47,0.3)]">
              <div className="relative h-36 w-full">
                <Image
                  src="/images/before-pothole.jpg"
                  alt="Citizen's photo of a pothole submitted with a CivicFix report"
                  fill
                  sizes="(min-width: 768px) 33vw, 100vw"
                  className="object-cover transition-transform duration-500 group-hover:scale-105"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
                <span className="absolute bottom-3 left-3 flex h-9 w-9 items-center justify-center rounded-xl bg-white text-civic-700 shadow-sm">
                  <Camera className="h-4.5 w-4.5" aria-hidden="true" />
                </span>
                <span className="absolute right-3 top-3 flex items-center gap-1 rounded-full bg-white/95 px-2 py-0.5 text-[10px] font-semibold text-foreground-muted">
                  <MapPin className="h-3 w-3" aria-hidden="true" />
                  Location tagged
                </span>
              </div>
              <div className="p-7">
                <span className="text-sm font-semibold text-civic-300 transition-colors group-hover:text-civic-500">
                  01
                </span>
                <h3 className="mt-2 text-lg font-semibold text-foreground">Capture</h3>
                <p className="mt-2 text-sm leading-relaxed text-foreground-muted">
                  Describe the issue or upload a photo.
                </p>
              </div>
            </div>
          </Reveal>

          {/* 02 — Understand */}
          <Reveal delayMs={120}>
            <div className="group flex h-full flex-col rounded-2xl border border-border bg-white p-7 transition-all duration-300 hover:-translate-y-1 hover:border-civic-200 hover:shadow-[0_16px_40px_-20px_rgba(20,64,47,0.3)]">
              <div className="relative flex h-36 items-center justify-center overflow-hidden rounded-xl bg-[radial-gradient(60%_60%_at_50%_40%,var(--color-civic-100),var(--color-surface-muted))]">
                <span className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-civic-600 text-white shadow-lg">
                  <Sparkles className="h-7 w-7" aria-hidden="true" />
                  <span className="absolute -right-1 -top-1 h-3 w-3 animate-ping rounded-full bg-civic-400" aria-hidden="true" />
                  <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-civic-300" aria-hidden="true" />
                </span>
                <div className="absolute inset-x-8 bottom-5 h-1.5 overflow-hidden rounded-full bg-white/70">
                  <div className="h-full w-2/3 rounded-full bg-civic-500" />
                </div>
              </div>
              <span className="mt-5 text-sm font-semibold text-civic-300 transition-colors group-hover:text-civic-500">
                02
              </span>
              <h3 className="mt-2 text-lg font-semibold text-foreground">Understand</h3>
              <p className="mt-2 text-sm leading-relaxed text-foreground-muted">
                AI identifies the problem and assesses severity.
              </p>
            </div>
          </Reveal>

          {/* 03 — Act */}
          <Reveal delayMs={240}>
            <div className="group flex h-full flex-col rounded-2xl border border-border bg-white p-7 transition-all duration-300 hover:-translate-y-1 hover:border-civic-200 hover:shadow-[0_16px_40px_-20px_rgba(20,64,47,0.3)]">
              <div className="relative flex h-36 items-center justify-center overflow-hidden rounded-xl bg-surface-muted">
                <div className="w-36 rounded-lg border border-border bg-white p-3 shadow-md">
                  <div className="flex items-center gap-1.5">
                    <FileCheck2 className="h-3.5 w-3.5 text-civic-600" aria-hidden="true" />
                    <span className="text-[10px] font-bold uppercase tracking-wide text-foreground">
                      Complaint
                    </span>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    <div className="h-1.5 w-full rounded-full bg-surface-muted" />
                    <div className="h-1.5 w-4/5 rounded-full bg-surface-muted" />
                    <div className="h-1.5 w-3/5 rounded-full bg-surface-muted" />
                  </div>
                  <div className="mt-2 inline-flex items-center rounded-full bg-civic-50 px-2 py-0.5 text-[9px] font-semibold text-civic-700">
                    Routed to Roads
                  </div>
                </div>
              </div>
              <span className="mt-5 text-sm font-semibold text-civic-300 transition-colors group-hover:text-civic-500">
                03
              </span>
              <h3 className="mt-2 text-lg font-semibold text-foreground">Act</h3>
              <p className="mt-2 text-sm leading-relaxed text-foreground-muted">
                Get a structured complaint and automatic department routing.
              </p>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
