import { AGING_BUCKET_KEYS, AGING_BUCKET_LABELS } from "@/lib/aging";
import type { AgingBuckets } from "@/lib/data/government";

/**
 * Real day buckets for currently-unresolved issues (Phase 6E §6) — from
 * get_aging_buckets() (supabase/migrations/0013_phase6e_government_intelligence.sql).
 * Never labels anything "overdue" — no real due date exists for a report,
 * only "pending for N days" (unlike reminders, which do have a real
 * scheduled_at — see FollowUpCenter).
 */
export function AgingBucketsChart({ buckets }: { buckets: AgingBuckets | null }) {
  if (!buckets) {
    return <p className="text-sm text-foreground-muted">Not enough data to calculate issue aging.</p>;
  }

  const total = AGING_BUCKET_KEYS.reduce((sum, key) => sum + buckets[key], 0);
  if (total === 0) {
    return <p className="text-sm text-foreground-muted">No pending issues right now.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {AGING_BUCKET_KEYS.map((key) => {
        const count = buckets[key];
        const pct = total === 0 ? 0 : Math.round((count / total) * 100);
        return (
          <div key={key} className="flex items-center gap-3 text-sm">
            <span className="w-20 shrink-0 text-xs font-medium text-foreground-muted">{AGING_BUCKET_LABELS[key]}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-muted">
              <div
                className="h-full rounded-full bg-civic-600"
                style={{ width: `${pct}%` }}
                role="img"
                aria-label={`${AGING_BUCKET_LABELS[key]}: ${count} issue${count === 1 ? "" : "s"}`}
              />
            </div>
            <span className="w-6 shrink-0 text-right text-xs font-semibold text-foreground">{count}</span>
          </div>
        );
      })}
      <p className="mt-1 text-xs text-foreground-muted">
        {AGING_BUCKET_KEYS.map((key) => `${AGING_BUCKET_LABELS[key]}: ${buckets[key]}`).join(". ")}.
      </p>
    </div>
  );
}
