"use server";

import { reverseGeocode } from "@/lib/location/reverse-geocoding";
import { isValidLatitude, isValidLongitude } from "@/lib/location/validation";
import type { ReverseGeocodeOutcome } from "@/lib/location/types";

/**
 * Phase 6B — the only way the client ever reaches reverse geocoding. Keeps
 * GOOGLE_MAPS_API_KEY server-only (never sent to the client) and validates
 * the coordinates before making any provider call. Called once per
 * confirmed GPS fix (see SmartLocationField) — never on every render or
 * repeatedly for the same fix, so there's nothing to debounce/cache yet;
 * revisit if a real provider with per-call cost is ever wired in.
 */
export async function attemptReverseGeocode(latitude: number, longitude: number): Promise<ReverseGeocodeOutcome> {
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    return { status: "unavailable", reason: "Invalid coordinates." };
  }
  return reverseGeocode(latitude, longitude);
}
