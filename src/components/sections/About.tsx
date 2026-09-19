import { ShieldCheck, Users, Building2 } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";

const pillars = [
  {
    icon: Users,
    title: "For citizens",
    description: "A simple way to report a problem and see it through to resolution.",
  },
  {
    icon: ShieldCheck,
    title: "For government teams",
    description: "Clear oversight of what's pending, what's urgent, and who's accountable.",
  },
  {
    icon: Building2,
    title: "For departments",
    description: "Issues arrive pre-triaged and already routed — no inbox to sort through.",
  },
];

export function About() {
  return (
    <section id="about" className="scroll-mt-16 bg-white py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="mx-auto max-w-2xl text-center">
          <span className="text-sm font-semibold text-civic-700">About CivicFix</span>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Built to close the loop on civic problems
          </h2>
          <p className="mt-3 text-base leading-relaxed text-foreground-muted">
            Most civic issues stall between being noticed and being fixed. CivicFix uses AI to
            remove the manual triage step, so problems reach the right department immediately and
            stay visible until they&apos;re resolved.
          </p>
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-3">
          {pillars.map((pillar) => {
            const Icon = pillar.icon;
            return (
              <Reveal key={pillar.title}>
                <div className="rounded-2xl border border-border bg-white p-6 text-center">
                  <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-civic-50 text-civic-700">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <h3 className="mt-4 text-sm font-semibold text-foreground">{pillar.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-foreground-muted">
                    {pillar.description}
                  </p>
                </div>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
