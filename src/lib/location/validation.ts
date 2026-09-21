import type { SanitizedCoordinates } from "./types";

/**
 * Phase 6B — coordinate validation. Used both client-side (before a
 * location is even offered to the report form) and server-side (before
 * anything is persisted, in src/lib/actions/reports.ts) — never trust
 * client input alone. Rejects NaN/Infinity/out-of-range values and NEVER
 * substitutes a fake default like (0, 0); an invalid or missing coordinate
 * is `null`, exactly like "we don't know," never "we guessed."
 */

export function isValidLatitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}

export function isValidAccuracyMeters(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Returns a sanitized coordinate pair only if BOTH latitude and longitude
 * are individually valid; otherwise `null` (never a partial or defaulted
 * pair). `accuracy` is included only when it, too, is a valid non-negative
 * number — an invalid accuracy never invalidates otherwise-good coordinates,
 * it's just dropped.
 */
export function sanitizeCoordinates(
  latitude: unknown,
  longitude: unknown,
  accuracy?: unknown
): SanitizedCoordinates | null {
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null;
  return {
    latitude,
    longitude,
    accuracy: isValidAccuracyMeters(accuracy) ? accuracy : null,
  };
}
