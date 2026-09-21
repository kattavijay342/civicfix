import { describe, it, expect } from "vitest";
import { isCategoryEnabled } from "./preferences";

describe("isCategoryEnabled", () => {
  it("is enabled by default when preferences is null (opt-out, not opt-in)", () => {
    expect(isCategoryEnabled(null, "critical_issues")).toBe(true);
  });

  it("is enabled by default when preferences is set but the category key is absent", () => {
    expect(isCategoryEnabled({ report_updates: false }, "critical_issues")).toBe(true);
  });

  it("is disabled only when the category is explicitly false", () => {
    expect(isCategoryEnabled({ critical_issues: false }, "critical_issues")).toBe(false);
  });

  it("is enabled when the category is explicitly true", () => {
    expect(isCategoryEnabled({ critical_issues: true }, "critical_issues")).toBe(true);
  });
});
