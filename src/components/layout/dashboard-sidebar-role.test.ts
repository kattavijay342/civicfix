import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UserRole } from "@/lib/types";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/settings",
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));

const { DashboardSidebar, sidebarItemsForRole, backFallbackForRole } = await import("./DashboardSidebar");

const labels = (role: UserRole | null) => sidebarItemsForRole(role).map((i) => i.label);

describe("DashboardSidebar — role-based items", () => {
  it.each([
    ["citizen", ["Home", "Report a Problem", "My Reports", "Dashboard", "Notifications", "Settings"]],
    ["government", ["Overview", "Dashboard", "Issues / Reports", "Departments", "Notifications", "Settings"]],
    ["department_incharge", ["Overview", "Dashboard", "Assigned Issues", "Notifications", "Settings"]],
    ["admin", ["Admin Dashboard", "Users", "Departments", "Notifications", "Settings"]],
  ] as const)("shows the %s list", (role, expected) => {
    expect(labels(role)).toEqual(expected);
  });

  it("falls back to the citizen list when no role is resolved", () => {
    expect(labels(null)).toEqual(labels("citizen"));
  });

  it.each(["government", "department_incharge", "admin"] as const)("hides citizen-only items for %s", (role) => {
    const html = renderToStaticMarkup(createElement(DashboardSidebar, { role }));
    expect(html).not.toContain("Report a Problem");
    expect(html).not.toContain("My Reports");
    expect(html).not.toContain('href="/report"');
    expect(html).not.toContain('href="/dashboard/reports"');
  });

  it.each([
    ["government", "/government"],
    ["department_incharge", "/department"],
    ["admin", "/admin"],
  ] as const)("links %s's Dashboard to its own role home", (role, href) => {
    expect(sidebarItemsForRole(role).some((i) => i.href === href)).toBe(true);
  });

  it("keeps the notification badge and active state", () => {
    const html = renderToStaticMarkup(createElement(DashboardSidebar, { role: "government", unreadCount: 12 }));
    expect(html).toContain("9+");
    expect(html).toMatch(/class="[^"]*bg-civic-50[^"]*" href="\/dashboard\/settings"/);
  });

  it.each([
    ["government", "/government"],
    ["department_incharge", "/department"],
  ] as const)("adds a Back control for %s that falls back to %s", (role, fallback) => {
    expect(backFallbackForRole(role)).toBe(fallback);
    const html = renderToStaticMarkup(createElement(DashboardSidebar, { role }));
    // Once in the desktop sidebar and once in the mobile chip row.
    expect(html.match(new RegExp(`href="${fallback}" aria-label="Go back"`, "g"))).toHaveLength(2);
    // Additional control: Overview and Dashboard links are still there.
    expect(html).toContain(">Overview<");
    expect(html).toContain(">Dashboard<");
  });

  it.each(["citizen", "admin", null] as const)("adds no Back control for %s", (role) => {
    expect(backFallbackForRole(role)).toBeNull();
    const html = renderToStaticMarkup(createElement(DashboardSidebar, { role }));
    expect(html).not.toContain("Go back");
  });
});
