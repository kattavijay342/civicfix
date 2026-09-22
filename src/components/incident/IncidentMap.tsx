"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { MapPinOff } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { statusLabels } from "@/components/ui/StatusBadge";
import { CivicMap } from "@/components/map/CivicMap";
import type { CivicMapIssueMarker } from "@/components/map/mapTypes";
import { isValidLatitude, isValidLongitude } from "@/lib/location/validation";
import type { IncidentReportLink } from "@/lib/types";

/**
 * "N citizen reports -> 1 civic incident" (spec §12) — plots every linked
 * report that actually has real coordinates; never fabricates a position
 * for one that doesn't (matches the honest-empty-state rule the existing
 * government MapPreview already follows, src/components/cards/MapPreview.tsx).
 */
export function IncidentMap({ links }: { links: IncidentReportLink[] }) {
  const router = useRouter();

  const markers: CivicMapIssueMarker[] = useMemo(
    () =>
      links
        .filter((l) => isValidLatitude(l.report.location.latitude) && isValidLongitude(l.report.location.longitude))
        .map((l) => ({
          id: l.report.id,
          latitude: l.report.location.latitude as number,
          longitude: l.report.location.longitude as number,
          priority: l.report.priority,
          title: l.report.title,
          statusLabel: statusLabels[l.report.status],
          department: l.report.department,
          reportedDateLabel: new Date(l.report.reportedDate).toLocaleDateString(),
        })),
    [links]
  );

  if (markers.length === 0) {
    return (
      <EmptyState
        icon={<MapPinOff className="h-5 w-5" aria-hidden="true" />}
        title="Location unavailable"
        description="None of the reports linked to this incident have recorded GPS coordinates yet."
      />
    );
  }

  return (
    <div>
      <div className="relative aspect-[16/9] w-full overflow-hidden rounded-2xl border border-border">
        <CivicMap mode="multi" issues={markers} onViewIssue={(id) => router.push(`/reports/${id}`)} fitToIssues />
      </div>
      <p className="mt-2 text-[11px] text-foreground-muted">
        {links.length} citizen report{links.length === 1 ? "" : "s"} → 1 civic incident. {markers.length} of{" "}
        {links.length} have recorded GPS coordinates and appear above.
      </p>
    </div>
  );
}
