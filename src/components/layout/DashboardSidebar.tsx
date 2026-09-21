"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, FilePlus2, ListChecks, LayoutDashboard, Settings, Bell } from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { label: "Home", href: "/", icon: Home },
  { label: "Report a Problem", href: "/report", icon: FilePlus2 },
  { label: "My Reports", href: "/dashboard/reports", icon: ListChecks },
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Notifications", href: "/notifications", icon: Bell },
  { label: "Settings", href: "/dashboard/settings", icon: Settings },
];

export function DashboardSidebar({ unreadCount = 0 }: { unreadCount?: number }) {
  const pathname = usePathname();

  return (
    <>
      <nav aria-label="Dashboard" className="hidden shrink-0 lg:block lg:w-56">
        <div className="sticky top-24 flex flex-col gap-1 rounded-2xl border border-border bg-white p-3">
          {items.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href;
            const badge = item.href === "/notifications" && unreadCount > 0 ? unreadCount : null;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition",
                  active
                    ? "bg-civic-50 text-civic-700"
                    : "text-foreground-muted hover:bg-surface-muted hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {item.label}
                {badge !== null && (
                  <span className="ml-auto flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-priority-critical px-1 text-[10px] font-semibold text-white">
                    {badge > 9 ? "9+" : badge}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </nav>

      <nav aria-label="Dashboard" className="-mx-4 overflow-x-auto px-4 pb-1 lg:hidden">
        <div className="flex gap-2">
          {items.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href;
            const badge = item.href === "/notifications" && unreadCount > 0 ? unreadCount : null;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-2.5 text-xs font-medium transition",
                  active
                    ? "border-civic-300 bg-civic-50 text-civic-700"
                    : "border-border bg-white text-foreground-muted",
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {item.label}
                {badge !== null && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-priority-critical px-1 text-[10px] font-semibold text-white">
                    {badge > 9 ? "9+" : badge}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
