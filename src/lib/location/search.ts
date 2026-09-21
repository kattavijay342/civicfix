import "server-only";
import { getMapboxToken, DEFAULT_MAP_CENTER, SEARCH_COUNTRY } from "./mapbox-config";
import type { LocationSearchOutcome, LocationSearchSuggestion } from "./types";

const MIN_QUERY_LENGTH = 3;
const MAX_RESULTS = 6;

/**
 * The only place that calls Mapbox forward geocoding/search — never
 * scattered across components. Exposed over HTTP by
 * src/app/api/location/search/route.ts (a Route Handler, not a Server
 * Action) specifically so the browser's own `fetch` + `AbortController` can
 * genuinely cancel an outdated in-flight request when the user keeps
 * typing, rather than merely discarding a stale response after the fact.
 */
export async function performLocationSearch(query: string, signal?: AbortSignal): Promise<LocationSearchOutcome> {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) {
    return { status: "ok", results: [] };
  }

  const token = getMapboxToken();
  if (!token) {
    return { status: "unavailable", reason: "Location search is unavailable (Mapbox is not configured)." };
  }

  const url = new URL("https://api.mapbox.com/search/geocode/v6/forward");
  url.searchParams.set("q", trimmed);
  url.searchParams.set("country", SEARCH_COUNTRY);
  url.searchParams.set("limit", String(MAX_RESULTS));
  url.searchParams.set("proximity", `${DEFAULT_MAP_CENTER[0]},${DEFAULT_MAP_CENTER[1]}`);
  url.searchParams.set("access_token", token);

  let response: Response;
  try {
    response = await fetch(url, { signal: signal ?? AbortSignal.timeout(8_000) });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err; // let the caller's cancellation propagate
    return { status: "unavailable", reason: "Location search failed (network error)." };
  }

  if (response.status === 429) {
    return { status: "unavailable", reason: "Location search rate limit reached — try again shortly." };
  }
  if (!response.ok) {
    return { status: "unavailable", reason: "Location search provider returned an error." };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "unavailable", reason: "Location search provider returned an invalid response." };
  }

  return { status: "ok", results: extractSuggestions(body) };
}

/** Narrows the Mapbox Geocoding v6 FeatureCollection shape defensively —
 * an external API response is never trusted to match a type, and a
 * malformed/missing field simply drops that one suggestion rather than
 * fabricating a placeholder for it. */
function extractSuggestions(body: unknown): LocationSearchSuggestion[] {
  if (!body || typeof body !== "object" || !("features" in body)) return [];
  const features = (body as { features?: unknown }).features;
  if (!Array.isArray(features)) return [];

  const suggestions: LocationSearchSuggestion[] = [];
  for (const feature of features) {
    if (!feature || typeof feature !== "object") continue;
    const { properties, geometry } = feature as { properties?: unknown; geometry?: unknown };
    if (!properties || typeof properties !== "object") continue;
    if (!geometry || typeof geometry !== "object") continue;

    const coordinates = (geometry as { coordinates?: unknown }).coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    const [longitude, latitude] = coordinates;
    if (typeof latitude !== "number" || typeof longitude !== "number") continue;

    const props = properties as Record<string, unknown>;
    const mapboxId = typeof props.mapbox_id === "string" ? props.mapbox_id : undefined;
    const name = typeof props.name === "string" ? props.name : undefined;
    const placeFormatted = typeof props.place_formatted === "string" ? props.place_formatted : undefined;
    const fullAddress = typeof props.full_address === "string" ? props.full_address : undefined;
    const label = name ?? fullAddress;
    if (!label) continue;

    suggestions.push({
      id: mapboxId ?? `${latitude},${longitude}`,
      label,
      context: placeFormatted ?? (fullAddress && fullAddress !== label ? fullAddress : undefined),
      latitude,
      longitude,
      placeType: typeof props.feature_type === "string" ? props.feature_type : undefined,
    });
  }
  return suggestions;
}
