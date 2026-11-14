"use server";

import { reverseGeocode } from "@/lib/location/reverse-geocoding";
import { isValidLatitude, isValidLongitude } from "@/lib/location/validation";
import type { ReverseGeocodeOutcome } from "@/lib/location/types";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, retryAfterMessage } from "@/lib/rate-limit";

/**
 * Phase 6B — the only way the client ever reaches reverse geocoding. Keeps
 * the provider token server-side and validates the coordinates before
 * making any provider call. Called for a GPS fix and when a map pin is
 * confirmed (see SmartLocationField), which caches results per coordinate
 * pair so the same spot is never looked up twice.
 *
 * Every export of a "use server" file is a public HTTP endpoint, so this
 * requires a signed-in session (the report form it serves already does)
 * and is rate-limited per user — otherwise an anonymous caller could spend
 * the app's paid geocoding quota freely.
 */
export async function attemptReverseGeocode(latitude: number, longitude: number): Promise<ReverseGeocodeOutcome> {
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    return { status: "unavailable", reason: "Invalid coordinates." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "unavailable", reason: "Sign in to look up an address." };

  const rateLimit = await checkRateLimit(`reverse_geocode:${user.id}`, 60, 10 * 60);
  if (!rateLimit.allowed) return { status: "unavailable", reason: retryAfterMessage(rateLimit.retryAfterSeconds) };

  return reverseGeocode(latitude, longitude);
}
