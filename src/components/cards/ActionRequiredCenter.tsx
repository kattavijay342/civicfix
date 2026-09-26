import Link from "next/link";
import { AlertOctagon, Bell, CheckCircle2, Clock, Phone, RotateCcw, Route, ArrowRight, Inbox } from "lucide-react";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { categoryLabels } from "@/lib/categories";
import type { ActionQueue, FollowUpState } from "@/lib/action-required";
import type { ActionRequiredData, ActionRequiredItem } from "@/lib/data/action-required";
import { cn } from "@/lib/utils";

/**
 * G5 — Government "Action Required" command center. Server component: all
 * data is already RLS-scoped by getActionRequired(); the queue filter is a
 * plain URL value that only narrows what the server already authorized, it
 * never widens it. Monitoring/follow-up only — there is deliberately no
 * assign/acknowledge/start/resolve control here (those stay with the
 * department in-charge, G4).
 */

const DISPLAY_LIMIT = 25;

const QUEUE_TILES: Array<{
  queue: ActionQueue;
  label: string;
  icon: typeof AlertOctagon;
  countKey: keyof ActionRequiredData["counts"];
  tone: string;
}> = [
  { queue: "critical", label: "Critical", icon: AlertOctagon, countKey: "critical", tone: "text-priority-critical bg-priority-critical-bg" },
  { queue: "pending_over_7_days", label: "Pending > 7 days", icon: Clock, countKey: "pendingOver7Days", tone: "text-priority-high bg-priority-high-bg" },
  { queue: "follow_up_due", label: "Follow-ups due", icon: Bell, countKey: "followUpsDue", tone: "text-status-routed bg-status-routed-bg" },
  { queue: "reopened", label: "Reopened", icon: RotateCcw, countKey: "reopened", tone: "text-status-reopened bg-status-reopened-bg" },
  { queue: "routing_pending", label: "Routing pending", icon: Route, countKey: "routingPending", tone: "text-status-reported bg-status-reported-bg" },
];

const IST_DATE: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" };
const IST_DATETIME: Intl.DateTimeFormatOptions = { ...IST_DATE, hour: "numeric", minute: "2-digit" };
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", IST_DATE);
const fmtDateTime = (iso: string) => new Date(iso).toLocaleString("en-IN", IST_DATETIME);

function followUpText(state: FollowUpState): string | null {
  switch (state.kind) {
    case "reminder_due":
      return state.overdue ? `Reminder overdue since ${fmtDateTime(state.at)}` : `Reminder due ${fmtDateTime(state.at)}`;
    case "follow_up_due":
      return state.overdue ? `Follow-up overdue since ${fmtDate(state.on)}` : "Follow-up due today";
    case "reminder_scheduled":
      return `Reminder scheduled ${fmtDateTime(state.at)}`;
    case "reminder_sent":
      return `Reminder sent ${fmtDate(state.at)}`;
    case "follow_up_recorded":
      return `Last follow-up ${fmtDate(state.at)}`;
    case "none":
      return null;
  }
}

function queueHref(queue: ActionQueue | null) {
  return `${queue ? `/government?queue=${queue}` : "/government"}#action-required`;
}

function Level({ value, label }: { value: ActionRequiredItem["priority"]; label: string }) {
  return value ? (
    <PriorityBadge priority={value} />
  ) : (
    <span className="text-xs text-foreground-muted" title={`${label} not assessed yet`}>
      Not assessed
    </span>
  );
}

function InchargeCell({ item }: { item: ActionRequiredItem }) {
  if (item.incharge) {
    return (
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{item.incharge.name}</p>
        {item.incharge.phone && (
          <a
            href={`tel:${item.incharge.phone.replace(/[^\d+]/g, "")}`}
            className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-civic-700 hover:underline"
          >
            <Phone className="h-3 w-3" aria-hidden="true" />
            {item.incharge.phone}
          </a>
        )}
      </div>
    );
  }
  const text =
    item.inchargeState === "unavailable"
      ? "Department in-charge unavailable"
      : item.inchargeState === "unassigned"
        ? "No in-charge assigned"
        : "Not routed yet";
  return <p className="text-xs font-medium text-priority-high">{text}</p>;
}

function Reasons({ item }: { item: ActionRequiredItem }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Why this needs attention">
      {item.reasonLabels.map((label, i) => (
        <li
          key={item.reasons[i]}
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-semibold",
            item.reasons[i] === "critical" || item.reasons[i] === "reopened"
              ? "bg-priority-critical-bg text-priority-critical"
              : "bg-surface-muted text-foreground"
          )}
        >
          {label}
        </li>
      ))}
    </ul>
  );
}

