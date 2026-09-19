import { BrainCircuit, Target, Route } from "lucide-react";
import { AIAnalysisCard } from "@/components/cards/AIAnalysisCard";
import { Reveal } from "@/components/ui/Reveal";

const highlights = [
  {
    icon: BrainCircuit,
    title: "Understands the report",
    description: "Reads description and photo.",
  },
  {
    icon: Target,
    title: "Scores severity",
    description: "Evaluates safety risk and urgency.",
  },
  {
    icon: Route,
    title: "Routes automatically",
    description: "Identifies the corresponding department and in-charge.",
  },
];

export function AIIntelligence() {
  return (
    <section className="bg-white py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-14 lg:grid-cols-2 lg:items-center lg:gap-16">
          <Reveal>
            <span className="text-sm font-semibold text-civic-700">AI Intelligence</span>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Every report gets read, scored, and routed
            </h2>
            <p className="mt-3 max-w-lg text-base leading-relaxed text-foreground-muted">
              Instead of a citizen guessing which department to contact, AI performs the initial
              triage consistently and quickly.
            </p>

            <div className="mt-9 flex flex-col gap-6">
              {highlights.map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.title} className="flex gap-3.5">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-civic-50 text-civic-700">
                      <Icon className="h-4.5 w-4.5" aria-hidden="true" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">{item.title}</h3>
                      <p className="mt-1 text-sm leading-relaxed text-foreground-muted">
                        {item.description}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </Reveal>

          <Reveal delayMs={150} className="flex justify-center lg:justify-end">
            <AIAnalysisCard
              imageSrc="/images/ai-analysis-pothole.jpg"
              imageAlt="Large pothole in a damaged road on MG Road, the civic issue this AI analysis describes"
              problem="Large pothole on main road"
              location="MG Road, Sector 4"
              priority="HIGH"
              confidence={94}
              department="Roads"
            />
          </Reveal>
        </div>
      </div>
    </section>
  );
}
