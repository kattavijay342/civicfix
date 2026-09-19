import {
  Construction,
  Trash2,
  Waves,
  Droplet,
  Lightbulb,
  ShieldAlert,
  PackageX,
  Building,
} from "lucide-react";
import { ProblemTypeCard } from "@/components/cards/ProblemTypeCard";
import { Reveal } from "@/components/ui/Reveal";

const problemTypes = [
  {
    icon: Construction,
    label: "Road & Potholes",
    description: "Damaged roads, potholes, and unsafe surfaces.",
    accent: "amber" as const,
  },
  {
    icon: Trash2,
    label: "Garbage",
    description: "Overflowing bins and uncollected waste.",
    accent: "civic" as const,
  },
  {
    icon: Waves,
    label: "Drainage",
    description: "Blocked or overflowing storm drains.",
    accent: "blue" as const,
  },
  {
    icon: Lightbulb,
    label: "Streetlights",
    description: "Non-functional or damaged street lighting.",
    accent: "amber" as const,
  },
  {
    icon: Droplet,
    label: "Water Leakage",
    description: "Pipeline leaks and water loss on streets.",
    accent: "blue" as const,
  },
  {
    icon: ShieldAlert,
    label: "Sewage",
    description: "Sewage overflow and sanitation hazards.",
    accent: "rose" as const,
  },
  {
    icon: PackageX,
    label: "Illegal Dumping",
    description: "Debris and waste dumped in public spaces.",
    accent: "rose" as const,
  },
  {
    icon: Building,
    label: "Public Infrastructure",
    description: "Footpaths, signage, and shared civic property.",
    accent: "civic" as const,
  },
];

export function ProblemTypes() {
  return (
    <section className="bg-surface-muted py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="mx-auto max-w-2xl text-center">
          <span className="text-sm font-semibold text-civic-700">What You Can Report</span>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            What kind of problems can you report?
          </h2>
          <p className="mt-3 text-base leading-relaxed text-foreground-muted">
            If it affects your street, neighborhood, or public space — CivicFix routes it to the
            right people.
          </p>
        </Reveal>

        <div className="mt-12 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {problemTypes.map((type, i) => (
            <Reveal key={type.label} delayMs={i * 60}>
              <ProblemTypeCard
                icon={type.icon}
                label={type.label}
                description={type.description}
                accent={type.accent}
              />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
