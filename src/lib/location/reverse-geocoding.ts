import "server-only";
import { getMapboxToken } from "./mapbox-config";
import type { ReverseGeocodeOutcome } from "./types";

/**
 * Modular reverse-geocoding boundary (Phase 4 Step 4, relocated into
 * src/lib/location/ in Phase 6B, wired to Mapbox here). Coordinates are
 * converted into a readable address ONLY when Mapbox is configured and
 * actually returns one — never fabricated. Structured location entry
 * (state/district/constituency/area/landmark) plus raw GPS coordinates
 * already work fully without this and are never blocked on it.
 *
 * Kept as a single provider-swap point exactly like before: nothing else in
 * the app calls a maps provider directly for reverse geocoding (see
 * src/lib/actions/location.ts, the only caller).
 */
export async function reverseGeocode(latitude: number, longitude: number): Promise<ReverseGeocodeOutcome> {
  const token = getMapboxToken();

  if (!token) {
    return {
      status: "unavailable",
      reason: "No reverse-geocoding provider is configured (NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN is unset).",
    };
  }

  const url = new URL("https://api.mapbox.com/search/geocode/v6/reverse");
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("access_token", token);

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  } catch {
    return { status: "unavailable", reason: "Reverse-geocoding request failed (network error)." };
  }

  if (response.status === 429) {
    return { status: "unavailable", reason: "Reverse-geocoding rate limit reached." };
  }
  if (!response.ok) {
    return { status: "unavailable", reason: "Reverse-geocoding provider returned an error." };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "unavailable", reason: "Reverse-geocoding provider returned an invalid response." };
  }

  const feature = extractFirstFeature(body);
  if (!feature) {
    return { status: "unavailable", reason: "No address found for these coordinates." };
  }

  const formattedAddress: string | undefined =
    typeof feature.full_address === "string"
      ? feature.full_address
      : typeof feature.name === "string"
        ? feature.name
        : undefined;
  if (!formattedAddress) {
    return { status: "unavailable", reason: "Reverse-geocoding provider returned an incomplete result." };
  }

  return {
    status: "ok",
    result: {
      formattedAddress,
      landmark: typeof feature.name === "string" ? feature.name : undefined,
    },
  };
}

interface MapboxFeatureProperties {
  full_address?: unknown;
  name?: unknown;
}

/** Narrows the Mapbox Geocoding v6 FeatureCollection shape defensively —
 * this is an external API response, never trusted to match a type. */
function extractFirstFeature(body: unknown): MapboxFeatureProperties | null {
  if (!body || typeof body !== "object" || !("features" in body)) return null;
  const features = (body as { features?: unknown }).features;
  if (!Array.isArray(features) || features.length === 0) return null;
  const first = features[0];
  if (!first || typeof first !== "object" || !("properties" in first)) return null;
  const properties = (first as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object") return null;
  return properties as MapboxFeatureProperties;
}
