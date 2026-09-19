import type { CivicLocation } from "./types";

/**
 * SMALL demo location dataset for the Smart Location search.
 *
 * IMPORTANT: this is a hand-picked prototype dataset covering a handful of
 * places in Andhra Pradesh and Telangana — it is NOT a real geocoding
 * service and does NOT represent a nationwide (or even complete district-
 * level) geographic database. Every result is clearly sourced as "demo" in
 * the resulting CivicLocation. Swap `searchDemoPlaces` for a real
 * geocoding/jurisdiction API later without changing the calling UI.
 *
 * Deliberately mixes different real-world hierarchies (a village sits under
 * a Mandal, a town sits under a Constituency) so the UI never assumes one
 * fixed shape.
 */
export interface DemoPlace {
  id: string;
  displayName: string;
  state: string;
  district: string;
  constituency?: string;
  mandal?: string;
  village?: string;
  area?: string;
  landmark?: string;
}

export const demoPlaces: DemoPlace[] = [
  { id: "sattenapalli", displayName: "Sattenapalli", state: "Andhra Pradesh", district: "Palnadu", constituency: "Sattenapalli" },
  {
    id: "sattenapalli-rtc",
    displayName: "Sattenapalli RTC Bus Stand",
    state: "Andhra Pradesh",
    district: "Palnadu",
    constituency: "Sattenapalli",
    area: "Ward 12",
    landmark: "RTC Bus Stand",
  },
  {
    id: "sattenapalli-main-road",
    displayName: "Sattenapalli Main Road",
    state: "Andhra Pradesh",
    district: "Palnadu",
    constituency: "Sattenapalli",
    area: "Ward 12",
    landmark: "Main Road",
  },
  {
    id: "sattenapalli-hospital",
    displayName: "Main Road near Government Hospital",
    state: "Andhra Pradesh",
    district: "Palnadu",
    constituency: "Sattenapalli",
    area: "Ward 4",
    landmark: "Near Government Hospital",
  },
  { id: "narasaraopet", displayName: "Narasaraopet", state: "Andhra Pradesh", district: "Palnadu", constituency: "Narasaraopet" },
  {
    id: "narasaraopet-ward12",
    displayName: "Ward 12, Narasaraopet",
    state: "Andhra Pradesh",
    district: "Palnadu",
    constituency: "Narasaraopet",
    area: "Ward 12",
  },
  {
    id: "narasaraopet-ward5",
    displayName: "Ward 5, Narasaraopet",
    state: "Andhra Pradesh",
    district: "Palnadu",
    constituency: "Narasaraopet",
    area: "Ward 5",
  },
  {
    id: "narasaraopet-municipality",
    displayName: "Narasaraopet Municipality",
    state: "Andhra Pradesh",
    district: "Palnadu",
    constituency: "Narasaraopet",
    area: "Narasaraopet Municipality",
  },
  {
    id: "krosuru",
    displayName: "Krosuru village",
    state: "Andhra Pradesh",
    district: "Palnadu",
    mandal: "Krosuru",
    village: "Krosuru",
  },
  {
    id: "gurazala",
    displayName: "Gurazala",
    state: "Andhra Pradesh",
    district: "Palnadu",
    constituency: "Gurazala",
    mandal: "Gurazala",
  },
  {
    id: "gurazala-ward3",
    displayName: "Ward 3, Gurazala",
    state: "Andhra Pradesh",
    district: "Palnadu",
    constituency: "Gurazala",
    area: "Ward 3",
  },
  {
    id: "arundelpet",
    displayName: "Arundelpet, Guntur",
    state: "Andhra Pradesh",
    district: "Guntur",
    constituency: "Guntur West",
    area: "Arundelpet",
  },
  {
    id: "tenali",
    displayName: "Tenali",
    state: "Andhra Pradesh",
    district: "Guntur",
    constituency: "Tenali",
    area: "Tenali Municipality",
  },
  {
    id: "secunderabad",
    displayName: "Secunderabad",
    state: "Telangana",
    district: "Hyderabad",
    constituency: "Secunderabad",
  },
  {
    id: "khairatabad",
    displayName: "Khairatabad",
    state: "Telangana",
    district: "Hyderabad",
    constituency: "Khairatabad",
    area: "Ward 6",
  },
];

function haystack(place: DemoPlace): string {
  return [
    place.displayName,
    place.village,
    place.mandal,
    place.area,
    place.constituency,
    place.district,
    place.state,
    place.landmark,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function searchDemoPlaces(query: string, limit = 6): DemoPlace[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return demoPlaces.filter((p) => haystack(p).includes(q)).slice(0, limit);
}

export function placeToLocation(place: DemoPlace, searchQuery?: string): CivicLocation {
  return {
    displayName: place.displayName,
    searchQuery,
    state: place.state,
    district: place.district,
    constituency: place.constituency,
    mandal: place.mandal,
    village: place.village,
    area: place.area,
    landmark: place.landmark,
    latitude: null,
    longitude: null,
    source: "demo",
  };
}
