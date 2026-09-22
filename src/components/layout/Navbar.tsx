"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Menu, X, Landmark, LogOut, Bell, User, CirclePlus } from "lucide-react";
import { CTAButton } from "@/components/ui/CTAButton";
import { cn } from "@/lib/utils";
import { signOut } from "@/lib/actions/auth";
import { roleHomePath } from "@/lib/role-routes";
import type { Profile } from "@/lib/types";

const navLinks = [
  { label: "Home", href: "/" },
  { label: "How It Works", href: "/#how-it-works" },
  { label: "Issues", href: "/#explore" },
  { label: "About", href: "/#about" },
  { label: "Citizen", href: "/dashboard" },
];

const roleLabels: Record<string, string> = {
  government: "Authorized Government User",
  department_incharge: "Department In-charge",
  admin: "Admin",
};

export function Navbar({ profile, unreadCount = 0 }: { profile: Profile | null; unreadCount?: number }) {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // "Citizen" is always in navLinks and already points at /dashboard, so a
  // signed-in citizen doesn't need a second, redundant link to the same
  // place — only government/department/admin get an extra role-home link.
  const homeLink =
    profile && profile.role !== "citizen"
      ? { label: roleLabels[profile.role] ?? "Dashboard", href: roleHomePath(profile.role) }
      : null;
  const links = homeLink ? [...navLinks, homeLink] : navLinks;
  const notificationsHref = profile ? "/notifications" : "/sign-in";

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (mobileOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 w-full border-b transition-colors duration-300",
        scrolled
          ? "border-border bg-white/85 backdrop-blur-md"
          : "border-transparent bg-white/60 backdrop-blur-sm",
      )}
    >
      <nav
        aria-label="Primary"
        className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8"
      >
        <Link
          href="/"
          className="flex items-center gap-2 rounded-md text-foreground"
          onClick={() => setMobileOpen(false)}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-civic-600 text-white">
            <Landmark className="h-4.5 w-4.5" aria-hidden="true" />
          </span>
          <span className="leading-tight">
            <span className="block text-[17px] font-semibold tracking-tight">CivicFix</span>
            <span className="hidden text-[11px] font-medium text-foreground-muted sm:block">
              Stronger Communities. Better Cities.
            </span>
          </span>
        </Link>

        <ul className="hidden items-center gap-1 lg:flex">
          {links.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="rounded-full px-3.5 py-2 text-sm font-medium text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>

        <div className="hidden items-center gap-2 lg:flex">
          <Link
            href={notificationsHref}
            aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
            className="relative inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground"
          >
            <Bell className="h-4.5 w-4.5" aria-hidden="true" />
            {unreadCount > 0 && (
              <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-priority-critical px-1 text-[10px] font-semibold text-white">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </Link>

          <span className="h-6 w-px bg-border" aria-hidden="true" />

          {profile ? (
            <form action={signOut}>
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-2 text-sm font-medium text-foreground-muted transition-colors hover:border-civic-300 hover:bg-surface-muted hover:text-foreground"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                Sign Out
              </button>
            </form>
          ) : (
            <Link
              href="/sign-in"
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-2 text-sm font-medium text-foreground-muted transition-colors hover:border-civic-300 hover:bg-surface-muted hover:text-foreground"
            >
              <User className="h-4 w-4" aria-hidden="true" />
              Sign In
            </Link>
          )}
          <CTAButton href="/report" size="md">
            <CirclePlus className="h-4 w-4" aria-hidden="true" />
            Report a Problem
          </CTAButton>
        </div>

        <button
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground lg:hidden"
          aria-expanded={mobileOpen}
          aria-controls="mobile-menu"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          onClick={() => setMobileOpen((v) => !v)}
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </nav>

      {mobileOpen && (
        <div
          id="mobile-menu"
          className="border-t border-border bg-white px-4 pb-6 pt-2 lg:hidden animate-fade-in"
        >
          <ul className="flex flex-col gap-1">
            {links.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className="block rounded-lg px-3 py-2.5 text-[15px] font-medium text-foreground-muted hover:bg-surface-muted hover:text-foreground"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
            <Link
              href={notificationsHref}
              onClick={() => setMobileOpen(false)}
              className="flex w-full items-center justify-center gap-1.5 rounded-full px-3.5 py-2.5 text-sm font-medium text-foreground-muted hover:bg-surface-muted"
            >
              <Bell className="h-4 w-4" aria-hidden="true" />
              Notifications
              {unreadCount > 0 && (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-priority-critical px-1 text-[10px] font-semibold text-white">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </Link>
            {profile ? (
              <form action={signOut}>
                <button
                  type="submit"
                  className="flex w-full items-center justify-center gap-1.5 rounded-full px-3.5 py-2.5 text-sm font-medium text-foreground-muted hover:bg-surface-muted"
                >
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                  Sign Out
                </button>
              </form>
            ) : (
              <Link
                href="/sign-in"
                onClick={() => setMobileOpen(false)}
                className="flex items-center justify-center gap-1.5 rounded-full px-3.5 py-2.5 text-center text-sm font-medium text-foreground-muted hover:bg-surface-muted"
              >
                <User className="h-4 w-4" aria-hidden="true" />
                Sign In
              </Link>
            )}
            <CTAButton href="/report" size="md" className="w-full">
              <CirclePlus className="h-4 w-4" aria-hidden="true" />
              Report a Problem
            </CTAButton>
          </div>
        </div>
      )}
    </header>
  );
}
