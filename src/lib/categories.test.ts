import { describe, it, expect } from "vitest";
import { categoryLabels, categoryOrder } from "@/lib/categories";
import { departmentNameForCategory, categoryDepartmentMap } from "@/lib/routing";
import type { ProblemCategory } from "@/lib/types";

describe("categoryOrder / categoryLabels", () => {
  it("has a label for every category in categoryOrder", () => {
    for (const category of categoryOrder) {
      expect(categoryLabels[category]).toBeTruthy();
    }
  });
  it("has no duplicate categories in categoryOrder", () => {
    expect(new Set(categoryOrder).size).toBe(categoryOrder.length);
  });
});

describe("departmentNameForCategory", () => {
  it("maps every category to a configured department, never undefined", () => {
    for (const category of categoryOrder) {
      expect(departmentNameForCategory(category)).toBeTruthy();
    }
  });
  it("is the single source of truth used by routing — never derived from AI output", () => {
    // Route sanity: ROAD and INFRASTRUCTURE both go to the same department,
    // matching the documented mapping in src/lib/routing.ts.
    expect(departmentNameForCategory("ROAD" as ProblemCategory)).toBe(categoryDepartmentMap.ROAD);
    expect(departmentNameForCategory("INFRASTRUCTURE" as ProblemCategory)).toBe(categoryDepartmentMap.ROAD);
  });
});
