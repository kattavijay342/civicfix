/** Lowercase DB-style severity/priority strings (matches reports.severity/
 * reports.priority and civic_incidents.severity/priority — see
 * supabase/migrations/0014_incident_intelligence.sql). */
export type DbLevel = "low" | "medium" | "high" | "critical";

const RANK: Record<DbLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const FROM_RANK: DbLevel[] = ["low", "medium", "high", "critical"];

/** Highest severity among a set of linked reports. Never invents a level
 * independently of the reports it's derived from; an empty set (should
 * never happen — an incident always has at least one linked report) is
 * treated as "low" rather than throwing. */
export function maxLevel(values: DbLevel[]): DbLevel {
  if (values.length === 0) return "low";
  return values.reduce((max, v) => (RANK[v] > RANK[max] ? v : max), values[0]);
}

/** Inverse of the 0-3 rank get_incident_list()'s max_member_severity_rank
 * column uses (supabase/migrations/0014_incident_intelligence.sql) — lets
 * the data layer recompute a live priority from that single aggregate
 * column instead of re-querying every member report's own severity. */
export function levelFromRank(rank: number): DbLevel {
  return FROM_RANK[Math.max(0, Math.min(rank, FROM_RANK.length - 1))];
}

export interface IncidentPriorityInput {
  /** severity of each linked report that isn't a low-confidence 'candidate' */
  memberSeverities: DbLevel[];
  /** count of linked non-candidate reports */
  affectedReportCount: number;
  /** true if any linked report currently has status = 'reopened' */
  anyReopened: boolean;
  /** age in days of the oldest linked report */
  oldestReportAgeDays: number;
  /** true if at least one linked report is not yet resolved */
  stillUnresolved: boolean;
}

export interface IncidentPriorityResult {
  severity: DbLevel;
  priority: DbLevel;
}

/**
 * Deterministic, reproducible incident-priority formula (spec §9 — "do not
 * simply copy the highest report priority without analysis... document the
 * actual formula"). Never a fabricated AI score — every input here is a
 * real, already-computed fact about the incident's own linked reports.
 *
 * severity = the highest severity already assigned (by AI or fallback) to
 * any linked report — an incident is never more severe than the worst
 * single report that makes it up.
 *
 * priority starts at that same severity level, then escalates by one level
 * (capped at CRITICAL) for each independent aggravating signal that only
 * exists at the incident level:
 *   - 3+ citizens independently confirming the same real-world problem is
 *     itself operationally significant, distinct from any one report's
 *     severity;
 *   - a citizen has reported the "fix" isn't real (any linked report is
 *     currently reopened);
 *   - the incident has been open and unresolved for more than 15 days,
 *     mirroring the existing aging-bucket threshold (src/lib/aging.ts) so
 *     the two "aging" concepts in this product never use different cutoffs.
 */
export function computeIncidentPriority(input: IncidentPriorityInput): IncidentPriorityResult {
  const severity = maxLevel(input.memberSeverities);
  let rank = RANK[severity];
  if (input.affectedReportCount >= 3) rank += 1;
  if (input.anyReopened) rank += 1;
  if (input.stillUnresolved && input.oldestReportAgeDays > 15) rank += 1;
  rank = Math.min(rank, RANK.critical);
  return { severity, priority: FROM_RANK[rank] };
}

/**
 * Overall confidence that a group of linked reports is genuinely one
 * real-world incident: the strongest single link confidence among its
 * non-candidate members (see src/lib/incident-detection.ts for how each
 * link's own confidence is computed). Using the max — not the average —
 * means one report that clearly, strongly matches the incident is enough to
 * justify the grouping even while other members individually matched more
 * weakly; the "should this even be an incident" bar was already cleared by
 * whichever match founded/joined it.
 */
export function computeIncidentConfidence(memberConfidences: number[]): number {
  if (memberConfidences.length === 0) return 0;
  return Math.max(...memberConfidences);
}
