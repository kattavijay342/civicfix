"use client";

import { useState } from "react";
import { MapPin } from "lucide-react";
import { CivicMap } from "@/components/map/CivicMap";
import { isValidLatitude, isValidLongitude } from "@/lib/location/validation";

/**
 * Report detail's "[View on Map]" (rule 17) — deferred behind a toggle so a
 * report page doesn't load mapbox-gl on every view, only when someone
 * actually asks to see the map. Never fabricates a location: a report
 * without valid stored coordinates gets an honest message instead of a map.
 */
export function ReportLocationMap({
  latitude,
  longitude,
}: {
  latitude: number | null | undefined;
  longitude: number | null | undefined;
}) {
  const [open, setOpen] = useState(false);

  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    return <p className="mt-3 text-xs text-foreground-muted">Location coordinates are not available for this report.</p>;
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-civic-700 hover:underline"
      >
        <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
        {open ? "Hide map" : "View on Map"}
      </button>
      {open && (
        <div className="relative mt-3 aspect-[16/9] overflow-hidden rounded-xl border border-border">
          <CivicMap
            mode="single"
            singleMarker={{ latitude, longitude }}
            draggable={false}
            center={[longitude, latitude]}
            zoom={15}
          />
        </div>
      )}
    </div>
  );
}
