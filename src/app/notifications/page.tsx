import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Bell } from "lucide-react";
import { getSessionProfile, createClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/ui/EmptyState";
import { NotificationRow } from "./NotificationRow";
import { MarkAllReadButton } from "./MarkAllReadButton";

export const metadata: Metadata = {
  title: "Notifications — CivicFix",
};

interface NotificationRowData {
  id: string;
  title: string;
  body: string | null;
  is_read: boolean;
  related_report_id: string | null;
  action_url: string | null;
  priority: "low" | "normal" | "high" | "critical";
  created_at: string;
}

/** Groups into Today / Yesterday / Earlier using IST calendar days, matching
 * the existing convention of displaying all timestamps in Asia/Kolkata
 * (see NotificationRow, FollowUpForm, etc). Computed server-side so no
 * client-side date math (and no hydration mismatch risk) is needed. */
function groupByDay(notifications: NotificationRowData[]): { label: string; items: NotificationRowData[] }[] {
  const istDateKey = (iso: string) =>
    new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD, sortable/comparable
  const todayKey = istDateKey(new Date().toISOString());
  const yesterdayKey = istDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  const groups = new Map<string, NotificationRowData[]>();
  for (const n of notifications) {
    const key = istDateKey(n.created_at);
    const label = key === todayKey ? "Today" : key === yesterdayKey ? "Yesterday" : "Earlier";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(n);
  }

  return ["Today", "Yesterday", "Earlier"]
    .filter((label) => groups.has(label))
    .map((label) => ({ label, items: groups.get(label)! }));
}

export default async function NotificationsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/sign-in");

  const supabase = await createClient();
  // `select("*")` deliberately, not an explicit column list: `priority` and
  // `action_url` (migration 0011) may not exist yet in every environment,
  // and an explicit list naming a missing column fails the WHOLE query —
  // which would make every existing notification silently vanish (not just
  // the new fields) until that migration is applied. `select("*")` degrades
  // gracefully instead: those two fields just come back undefined, handled
  // below the same way a null value already is.
  const { data: notifications } = await supabase
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  const rows: NotificationRowData[] = (notifications ?? []).map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body ?? null,
    is_read: n.is_read,
    related_report_id: n.related_report_id ?? null,
    action_url: n.action_url ?? null,
    priority: n.priority ?? "normal",
    created_at: n.created_at,
  }));
  const hasUnread = rows.some((n) => !n.is_read);
  const groups = groupByDay(rows);

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">Notifications</h1>
          <p className="mt-1 text-sm text-foreground-muted">
            Real events for your account — new reports, AI analysis, routing, follow-ups, resolutions, and
            scheduled reminders. Only in-app notifications are available today; email, SMS, and push aren&apos;t
            configured yet.
          </p>
        </div>
        {hasUnread && <MarkAllReadButton />}
      </div>

      {rows.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={<Bell className="h-5 w-5" aria-hidden="true" />}
            title="You're all caught up"
            description="You'll see updates here as things happen on your reports."
          />
        </div>
      ) : (
        <div className="mt-8 flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.label}>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-foreground-muted">
                {group.label}
              </h2>
              <ul className="flex flex-col gap-3">
                {group.items.map((n) => (
                  <NotificationRow key={n.id} notification={n} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
