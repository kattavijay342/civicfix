/**
 * Mapbox integration — shared config. Reads the same `NEXT_PUBLIC_*` value
 * on both server (search/reverse-geocode server actions) and client (the
 * interactive map), since a Mapbox access token is meant to be public
 * (scope it to your URL(s) in the Mapbox account dashboard) — unlike
 * GOOGLE_MAPS_API_KEY, which stayed server-only. Every caller must treat a
 * missing token as "map/search unavailable," never crash.
 */

export function getMapboxToken(): string | null {
  const token = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;
  return token && token.trim() ? token.trim() : null;
}

export function isMapboxConfigured(): boolean {
  return getMapboxToken() !== null;
}

/** Light, modern style to match CivicFix's existing SaaS look — not the
 * default Mapbox demo streets style. */
export const MAPBOX_STYLE_URL = "mapbox://styles/mapbox/light-v11";

/** Reports app-wide are about Andhra Pradesh / Telangana (see
 * src/lib/jurisdiction.ts) — used only to bias search relevance and pick a
 * sensible default map center when there's nothing else to center on. */
export const DEFAULT_MAP_CENTER: [number, number] = [79.74, 16.3]; // [lng, lat]
export const DEFAULT_MAP_ZOOM = 6.5;
export const SEARCH_COUNTRY = "IN";
