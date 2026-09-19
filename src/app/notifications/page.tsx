import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Bell } from "lucide-react";
import { getSessionProfile, createClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/ui/EmptyState";
import { NotificationRow } from "./NotificationRow";

export const metadata: Metadata = {
  title: "Notifications — CivicFix",
};

export default async function NotificationsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/sign-in");

  const supabase = await createClient();
  const { data: notifications } = await supabase
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">Notifications</h1>
      <p className="mt-1 text-sm text-foreground-muted">
        Real events for your account — new assignments, follow-ups, and resolutions. Scheduled
        reminders (e.g. &ldquo;follow-up due tomorrow&rdquo;) need a cron/scheduler and are not wired up yet.
      </p>

      {!notifications || notifications.length === 0 ? (
        <div className="mt-8">
          <EmptyState icon={<Bell className="h-5 w-5" aria-hidden="true" />} title="No notifications yet" description="You'll see updates here as things happen on your reports." />
        </div>
      ) : (
        <ul className="mt-8 flex flex-col gap-3">
          {notifications.map((n) => (
            <NotificationRow key={n.id} notification={n} />
          ))}
        </ul>
      )}
    </div>
  );
}
