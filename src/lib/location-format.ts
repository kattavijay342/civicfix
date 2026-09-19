import type { CivicLocation } from "./types";

/** The most specific "area-level" label available: village, area/ward, municipality, or city. */
function localityLabel(loc: CivicLocation): string | undefined {
  return loc.village || loc.area || loc.ward || loc.municipality || loc.city;
}

/** The most specific "sub-jurisdiction" above the locality: mandal or constituency. */
function subJurisdictionLabel(loc: CivicLocation): string | undefined {
  return loc.constituency || loc.mandal;
}

/** "Narasaraopet, Palnadu, Andhra Pradesh" — falls back gracefully when levels are missing. */
export function locationHeadline(loc: CivicLocation): string {
  const parts = [subJurisdictionLabel(loc), loc.district, loc.state].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : loc.displayName;
}

/** "Ward 12 · Sattenapalli Road near RTC Bus Stand" */
export function locationDetailLine(loc: CivicLocation): string {
  return [localityLabel(loc), loc.landmark].filter(Boolean).join(" · ");
}

/** "Narasaraopet · Palnadu" — compact, for tight card layouts. */
export function locationCompact(loc: CivicLocation): string {
  const parts = [subJurisdictionLabel(loc), loc.district].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : loc.displayName;
}

/** Ordered label/value pairs for a full structured breakdown — only includes fields that exist. */
export function locationBreakdown(loc: CivicLocation): { label: string; value: string }[] {
  return [
    { label: "State", value: loc.state },
    { label: "District", value: loc.district },
    { label: "Constituency", value: loc.constituency },
    { label: "Mandal", value: loc.mandal },
    { label: "Village", value: loc.village },
    { label: "City", value: loc.city },
    { label: "Municipality", value: loc.municipality },
    { label: "Area / Ward", value: loc.area || loc.ward },
    { label: "Specific Location", value: loc.landmark },
  ].filter((row): row is { label: string; value: string } => !!row.value);
}

/** Multi-line document-style text, e.g. for the generated complaint. */
export function locationDocumentLines(loc: CivicLocation): string[] {
  return [
    loc.state,
    loc.district ? `${loc.district} District` : "",
    loc.constituency ? `${loc.constituency} Constituency` : loc.mandal ? `${loc.mandal} Mandal` : "",
    loc.area || loc.ward,
    loc.village,
    loc.landmark,
  ].filter((v): v is string => !!v);
}

/** Compact 3-line summary for the complaint document's primary view. */
export function locationComplaintSummary(loc: CivicLocation): string[] {
  const line1 = loc.displayName;
  const line2 = [localityLabel(loc), subJurisdictionLabel(loc)].filter(Boolean).join(", ");
  const line3 = [loc.district, loc.state].filter(Boolean).join(", ");
  return [line1, line2, line3].filter(Boolean);
}

/** Single-line fallback, e.g. for alt text. */
export function locationOneLine(loc: CivicLocation): string {
  const parts = [loc.landmark, localityLabel(loc), subJurisdictionLabel(loc), loc.district, loc.state].filter(
    Boolean,
  );
  return parts.length > 0 ? parts.join(", ") : loc.displayName;
}

/**
 * Ordered chain from most specific to least specific, for the "Location ->
 * Constituency -> District -> State" jurisdiction-flow visual. Skips any
 * level that isn't available for this particular location.
 */
export function locationJurisdictionChain(loc: CivicLocation): string[] {
  return [loc.displayName, subJurisdictionLabel(loc), loc.district, loc.state].filter(
    (v, i): v is string => !!v && (i === 0 || v !== loc.displayName),
  );
}
