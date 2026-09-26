import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Profile } from "@/lib/types";

vi.mock("@/lib/actions/auth", () => ({ signOut: vi.fn() }));

const { Navbar } = await import("./Navbar");

function render(role: Profile["role"] | null): string {
  const profile = role ? ({ id: `${role}-1`, role } as Profile) : null;
  return renderToStaticMarkup(createElement(Navbar, { profile }));
}

const reportCta = /<a[^>]*href="\/report"[^>]*>[\s\S]*?Report a Problem[\s\S]*?<\/a>/;

describe("Navbar — Report a Problem visibility", () => {
  it.each([
    ["signed-out visitor", null],
    ["citizen", "citizen"],
  ] as const)("is shown for a %s", (_label, role) => {
    expect(render(role)).toMatch(reportCta);
  });

  it.each(["government", "department_incharge", "admin"] as const)("is hidden for %s", (role) => {
    const html = render(role);
    expect(html).not.toMatch(reportCta);
    expect(html).not.toContain("Report a Problem");
  });

  it.each([
    ["government", "/government", "Authorized Government User"],
    ["department_incharge", "/department", "Department In-charge"],
    ["admin", "/admin", "Admin"],
  ] as const)("keeps %s's own dashboard link and the public links", (role, href, label) => {
    const html = render(role);
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain(`>${label}<`);
    for (const publicHref of ["/", "/#how-it-works", "/#explore", "/#about"]) {
      expect(html).toContain(`href="${publicHref}"`);
    }
  });

  it("keeps the citizen dashboard link for citizens and visitors", () => {
    expect(render("citizen")).toContain('href="/dashboard"');
    expect(render(null)).toContain('href="/dashboard"');
  });
});
