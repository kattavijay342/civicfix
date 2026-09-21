/**
 * Phase 6B — shared location types. Kept separate from the app-wide
 * `CivicLocation` (src/lib/types.ts) because these describe the *provider
 * boundary* (what an external service could return), not what's stored on a
 * report. See src/lib/location/reverse-geocoding.ts for why every field
 * here is optional and no result is ever fabricated.
 */

export interface ReverseGeocodeResult {
  formattedAddress: string;
  landmark?: string;
}

export type ReverseGeocodeOutcome =
  | { status: "ok"; result: ReverseGeocodeResult }
  | { status: "unavailable"; reason: string };

/** A validated, sanitized coordinate pair — see validation.ts. `accuracy` is
 * in meters, only present when the source (e.g. GPS) actually reported one. */
export interface SanitizedCoordinates {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

/**
 * One forward-geocoding/search suggestion, already trimmed down to what the
 * UI needs. `label` is the place name (e.g. "Sattenapalli RTC Bus Stand"),
 * `context` is the rest of the address for disambiguation (e.g.
 * "Sattenapalli, Palnadu, Andhra Pradesh"). Never fabricated — every field
 * here is copied straight from the provider's own response.
 */
export interface LocationSearchSuggestion {
  id: string;
  label: string;
  context?: string;
  latitude: number;
  longitude: number;
  placeType?: string;
}

export type LocationSearchOutcome =
  | { status: "ok"; results: LocationSearchSuggestion[] }
  | { status: "unavailable"; reason: string };
