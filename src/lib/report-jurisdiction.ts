import { stateNames, getDistricts, getConstituencies, getAreas } from "@/lib/jurisdiction";

/** Mirrors the report form's own "type your village/area name" fallback
 * (SmartLocationField) — long enough for any real place name, short enough
 * that a hand-crafted request can't stuff arbitrary text into a column
 * that feeds RLS scoping and notification targeting. */
export const MAX_AREA_LENGTH = 80;

export interface ReportJurisdiction {
  state: string;
  district: string;
  constituency: string;
  area: string;
}

export type JurisdictionResolution = { ok: true; jurisdiction: ReportJurisdiction } | { ok: false; error: string };

const INVALID_LOCATION = "Please select a valid state, district and constituency for this location.";

function pick(options: string[], raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const wanted = raw.trim().toLowerCase();
  if (!wanted) return null;
  return options.find((o) => o.toLowerCase() === wanted) ?? null;
}

/**
 * Server-side resolution of a report's jurisdiction (Phase G2). The
 * report form builds state/district/constituency from the configured
 * hierarchy (src/lib/jurisdiction.ts), but the server never trusted those
 * strings before — and they are exactly what `report_in_my_jurisdiction()`
 * (RLS) and findGovernmentUsersForJurisdiction() match against. So every
 * level is re-checked against its parent here and rewritten to the
 * canonical spelling, the same hierarchy G1's validateJurisdiction()
 * enforces for government users' scopes, so the two sides always compare
 * like with like.
 *
 * Area is the one level the form lets a citizen type freely ("it will be
 * saved as entered"), so an unknown area is kept (trimmed/capped) rather
 * than rejected; a known area is canonicalized so "narasaraopet
 * municipality" still reaches the government user scoped to
 * "Narasaraopet Municipality".
 */
export function resolveReportJurisdiction(location: {
  state?: unknown;
  district?: unknown;
  constituency?: unknown;
  area?: unknown;
}): JurisdictionResolution {
  const state = pick(stateNames, location.state);
  if (!state) return { ok: false, error: INVALID_LOCATION };
  const district = pick(getDistricts(state), location.district);
  if (!district) return { ok: false, error: INVALID_LOCATION };
  const constituency = pick(getConstituencies(state, district), location.constituency);
  if (!constituency) return { ok: false, error: INVALID_LOCATION };

  const rawArea = typeof location.area === "string" ? location.area.trim().replace(/\s+/g, " ") : "";
  if (!rawArea) return { ok: false, error: "Please enter the area for this location." };
  if (rawArea.length > MAX_AREA_LENGTH) {
    return { ok: false, error: `Area name is too long (${MAX_AREA_LENGTH} characters max).` };
  }
  const area = pick(getAreas(state, district, constituency), rawArea) ?? rawArea;

  return { ok: true, jurisdiction: { state, district, constituency, area } };
}
