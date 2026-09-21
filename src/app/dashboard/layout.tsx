import { DashboardSidebar } from "@/components/layout/DashboardSidebar";
import { getSessionProfile, createClient } from "@/lib/supabase/server";
import { getUnreadNotificationCount } from "@/lib/data/notifications";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionProfile();
  const unreadCount = session
    ? await getUnreadNotificationCount(await createClient(), session.user.id)
    : 0;

  return (
    <div className="bg-surface-muted">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:flex-row lg:gap-10 lg:px-8 lg:py-12">
        <DashboardSidebar unreadCount={unreadCount} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
