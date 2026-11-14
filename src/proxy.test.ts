import { describe, it, expect } from "vitest";
import { isProtectedPath } from "./proxy";

describe("isProtectedPath", () => {
  it.each(["/dashboard", "/dashboard/settings", "/government/incidents/x", "/department", "/admin", "/notifications"])(
    "protects %s",
    (p) => expect(isProtectedPath(p)).toBe(true)
  );
  it.each(["/", "/sign-in", "/report", "/reports/abc", "/credits", "/auth/callback", "/dashboards", "/administrator"])(
    "leaves %s public",
    (p) => expect(isProtectedPath(p)).toBe(false)
  );
});
