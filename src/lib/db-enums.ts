import type { ProblemCategory, Priority, IssueStatus } from "./types";

/**
 * The UI types in src/lib/types.ts use SCREAMING_CASE (matches Phase 1
 * components). The database uses lower snake_case (matches Postgres/SQL
 * convention and the CHECK constraints in supabase/migrations). These maps
 * are the single place that translation happens.
 */

function invert<K extends string, V extends string>(obj: Record<K, V>): Record<V, K> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [v, k])) as Record<V, K>;
}

export const categoryToDb: Record<ProblemCategory, string> = {
  ROAD: "road",
  GARBAGE: "garbage",
  DRAINAGE: "drainage",
  WATER_LEAKAGE: "water_leakage",
  STREETLIGHT: "streetlight",
  SEWAGE: "sewage",
  DUMPING: "dumping",
  INFRASTRUCTURE: "infrastructure",
  OTHER: "other",
};
export const categoryFromDb = invert(categoryToDb) as Record<string, ProblemCategory>;
export const dbCategoryValues = Object.values(categoryToDb) as [string, ...string[]];

export const priorityToDb: Record<Priority, string> = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
};
export const priorityFromDb = invert(priorityToDb) as Record<string, Priority>;
export const dbPriorityValues = Object.values(priorityToDb) as [string, ...string[]];

// Severity uses the same four levels as priority.
export const severityToDb = priorityToDb;
export const severityFromDb = priorityFromDb;
export const dbSeverityValues = dbPriorityValues;

export const statusToDb: Record<IssueStatus, string> = {
  REPORTED: "reported",
  AI_ANALYZED: "ai_analyzed",
  ROUTED: "routed",
  ACKNOWLEDGED: "acknowledged",
  IN_PROGRESS: "in_progress",
  RESOLVED: "resolved",
  REOPENED: "reopened",
};
export const statusFromDb = invert(statusToDb) as Record<string, IssueStatus>;
export const dbStatusValues = Object.values(statusToDb) as [string, ...string[]];
