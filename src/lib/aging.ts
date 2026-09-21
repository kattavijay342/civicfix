export function agingLabel(days: number) {
  if (days === 0) return "Resolved";
  if (days >= 15) return `${days}+ days pending`;
  return `${days} day${days === 1 ? "" : "s"} pending`;
}

export function agingClass(days: number) {
  if (days === 0) return "font-medium text-foreground-muted";
  if (days >= 15) return "font-bold text-priority-critical";
  if (days >= 7) return "font-semibold text-priority-high";
  return "font-medium text-foreground-muted";
}

/** Phase 6E — the same 6 buckets get_aging_buckets() (supabase/migrations/
 * 0013_phase6e_government_intelligence.sql) counts in SQL, mirrored here as
 * a pure, unit-testable function so the boundaries can never silently drift
 * between the two. Order matches the SQL function's column order. */
export const AGING_BUCKET_KEYS = ["0_1", "2_3", "4_7", "8_14", "15_30", "30_plus"] as const;
export type AgingBucketKey = (typeof AGING_BUCKET_KEYS)[number];

export const AGING_BUCKET_LABELS: Record<AgingBucketKey, string> = {
  "0_1": "0–1 days",
  "2_3": "2–3 days",
  "4_7": "4–7 days",
  "8_14": "8–14 days",
  "15_30": "15–30 days",
  "30_plus": "30+ days",
};

export function agingBucketForDays(days: number): AgingBucketKey {
  if (days < 2) return "0_1";
  if (days < 4) return "2_3";
  if (days < 8) return "4_7";
  if (days < 15) return "8_14";
  if (days < 31) return "15_30";
  return "30_plus";
}
