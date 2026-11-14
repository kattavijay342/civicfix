"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Home,
  ArrowLeft,
  FilePlus2,
  ListChecks,
  LayoutDashboard,
  Settings,
  Bell,
  ClipboardList,
  Building2,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { roleHomePath } from "@/lib/role-routes";
import type { UserRole } from "@/lib/types";

interface SidebarItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

const notificationsItem: SidebarItem = { label: "Notifications", href: "/notifications", icon: Bell };
const settingsItem: SidebarItem = { label: "Settings", href: "/dashboard/settings", icon: Settings };

const itemsByRole: Record<UserRole, SidebarItem[]> = {
  citizen: [
    { label: "Home", href: "/", icon: Home },
    { label: "Report a Problem", href: "/report", icon: FilePlus2 },
    { label: "My Reports", href: "/dashboard/reports", icon: ListChecks },
    { label: "Dashboard", href: roleHomePath("citizen"), icon: LayoutDashboard },
    notificationsItem,
    settingsItem,
  ],
  government: [
    { label: "Overview", href: "/", icon: Home },
    { label: "Dashboard", href: roleHomePath("government"), icon: LayoutDashboard },
    { label: "Issues / Reports", href: "/government/issues", icon: ClipboardList },
    { label: "Departments", href: "/government#department-performance", icon: Building2 },
    notificationsItem,
    settingsItem,
  ],
  department_incharge: [
    { label: "Overview", href: "/", icon: Home },
    { label: "Dashboard", href: roleHomePath("department_incharge"), icon: LayoutDashboard },
    { label: "Assigned Issues", href: "/department#assigned-issues", icon: ClipboardList },
    notificationsItem,
    settingsItem,
  ],
  admin: [
    { label: "Admin Dashboard", href: roleHomePath("admin"), icon: LayoutDashboard },
    { label: "Users", href: "/admin#users", icon: Users },
    { label: "Departments", href: "/admin#departments", icon: Building2 },
    notificationsItem,
    settingsItem,
  ],
};

/** Sidebar items for a role. The role must be the server-resolved profile
 * role (getSessionProfile) — visibility only; every route enforces access
 * server-side via requireRole. Unknown/missing roles get the citizen list. */
export function sidebarItemsForRole(role: UserRole | null | undefined): SidebarItem[] {
  return (role && itemsByRole[role]) || itemsByRole.citizen;
}

/** Roles whose sidebar gets a Back control, mapped to its no-history fallback. */
const backRoles: readonly UserRole[] = ["government", "department_incharge"];

export function backFallbackForRole(role: UserRole | null | undefined): string | null {
  return role && backRoles.includes(role) ? roleHomePath(role) : null;
}

export function DashboardSidebar({ role, unreadCount = 0 }: { role?: UserRole | null; unreadCount?: number }) {
  const pathname = usePathname();
  const router = useRouter();
  const items = sidebarItemsForRole(role);
  const backFallback = backFallbackForRole(role);
  // Real href so it still works without JS; with JS, prefer browser history.
  const goBack = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (window.history.length > 1) router.back();
    else router.push(backFallback!);
  };

  return (
    <>
      <nav aria-label="Dashboard" className="hidden shrink-0 lg:block lg:w-56">
        <div className="sticky top-24 flex flex-col gap-1 rounded-2xl border border-border bg-white p-3">
          {backFallback && (
            <a
              href={backFallback}
              onClick={goBack}
              aria-label="Go back"
              className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium text-foreground-muted transition hover:bg-surface-muted hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back
            </a>
          )}
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
          {backFallback && (
            <a
              href={backFallback}
              onClick={goBack}
              aria-label="Go back"
              className="flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border border-border bg-white px-3.5 py-2.5 text-xs font-medium text-foreground-muted transition"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Back
            </a>
          )}
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
