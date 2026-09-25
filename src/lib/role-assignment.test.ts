import { describe, it, expect } from "vitest";
import { buildRoleAssignment, validateJurisdiction, type JurisdictionInput } from "./role-assignment";
import { isAppRole, resolveRoleHome, roleHomePath, PROVISIONABLE_ROLES } from "./role-routes";

const NARASARAOPET: JurisdictionInput = {
  govState: "Andhra Pradesh",
  govDistrict: "Palnadu",
  govConstituency: "Narasaraopet",
  govArea: "Narasaraopet Municipality",
};
const NONE: JurisdictionInput = { govState: null, govDistrict: null, govConstituency: null, govArea: null };

describe("role routing", () => {
  it.each([
    ["citizen", "/dashboard"],
    ["government", "/government"],
    ["department_incharge", "/department"],
    ["admin", "/admin"],
  ] as const)("%s lands on %s", (role, path) => {
    expect(roleHomePath(role)).toBe(path);
    expect(resolveRoleHome(role)).toBe(path);
  });

  it.each([null, undefined, "", "superuser", "Admin", " admin", 1])(
    "resolveRoleHome(%j) is null — unknown roles are never mapped to a dashboard",
    (value) => {
      expect(isAppRole(value)).toBe(false);
      expect(resolveRoleHome(value)).toBeNull();
    }
  );

  it("never lets admin be provisioned through Create Authorized User", () => {
    expect(PROVISIONABLE_ROLES).toEqual(["government", "department_incharge"]);
    expect(PROVISIONABLE_ROLES).not.toContain("admin");
  });
});

describe("validateJurisdiction", () => {
  it("accepts a full, consistent hierarchy and a state-only scope", () => {
    expect(validateJurisdiction(NARASARAOPET)).toBeNull();
    expect(validateJurisdiction({ ...NONE, govState: "Andhra Pradesh" })).toBeNull();
  });

  it("rejects values that aren't in the configured hierarchy", () => {
    expect(validateJurisdiction({ ...NARASARAOPET, govState: "Atlantis" })).toMatch(/Unknown state/);
    expect(validateJurisdiction({ ...NARASARAOPET, govArea: "Somewhere Else" })).toMatch(/Unknown area/);
  });

  it("rejects a child level without its parent (can't widen scope by skipping a level)", () => {
    expect(validateJurisdiction({ ...NARASARAOPET, govState: null })).toMatch(/Unknown district/);
    expect(validateJurisdiction({ ...NARASARAOPET, govConstituency: null })).toMatch(/Unknown area/);
  });
});

describe("buildRoleAssignment", () => {
  it("stores role + full jurisdiction for an Authorized Government User", () => {
    const result = buildRoleAssignment("government", null, NARASARAOPET);
    expect(result).toEqual({
      assignment: {
        role: "government",
        department_id: null,
        gov_state: "Andhra Pradesh",
        gov_district: "Palnadu",
        gov_constituency: "Narasaraopet",
        gov_area: "Narasaraopet Municipality",
      },
    });
  });

  it("stores department + jurisdiction for a Department In-charge", () => {
    const result = buildRoleAssignment("department_incharge", "dept-roads", NARASARAOPET);
    expect("assignment" in result && result.assignment).toMatchObject({
      role: "department_incharge",
      department_id: "dept-roads",
      gov_area: "Narasaraopet Municipality",
    });
  });

  it("requires a department for a Department In-charge", () => {
    expect(buildRoleAssignment("department_incharge", null, NARASARAOPET)).toEqual({
      error: "Select a department for a department in-charge.",
    });
  });

  it("requires a jurisdiction for government and department roles", () => {
    expect(buildRoleAssignment("government", null, NONE)).toHaveProperty("error");
    expect(buildRoleAssignment("department_incharge", "dept-roads", NONE)).toHaveProperty("error");
  });

  it("drops department/jurisdiction for roles they don't apply to (no stale scope after a demotion)", () => {
    const result = buildRoleAssignment("citizen", "dept-roads", NARASARAOPET);
    expect(result).toEqual({
      assignment: {
        role: "citizen",
        department_id: null,
        gov_state: null,
        gov_district: null,
        gov_constituency: null,
        gov_area: null,
      },
    });
  });

  it("rejects anything that isn't a real role", () => {
    expect(buildRoleAssignment("superadmin", null, NARASARAOPET)).toEqual({ error: "Invalid role." });
  });
});
