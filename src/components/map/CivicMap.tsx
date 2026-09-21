"use client";

import dynamic from "next/dynamic";
import { MapPinOff } from "lucide-react";
import { isMapboxConfigured } from "@/lib/location/mapbox-config";
import type { CivicMapProps } from "./mapTypes";
import { cn } from "@/lib/utils";

const CivicMapView = dynamic(() => import("./CivicMapView"), {
  ssr: false,
  loading: () => <MapSkeleton />,
});

function MapSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-[#eef3ee]">
      <p className="text-xs text-foreground-muted">Loading map…</p>
    </div>
  );
}

/**
 * Public entry point for every Mapbox map in the app (report creation's
 * pin picker, the government/landing issue map, the report-detail
 * mini-map). Rule 21 — a missing/invalid token, or mapbox-gl failing to
 * load, must never crash the page; this renders an honest, styled fallback
 * instead and every caller keeps working without it (manual jurisdiction
 * entry, GPS capture, and viewing a report's structured location fields are
 * all independent of whether a map renders).
 */
export function CivicMap(props: CivicMapProps) {
  if (!isMapboxConfigured()) {
    return (
      <div
        className={cn(
          "flex h-full w-full flex-col items-center justify-center gap-2 rounded-[inherit] bg-[#eef3ee] px-6 text-center",
          props.className
        )}
      >
        <MapPinOff className="h-5 w-5 text-foreground-muted" aria-hidden="true" />
        <p className="text-xs font-medium text-foreground-muted">
          Interactive map unavailable — no map provider is configured.
        </p>
      </div>
    );
  }

  return <CivicMapView {...props} />;
}
