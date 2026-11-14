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
    ["department_incharge", "/department", "Department In-charge"],
    ["admin", "/admin", "Admin"],
  ] as const)("keeps %s's own dashboard link", (role, href, label) => {
    const html = render(role);
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain(`>${label}<`);
  });

  it("keeps the citizen dashboard link for citizens and visitors", () => {
    expect(render("citizen")).toContain('href="/dashboard"');
    expect(render(null)).toContain('href="/dashboard"');
  });
});

describe("Navbar — removed links", () => {
  it.each([null, "citizen", "government", "department_incharge", "admin"] as const)(
    "has no Home / How It Works / Issues / About links for %s",
    (role) => {
      const html = render(role);
      for (const label of ["Home", "How It Works", "Issues", "About"]) {
        expect(html).not.toContain(`>${label}</a>`);
      }
      for (const href of ["/#how-it-works", "/#explore", "/#about"]) {
        expect(html).not.toContain(`href="${href}"`);
      }
    },
  );

  it("has no Authorized Government User link for government", () => {
    const html = render("government");
    expect(html).not.toContain("Authorized Government User");
    expect(html).not.toContain('href="/government"');
  });
});
