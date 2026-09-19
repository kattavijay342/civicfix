/**
 * Demo civic jurisdiction hierarchy: State -> District -> Constituency ->
 * Area / Ward / Municipality.
 *
 * IMPORTANT: this is a small, hand-picked sample used to build and exercise
 * the location UI/filtering. It does NOT represent complete or official
 * administrative boundaries for any state. Replace with a real
 * jurisdiction/boundary dataset (or API) before this goes anywhere near
 * production.
 */

export interface JurisdictionConstituency {
  name: string;
  areas: string[];
}

export interface JurisdictionDistrict {
  name: string;
  constituencies: JurisdictionConstituency[];
}

export interface JurisdictionState {
  name: string;
  districts: JurisdictionDistrict[];
}

export const jurisdictionData: JurisdictionState[] = [
  {
    name: "Andhra Pradesh",
    districts: [
      {
        name: "Palnadu",
        constituencies: [
          {
            name: "Narasaraopet",
            areas: ["Narasaraopet Municipality", "Ward 12", "Ward 5"],
          },
          {
            name: "Gurazala",
            areas: ["Gurazala Mandal", "Ward 3", "Krosuru"],
          },
        ],
      },
      {
        name: "Guntur",
        constituencies: [
          {
            name: "Guntur West",
            areas: ["Ward 8", "Arundelpet"],
          },
          {
            name: "Tenali",
            areas: ["Tenali Municipality", "Ward 2"],
          },
        ],
      },
    ],
  },
  {
    name: "Telangana",
    districts: [
      {
        name: "Hyderabad",
        constituencies: [
          {
            name: "Secunderabad",
            areas: ["Ward 1", "Ward 4"],
          },
          {
            name: "Khairatabad",
            areas: ["Ward 6"],
          },
        ],
      },
    ],
  },
];

export const stateNames = jurisdictionData.map((s) => s.name);

export function getDistricts(state: string): string[] {
  return jurisdictionData.find((s) => s.name === state)?.districts.map((d) => d.name) ?? [];
}

export function getConstituencies(state: string, district: string): string[] {
  const d = jurisdictionData.find((s) => s.name === state)?.districts.find((d) => d.name === district);
  return d?.constituencies.map((c) => c.name) ?? [];
}

export function getAreas(state: string, district: string, constituency: string): string[] {
  const d = jurisdictionData.find((s) => s.name === state)?.districts.find((d) => d.name === district);
  const c = d?.constituencies.find((c) => c.name === constituency);
  return c?.areas ?? [];
}