function Actions({ item }: { item: ActionRequiredItem }) {
  // The reminder form (existing, server-authorized createReminder) needs an
  // effective in-charge; otherwise the follow-up log is the next step.
  const followUpAnchor = item.incharge ? "reminders" : "follow-ups";
  return (
    <div className="flex items-center gap-2">
      <Link
        href={`/reports/${item.reportId}`}
        className="inline-flex items-center gap-1 rounded-lg border border-border bg-white px-2.5 py-1.5 text-xs font-semibold text-foreground hover:border-civic-300"
      >
        Open
        <ArrowRight className="h-3 w-3" aria-hidden="true" />
      </Link>
      <Link
        href={`/reports/${item.reportId}#${followUpAnchor}`}
        className="inline-flex items-center gap-1 rounded-lg bg-civic-700 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-civic-800"
      >
        {item.incharge ? "Send reminder" : "Follow up"}
      </Link>
    </div>
  );
}

export function ActionRequiredCenter({ data, activeQueue }: { data: ActionRequiredData; activeQueue: ActionQueue | null }) {
  const filtered = activeQueue ? data.items.filter((i) => i.queues.includes(activeQueue)) : data.items;
  const shown = filtered.slice(0, DISPLAY_LIMIT);
  const activeLabel = activeQueue ? QUEUE_TILES.find((t) => t.queue === activeQueue)?.label : null;

  return (
    <div className="flex flex-col gap-5" data-testid="action-required">
      {/* Queue strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Link
          href={queueHref(null)}
          aria-current={activeQueue === null ? "true" : undefined}
          className={cn(
            "col-span-2 rounded-2xl border bg-white p-4 transition hover:border-civic-300 sm:col-span-1",
            activeQueue === null ? "border-civic-500 ring-1 ring-civic-500" : "border-border"
          )}
        >
          <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">Action required</p>
          <p className="mt-1 text-2xl font-semibold text-foreground" data-testid="count-action-required">
            {data.counts.actionRequired}
          </p>
        </Link>
        {QUEUE_TILES.map(({ queue, label, icon: Icon, countKey, tone }) => (
          <Link
            key={queue}
            href={queueHref(queue)}
            aria-current={activeQueue === queue ? "true" : undefined}
            className={cn(
              "rounded-2xl border bg-white p-4 transition hover:border-civic-300",
              activeQueue === queue ? "border-civic-500 ring-1 ring-civic-500" : "border-border"
            )}
          >
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              <span className={cn("inline-flex h-5 w-5 items-center justify-center rounded-md", tone)}>
                <Icon className="h-3 w-3" aria-hidden="true" />
              </span>
              {label}
            </p>
            <p className="mt-1 text-2xl font-semibold text-foreground" data-testid={`count-${queue}`}>
              {data.counts[countKey]}
            </p>
          </Link>
        ))}
      </div>
      <p className="-mt-2 text-xs text-foreground-muted">
        Also: {data.counts.highPriority} high-priority · {data.counts.awaitingAcknowledgement} awaiting department
        acknowledgement. Counts cover the {data.unresolvedScanned} unresolved issue
        {data.unresolvedScanned === 1 ? "" : "s"} in your jurisdiction.
        {data.truncated && " Only the oldest unresolved issues were scanned — narrow with All Issues for the rest."}
      </p>

      {/* Issue list */}
      <div className="rounded-2xl border border-border bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
          <h3 className="text-sm font-semibold text-foreground">
            Action Required Issues{activeLabel ? ` — ${activeLabel}` : ""}
          </h3>
          <p className="text-xs text-foreground-muted">
            {filtered.length === 0
              ? "0 issues"
              : `Showing ${shown.length} of ${filtered.length} · most urgent first`}
            {activeQueue && (
              <>
                {" · "}
                <Link href={queueHref(null)} className="font-medium text-civic-700 hover:underline">
                  Clear filter
                </Link>
              </>
            )}
          </p>
        </div>

        {data.unavailable ? (
          <div className="flex items-center gap-2 px-5 py-8 text-sm text-foreground-muted">
            <Inbox className="h-4 w-4" aria-hidden="true" />
            Action Required data is unavailable right now. Please refresh in a moment.
          </div>
        ) : shown.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-5 py-10 text-center" data-testid="action-required-empty">
            <CheckCircle2 className="h-6 w-6 text-civic-600" aria-hidden="true" />
            <p className="text-sm font-semibold text-foreground">
              {activeQueue ? `Nothing in “${activeLabel}” right now.` : "No action required right now."}
            </p>
            <p className="text-xs text-foreground-muted">New issues that need your attention will appear here.</p>
          </div>
        ) : (
          <>
            {/* Desktop / tablet table */}
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-left text-sm">
                <thead className="bg-surface-muted text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
                  <tr>
                    <th scope="col" className="px-5 py-2.5">Issue</th>
                    <th scope="col" className="px-3 py-2.5">Severity / Priority</th>
                    <th scope="col" className="px-3 py-2.5">Department</th>
                    <th scope="col" className="px-3 py-2.5">In-charge</th>
                    <th scope="col" className="px-3 py-2.5">Age</th>
                    <th scope="col" className="px-3 py-2.5">Why</th>
                    <th scope="col" className="px-5 py-2.5">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {shown.map((item) => {
                    const fu = followUpText(item.followUpState);
                    return (
                      <tr key={item.reportId} data-testid="action-row" className="align-top">
                        <td className="max-w-xs px-5 py-3">
                          <Link href={`/reports/${item.reportId}`} className="font-medium text-foreground hover:text-civic-700">
                            {item.title}
                          </Link>
                          <p className="mt-0.5 text-xs text-foreground-muted">
                            {categoryLabels[item.category]} · {item.location}
                          </p>
                          <div className="mt-1.5">
                            <StatusBadge status={item.status} />
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-col items-start gap-1.5">
                            <span className="flex items-center gap-1 text-[11px] text-foreground-muted">
                              Sev <Level value={item.severity} label="Severity" />
                            </span>
                            <span className="flex items-center gap-1 text-[11px] text-foreground-muted">
                              Pri <Level value={item.priority} label="Priority" />
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-3 text-sm text-foreground">{item.department ?? <span className="text-xs text-foreground-muted">Not routed</span>}</td>
                        <td className="max-w-[12rem] px-3 py-3">
                          <InchargeCell item={item} />
                        </td>
                        <td className="whitespace-nowrap px-3 py-3">
                          <p className="font-semibold text-foreground">{item.ageDays}d</p>
                          <p className="text-[11px] text-foreground-muted">Last activity {fmtDate(item.lastActivityAt)}</p>
                        </td>
                        <td className="max-w-[14rem] px-3 py-3">
                          <Reasons item={item} />
                          {fu && <p className="mt-1.5 text-[11px] text-foreground-muted">{fu}</p>}
                        </td>
                        <td className="px-5 py-3">
                          <Actions item={item} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile / small-tablet cards */}
            <ul className="divide-y divide-border lg:hidden">
              {shown.map((item) => {
                const fu = followUpText(item.followUpState);
                return (
                  <li key={item.reportId} data-testid="action-card" className="flex flex-col gap-3 px-4 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link href={`/reports/${item.reportId}`} className="font-medium text-foreground hover:text-civic-700">
                          {item.title}
                        </Link>
                        <p className="mt-0.5 text-xs text-foreground-muted">
                          {categoryLabels[item.category]} · {item.location}
                        </p>
                      </div>
                      <StatusBadge status={item.status} />
                    </div>
                    <Reasons item={item} />
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                      <div>
                        <dt className="text-foreground-muted">Severity</dt>
                        <dd className="mt-0.5"><Level value={item.severity} label="Severity" /></dd>
                      </div>
                      <div>
                        <dt className="text-foreground-muted">Priority</dt>
                        <dd className="mt-0.5"><Level value={item.priority} label="Priority" /></dd>
                      </div>
                      <div>
                        <dt className="text-foreground-muted">Department</dt>
                        <dd className="mt-0.5 font-medium text-foreground">{item.department ?? "Not routed"}</dd>
                      </div>
                      <div>
                        <dt className="text-foreground-muted">In-charge</dt>
                        <dd className="mt-0.5"><InchargeCell item={item} /></dd>
                      </div>
                      <div>
                        <dt className="text-foreground-muted">Age</dt>
                        <dd className="mt-0.5 font-medium text-foreground">
                          {item.ageDays} day{item.ageDays === 1 ? "" : "s"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-foreground-muted">Last activity</dt>
                        <dd className="mt-0.5 font-medium text-foreground">{fmtDate(item.lastActivityAt)}</dd>
                      </div>
                    </dl>
                    {fu && <p className="text-xs text-foreground-muted">{fu}</p>}
                    <Actions item={item} />
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
