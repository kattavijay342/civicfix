"use client";

import { useState } from "react";
import { MapPin, X } from "lucide-react";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import type { CivicIssue } from "@/lib/types";
import { locationHeadline } from "@/lib/location-format";
import { sampleIssues } from "@/lib/sample-data";
import { cn } from "@/lib/utils";

interface MapMarker extends Pick<CivicIssue, "id" | "title" | "location" | "priority" | "department"> {
  x: number;
  y: number;
}

const markerPositions: Record<string, { x: number; y: number }> = {
  "CF-1042": { x: 28, y: 38 },
  "CF-1039": { x: 52, y: 24 },
  "CF-1035": { x: 68, y: 55 },
  "CF-1021": { x: 40, y: 68 },
  "CF-1018": { x: 78, y: 32 },
  "CF-0998": { x: 20, y: 62 },
};

/**
 * Markers are built from the same sample issues (and their structured
 * State/District/Constituency/Area location) used across the rest of the
 * app, so every marker can eventually carry full jurisdiction metadata —
 * x/y here are decorative placeholder screen-space coordinates, not real
 * lat/lng, until a real map provider is connected.
 */
const markers: MapMarker[] = sampleIssues
  .filter((issue) => markerPositions[issue.id])
  .map((issue) => ({
    id: issue.id,
    title: issue.title,
    location: issue.location,
    priority: issue.priority,
    department: issue.department,
    ...markerPositions[issue.id],
  }));

const markerColor: Record<MapMarker["priority"], string> = {
  CRITICAL: "bg-priority-critical",
  HIGH: "bg-priority-high",
  MEDIUM: "bg-priority-medium",
  LOW: "bg-priority-low",
};

const heatZones = [
  { x: 32, y: 42, size: 90, opacity: 0.16 },
  { x: 60, y: 30, size: 70, opacity: 0.12 },
  { x: 40, y: 66, size: 75, opacity: 0.13 },
];

/**
 * Stylized, provider-agnostic map surface. No real geocoding/tiles are wired
 * up yet — this establishes the marker/heatmap layout so a real map SDK
 * (Google Maps, Mapbox, Leaflet, etc.) can be dropped in behind these
 * coordinates in a later phase without reworking the UI.
 */
export function MapPreview() {
  const [active, setActive] = useState<MapMarker | null>(markers[0]);

  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-border bg-[#eef3ee] sm:aspect-[16/9]">
      <svg className="absolute inset-0 h-full w-full opacity-60" aria-hidden="true">
        <defs>
          <pattern id="map-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#d5ded5" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#map-grid)" />
      </svg>

      <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
        <path
          d="M0,120 C150,80 250,160 400,110 C500,80 600,140 800,100"
          fill="none"
          stroke="#c9d4c9"
          strokeWidth="10"
        />
        <path
          d="M100,0 C140,120 90,240 160,340"
          fill="none"
          stroke="#c9d4c9"
          strokeWidth="8"
        />
        <path
          d="M0,260 C120,240 260,300 420,260 C560,230 640,280 800,250"
          fill="none"
          stroke="#c9d4c9"
          strokeWidth="7"
        />
        <path
          d="M320,0 C300,140 360,220 340,340"
          fill="none"
          stroke="#c9d4c9"
          strokeWidth="6"
        />
      </svg>

      <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
        {heatZones.map((zone, i) => (
          <circle
            key={i}
            cx={`${zone.x}%`}
            cy={`${zone.y}%`}
            r={zone.size}
            fill="var(--color-priority-critical)"
            opacity={zone.opacity}
          />
        ))}
      </svg>

      <div
        className="absolute left-[8%] top-[15%] h-[32%] w-[38%] rounded-3xl border border-dashed border-civic-300"
        aria-hidden="true"
      />
      <span className="absolute left-[9%] top-[12%] text-[10px] font-semibold uppercase tracking-wide text-civic-700">
        Zone 2
      </span>

      {markers.map((marker) => (
        <button
          key={marker.id}
          type="button"
          onClick={() => setActive(marker)}
          className={cn(
            "absolute flex h-6 w-6 -translate-x-1/2 -translate-y-full items-center justify-center rounded-full border-2 border-white shadow-md transition-transform hover:scale-110",
            markerColor[marker.priority],
            active?.id === marker.id && "ring-2 ring-offset-2 ring-civic-500",
          )}
          style={{ left: `${marker.x}%`, top: `${marker.y}%` }}
          aria-label={`${marker.title} — ${marker.priority.toLowerCase()} priority`}
          aria-pressed={active?.id === marker.id}
        >
          <MapPin className="h-3.5 w-3.5 text-white" aria-hidden="true" />
        </button>
      ))}

      {active && (
        <div className="absolute bottom-3 left-3 right-3 flex items-start justify-between gap-3 rounded-xl border border-border bg-white/95 p-4 shadow-lg backdrop-blur sm:left-4 sm:right-auto sm:w-72">
          <div>
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              <MapPin className="h-3 w-3" aria-hidden="true" />
              Issue marker
            </span>
            <p className="mt-1.5 text-sm font-semibold leading-snug text-foreground">
              {active.title}
            </p>
            <div className="mt-1.5">
              <PriorityBadge priority={active.priority} />
            </div>
            <p className="mt-1.5 text-xs text-foreground-muted">{locationHeadline(active.location)}</p>
            <p className="mt-0.5 text-xs font-medium text-civic-700">{active.department}</p>
          </div>
          <button
            type="button"
            onClick={() => setActive(null)}
            className="rounded-full p-1 text-foreground-muted hover:bg-surface-muted hover:text-foreground"
            aria-label="Close issue preview"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
