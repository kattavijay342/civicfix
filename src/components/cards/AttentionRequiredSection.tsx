import Link from "next/link";
import { AlertOctagon, AlertTriangle, Clock, RotateCcw, Bell, ArrowRight } from "lucide-react";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import type { CivicIssue } from "@/lib/types";
import type { ActionCenterCounts } from "@/lib/data/government";
import { agingLabel } from "@/lib/aging";
import { categoryLabels } from "@/lib/categories";

function AttentionRow({ issue }: { issue: CivicIssue }) {
  return (
    <li>
      <Link
        href={`/reports/${issue.id}`}
        className="flex items-center justify-between gap-3 rounded-xl border border-border bg-white px-4 py-3 text-sm transition hover:border-civic-300"
      >
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{issue.title}</p>
          <p className="mt-0.5 text-xs text-foreground-muted">
            {agingLabel(issue.daysPending)} · {issue.department} · {categoryLabels[issue.category]}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PriorityBadge priority={issue.priority} />
          <ArrowRight className="h-3.5 w-3.5 text-foreground-muted" aria-hidden="true" />
        </div>
      </Link>
    </li>
  );
}

function AttentionGroup({ title, icon: Icon, issues }: { title: string; icon: typeof AlertOctagon; issues: CivicIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div>
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-foreground-muted">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {title}
      </h3>
      <ul className="mt-2 flex flex-col gap-2">
        {issues.map((issue) => (
          <AttentionRow key={issue.id} issue={issue} />
        ))}
      </ul>
    </div>
  );
}

/**
 * "Needs Attention" (Phase 6E §5) + the Government Action Center's
 * "Today's Attention" counts (§13) — real, bounded, RLS-scoped data only
 * (src/lib/data/government.ts's getNeedsAttention/getActionCenterCounts).
 * Every count/row links to a real, filtered issue — nothing here
 * auto-executes a government action.
 */
export function AttentionRequiredSection({
  needsAttention,
  actionCounts,
  basePath,
}: {
  needsAttention: {
    criticalUnresolved: CivicIssue[];
    highPriorityUnresolved: CivicIssue[];
    longPending: CivicIssue[];
    reopened: CivicIssue[];
  };
  actionCounts: ActionCenterCounts;
  basePath: string;
}) {
  const nothingToShow =
    needsAttention.criticalUnresolved.length === 0 &&
    needsAttention.highPriorityUnresolved.length === 0 &&
    needsAttention.longPending.length === 0 &&
    needsAttention.reopened.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-border bg-white p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">Today&apos;s Attention</h3>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Link href={`${basePath}?priority=CRITICAL`} className="rounded-xl bg-priority-critical-bg px-3 py-2.5 hover:opacity-80">
            <p className="text-lg font-semibold text-priority-critical">{actionCounts.critical}</p>
            <p className="text-[11px] font-medium text-priority-critical">Critical issues</p>
          </Link>
          <Link href="#follow-up-center" className="rounded-xl bg-surface-muted px-3 py-2.5 hover:opacity-80">
            <p className="text-lg font-semibold text-foreground">{actionCounts.followUpDueToday}</p>
            <p className="text-[11px] font-medium text-foreground-muted">Follow-ups due today</p>
          </Link>
          <Link href={`${basePath}?status=REOPENED`} className="rounded-xl bg-status-reopened-bg px-3 py-2.5 hover:opacity-80">
            <p className="text-lg font-semibold text-status-reopened">{actionCounts.reopened}</p>
            <p className="text-[11px] font-medium text-status-reopened">Reopened issues</p>
          </Link>
          <Link href={`${basePath}?status=ROUTED`} className="rounded-xl bg-surface-muted px-3 py-2.5 hover:opacity-80">
            <p className="text-lg font-semibold text-foreground">{actionCounts.awaitingAcknowledgement}</p>
            <p className="text-[11px] font-medium text-foreground-muted">Awaiting acknowledgement</p>
          </Link>
        </div>
      </div>

      {nothingToShow ? (
        <p className="text-sm text-foreground-muted">Nothing needs urgent attention right now.</p>
      ) : (
        <div className="flex flex-col gap-5">
          <AttentionGroup title="Critical, unresolved" icon={AlertOctagon} issues={needsAttention.criticalUnresolved} />
          <AttentionGroup title="High priority, unresolved" icon={AlertTriangle} issues={needsAttention.highPriorityUnresolved} />
          <AttentionGroup title="Long-pending" icon={Clock} issues={needsAttention.longPending} />
          <AttentionGroup
            title="Citizen reports unresolved — reopened"
            icon={RotateCcw}
            issues={needsAttention.reopened}
          />
        </div>
      )}
      {actionCounts.followUpDueToday > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-foreground-muted">
          <Bell className="h-3.5 w-3.5" aria-hidden="true" />
          See the Follow-up Center below for what&apos;s due today.
        </p>
      )}
    </div>
  );
}
