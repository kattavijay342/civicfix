import { MapPreview } from "@/components/cards/MapPreview";
import { Reveal } from "@/components/ui/Reveal";

export function IssueMapSection() {
  return (
    <section className="bg-surface-muted py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="mx-auto max-w-2xl text-center">
          <span className="text-sm font-semibold text-civic-700">Issue Map</span>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Where are civic problems concentrated?
          </h2>
          <p className="mt-3 text-base leading-relaxed text-foreground-muted">
            Markers show priority at a glance; shaded zones highlight where issues cluster.
            Select a marker to preview the issue.
          </p>
        </Reveal>

        <Reveal delayMs={120} className="mt-10">
          <MapPreview />
        </Reveal>

        <p className="mt-4 text-center text-xs text-foreground-muted">
          Preview surface with sample coordinates — a live map provider (Google Maps, Mapbox, or
          Leaflet) can be connected behind this layout in a later phase.
        </p>
      </div>
    </section>
  );
}
