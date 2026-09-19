import Link from "next/link";
import { MapPinned } from "lucide-react";

const columns = [
  {
    heading: "Product",
    links: [
      { label: "How It Works", href: "/#how-it-works" },
      { label: "Issue Map", href: "/#explore" },
      { label: "Citizen Dashboard", href: "/dashboard" },
      { label: "Government Dashboard", href: "/government" },
      { label: "Report a Problem", href: "/report" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", href: "/#about" },
      { label: "Sign In", href: "/sign-in" },
      { label: "Image Credits", href: "/credits" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border bg-surface-muted">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-10 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <Link href="/" className="flex items-center gap-2 text-foreground">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-civic-600 text-white">
                <MapPinned className="h-4.5 w-4.5" aria-hidden="true" />
              </span>
              <span className="text-[17px] font-semibold tracking-tight">CivicFix</span>
            </Link>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-foreground-muted">
              An AI-powered civic issue reporting, routing, and resolution-tracking platform for
              citizens and government departments.
            </p>
          </div>
          {columns.map((col) => (
            <div key={col.heading}>
              <h3 className="text-sm font-semibold text-foreground">{col.heading}</h3>
              <ul className="mt-3 flex flex-col gap-2.5">
                {col.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-foreground-muted transition-colors hover:text-civic-700"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-12 flex flex-col-reverse items-center gap-3 border-t border-border pt-6 text-xs text-foreground-muted sm:flex-row sm:justify-between">
          <p>&copy; {new Date().getFullYear()} CivicFix. Built for civic-tech impact.</p>
          <p>Phase 1 — Foundation &amp; UI/UX</p>
        </div>
      </div>
    </footer>
  );
}
