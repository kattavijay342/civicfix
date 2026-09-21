export type Priority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type IssueStatus =
  | "REPORTED"
  | "AI_ANALYZED"
  | "ROUTED"
  | "ACKNOWLEDGED"
  | "IN_PROGRESS"
  | "RESOLVED"
  /** Phase 6D — set only via submitResolutionFeedback when the original
   * reporter says a resolved issue isn't actually fixed. Ranked below
   * ACKNOWLEDGED/IN_PROGRESS in STATUS_ORDER (status-transitions.ts) so the
   * department must acknowledge again before resolving again. */
  | "REOPENED";

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
  /** GPS accuracy radius in meters, when the source actually reported one
   * (Phase 6B) — never fabricated for a non-GPS source. */
  accuracy?: number | null;
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
  /** Phase 6E — null for real data: no authoritative government-configured
   * SLA/due date exists anywhere in this product, so "on-time" compliance
   * is never computed against a real deadline (see src/lib/data/government.ts).
   * Only ever a real number for clearly-labeled sample/demo data. */
  onTimeRate: number | null;
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
  /** Phase 6C — opt-out map for discretionary notification categories.
   * Null/absent-key both mean "on"; see src/lib/notifications/preferences.ts. */
  notification_preferences: Record<string, boolean> | null;
  created_at: string;
  updated_at: string;
}

export interface DuplicateGroup {
  primary: Pick<CivicIssue, "id" | "title" | "location" | "category" | "status">;
  similarCount: number;
  /** Phase 6A — "duplicate" (high-confidence same complaint) vs "related"
   * (same area/category, lower text overlap). Deterministic, not AI. */
  relationType?: "duplicate" | "related";
  reason?: string | null;
}

/** Phase 4 Step 7 — real server-side pagination for report lists. */
export interface IssueListFilters {
  status?: IssueStatus;
  priority?: Priority;
  category?: ProblemCategory;
  /** Matched against title/description (case-insensitive, substring). */
  search?: string;
  /** Phase 6E — department id (report_assignments.department_id). Only
   * meaningful on the government issue explorer, which can see reports
   * across departments; citizen/department list pages don't need it. */
  department?: string;
  /** Phase 6E — inclusive created_at date range, "YYYY-MM-DD". */
  dateFrom?: string;
  dateTo?: string;
}

export interface PagedIssues {
  items: CivicIssue[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}
