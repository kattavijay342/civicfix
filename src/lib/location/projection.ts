/**
 * Phase 6B — real-coordinate projection for the Government Dashboard map
 * (src/components/cards/MapPreview.tsx). No map tile provider is
 * configured, so there's no real basemap underneath, but marker POSITIONS
 * are genuinely derived from each report's own latitude/longitude via a
 * min/max bounding-box projection — never from a hash of the report id or
 * any other fabricated placement.
 */

export interface GeoPoint {
  id: string;
  latitude: number;
  longitude: number;
}

export interface ProjectedPoint extends GeoPoint {
  xPercent: number;
  yPercent: number;
}

export interface Bounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export function computeBounds(points: GeoPoint[]): Bounds | null {
  if (points.length === 0) return null;
  let minLat = points[0].latitude;
  let maxLat = points[0].latitude;
  let minLng = points[0].longitude;
  let maxLng = points[0].longitude;
  for (const p of points) {
    if (p.latitude < minLat) minLat = p.latitude;
    if (p.latitude > maxLat) maxLat = p.latitude;
    if (p.longitude < minLng) minLng = p.longitude;
    if (p.longitude > maxLng) maxLng = p.longitude;
  }
  return { minLat, maxLat, minLng, maxLng };
}

/** Keeps markers off the very edge of the plotted surface. */
const PADDING_PERCENT = 12;

/**
 * Projects each point to an {xPercent, yPercent} position within the
 * plotted surface, based on where it sits within the real bounding box of
 * ALL the given points. A degenerate range (every point shares the same
 * latitude or longitude — including the single-point case) centers on that
 * axis instead of dividing by zero.
 */
export function projectPoints(points: GeoPoint[]): ProjectedPoint[] {
  const bounds = computeBounds(points);
  if (!bounds) return [];
  const latRange = bounds.maxLat - bounds.minLat;
  const lngRange = bounds.maxLng - bounds.minLng;
  const usable = 100 - PADDING_PERCENT * 2;

  return points.map((p) => {
    const xPercent = lngRange === 0 ? 50 : PADDING_PERCENT + ((p.longitude - bounds.minLng) / lngRange) * usable;
    // Latitude increases northward; screen y increases downward — invert.
    const yPercent = latRange === 0 ? 50 : PADDING_PERCENT + ((bounds.maxLat - p.latitude) / latRange) * usable;
    return { ...p, xPercent, yPercent };
  });
}

export interface DensityCell {
  xPercent: number;
  yPercent: number;
  count: number;
}

/**
 * Bins already-projected points into an NxN grid and returns only the
 * non-empty cells, with a real count derived from actual coordinates — this
 * replaces a set of fixed, decorative "heat zone" circles that used to
 * render at the same spot regardless of the underlying data.
 */
export function computeDensityGrid(projected: ProjectedPoint[], gridSize = 6): DensityCell[] {
  if (projected.length === 0) return [];
  const cellSize = 100 / gridSize;
  const counts = new Map<string, number>();
  for (const p of projected) {
    const cx = Math.min(gridSize - 1, Math.floor(p.xPercent / cellSize));
    const cy = Math.min(gridSize - 1, Math.floor(p.yPercent / cellSize));
    const key = `${cx}:${cy}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => {
    const [cx, cy] = key.split(":").map(Number);
    return {
      xPercent: cx * cellSize + cellSize / 2,
      yPercent: cy * cellSize + cellSize / 2,
      count,
    };
  });
}
