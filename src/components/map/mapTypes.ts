import type { Priority } from "@/lib/types";

/** A single plotted issue marker — every field is real data already resolved
 * by the caller (CivicMap never fetches or fabricates anything). */
export interface CivicMapIssueMarker {
  id: string;
  latitude: number;
  longitude: number;
  priority: Priority;
  title: string;
  statusLabel: string;
  department: string;
  reportedDateLabel: string;
}

export interface CivicMapProps {
  className?: string;
  /** "single" = one (optionally draggable) pin, e.g. report creation/detail.
   * "multi" = many issue markers with clustering, e.g. government/landing maps. */
  mode: "single" | "multi";

  center?: [number, number];
  zoom?: number;

  /** Single-pin mode only. `null` renders the map with no pin yet. */
  singleMarker?: { latitude: number; longitude: number } | null;
  draggable?: boolean;
  onSingleMarkerMove?: (latitude: number, longitude: number) => void;

  /** Multi-pin mode only. */
  issues?: CivicMapIssueMarker[];
  onViewIssue?: (id: string) => void;
  /** Only rendered once there's enough data for a meaningful picture. */
  showDensity?: boolean;

  /** Bumping this (e.g. a counter or `${lat},${lng}`) imperatively re-centers
   * the map — used after a search result is selected or GPS resolves. */
  flyToKey?: string;
  fitToIssues?: boolean;
}

export const PRIORITY_COLORS: Record<Priority, string> = {
  CRITICAL: "#dc2626",
  HIGH: "#ea580c",
  MEDIUM: "#d97706",
  LOW: "#65a30d",
};

export const PRIORITY_LETTER: Record<Priority, string> = {
  CRITICAL: "C",
  HIGH: "H",
  MEDIUM: "M",
  LOW: "L",
};
