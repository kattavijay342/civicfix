"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Menu, X, MapPinned, LogOut } from "lucide-react";
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
];

const roleLabels: Record<string, string> = {
  citizen: "Citizen",
  government: "Authorized Government User",
  department_incharge: "Department In-charge",
  admin: "Admin",
};

export function Navbar({ profile }: { profile: Profile | null }) {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const homeLink = profile
    ? { label: roleLabels[profile.role] ?? "Dashboard", href: roleHomePath(profile.role) }
    : null;
  const links = homeLink ? [...navLinks, homeLink] : navLinks;

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
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-civic-600 text-white">
            <MapPinned className="h-4.5 w-4.5" aria-hidden="true" />
          </span>
          <span className="text-[17px] font-semibold tracking-tight">CivicFix</span>
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
          {profile ? (
            <form action={signOut}>
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-medium text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                Sign Out
              </button>
            </form>
          ) : (
            <Link
              href="/sign-in"
              className="rounded-full px-3.5 py-2 text-sm font-medium text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground"
            >
              Sign In
            </Link>
          )}
          <CTAButton href="/report" size="md">
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
                className="rounded-full px-3.5 py-2.5 text-center text-sm font-medium text-foreground-muted hover:bg-surface-muted"
              >
                Sign In
              </Link>
            )}
            <CTAButton href="/report" size="md" className="w-full">
              Report a Problem
            </CTAButton>
          </div>
        </div>
      )}
    </header>
  );
}
