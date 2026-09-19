import { Sparkles, Building2, Route, Languages } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";

const features = [
  {
    icon: Sparkles,
    title: "AI Analysis",
    description: "Understands the problem and its severity.",
  },
  {
    icon: Building2,
    title: "Right Authority",
    description: "Finds the relevant department.",
  },
  {
    icon: Route,
    title: "Track Progress",
    description: "Get updates until the issue is resolved.",
  },
  {
    icon: Languages,
    title: "Bilingual",
    description: "Telugu & English support.",
  },
];

export function FeatureStrip() {
  return (
    <section className="border-y border-border bg-surface-muted/60">
      <Reveal className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4 sm:divide-x sm:divide-border">
          {features.map((f) => {
            const Icon = f.icon;
            return (
              <div key={f.title} className="flex items-center gap-3 sm:px-5 sm:first:pl-0">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-civic-50 text-civic-700">
                  <Icon className="h-4.5 w-4.5" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-foreground">{f.title}</p>
                  <p className="text-xs leading-snug text-foreground-muted">{f.description}</p>
                </div>
              </div>
            );
          })}
        </div>
      </Reveal>
    </section>
  );
}
