export type Priority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type IssueStatus =
  | "REPORTED"
  | "AI_ANALYZED"
  | "ROUTED"
  | "ACKNOWLEDGED"
  | "IN_PROGRESS"
  | "RESOLVED";

export type ProblemCategory =
  | "ROAD"
  | "GARBAGE"
  | "DRAINAGE"
  | "WATER_LEAKAGE"
  | "STREETLIGHT"
  | "SEWAGE"
  | "DUMPING"
  | "INFRASTRUCTURE"
  | "OTHER";

/**
 * Where a location came from. "demo" = seeded sample data, "search" = picked
 * from the Smart Location autocomplete, "manual" = typed/selected through the
 * manual jurisdiction fallback, "gps" = confirmed from device coordinates
 * with no reverse-geocoding attached.
 */
export type LocationSource = "demo" | "search" | "manual" | "gps";

/**
 * Flexible civic location. Different places have genuinely different
 * hierarchies (a village sits under a Mandal, a city sits under a Ward), so
 * every field below `displayName` and `source` is optional — never assume
 * all of them are present. `latitude`/`longitude` are optional precise GPS
 * coordinates, not currently reverse-geocoded into the fields below; kept
 * for a future real geocoding/jurisdiction service to populate.
 */
export interface CivicLocation {
  /** Canonical human-readable label — always present, e.g. "Sattenapalli RTC Bus Stand". */
  displayName: string;
  searchQuery?: string;
  state?: string;
  district?: string;
  constituency?: string;
  mandal?: string;
  municipality?: string;
  village?: string;
  city?: string;
  /** Area / Ward / Municipality, when the source only gives one combined field. */
  area?: string;
  ward?: string;
  landmark?: string;
  address?: string;
  latitude?: number | null;
  longitude?: number | null;
  source: LocationSource;
}

export interface CivicIssue {
  id: string;
  title: string;
  category: ProblemCategory;
  location: CivicLocation;
  priority: Priority;
  status: IssueStatus;
  reportedDate: string;
  department: string;
  inCharge?: string;
  imageUrl?: string;
  daysPending: number;
  followUps?: number;
  lastFollowUp?: string;
  nextFollowUp?: string;
  severity?: number;
  confidence?: number;
  aiExplanation?: string;
  description?: string;
}

export interface DepartmentPerformance {
  name: string;
  resolutionRate: number;
  totalIssues: number;
  resolvedIssues: number;
  pendingIssues: number;
  onTimeRate: number;
  avgResolutionDays: number;
  trend: number;
}

export interface PendingByPriority {
  priority: Priority;
  count: number;
}

export interface AIInsight {
  id: string;
  text: string;
  tone: "up" | "down" | "neutral";
}

export type UserRole = "citizen" | "government" | "department_incharge" | "admin";

/** Row shape of public.profiles (see supabase/migrations/0001_init_schema.sql). */
export interface Profile {
  id: string;
  role: UserRole;
  full_name: string | null;
  mobile_number: string | null;
  gov_state: string | null;
  gov_district: string | null;
  gov_constituency: string | null;
  gov_area: string | null;
  department_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DuplicateGroup {
  primary: Pick<CivicIssue, "id" | "title" | "location" | "category" | "status">;
  similarCount: number;
}
