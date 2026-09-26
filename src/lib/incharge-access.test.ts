import { describe, it, expect } from "vitest";
import { evaluateInchargeAccess, type InchargeAccessInput } from "@/lib/incharge-access";

const NARASARAOPET = {
  state: "Andhra Pradesh",
  district: "Palnadu",
  constituency: "Narasaraopet",
  area: "Narasaraopet Municipality",
};
const TENALI = { state: "Andhra Pradesh", district: "Guntur", constituency: "Tenali", area: "Tenali Municipality" };
const scopeOf = (j: typeof NARASARAOPET) => ({
  gov_state: j.state,
  gov_district: j.district,
  gov_constituency: j.constituency,
  gov_area: j.area,
});

function input(overrides: Partial<InchargeAccessInput> = {}): InchargeAccessInput {
  return {
    userId: "incharge-a",
    profile: { role: "department_incharge", department_id: "dept-roads" },
    assignment: { incharge_id: "incharge-a", department_id: "dept-roads" },
    inchargeRows: [{ department_id: "dept-roads", is_active: true, ...scopeOf(NARASARAOPET) }],
    location: NARASARAOPET,
    ...overrides,
  };
}

describe("evaluateInchargeAccess", () => {
  it("ALLOWS the assigned, active, in-scope in-charge", () => {
    expect(evaluateInchargeAccess(input())).toEqual({ ok: true });
  });

  it("allows a broader (district-only) scope that still covers the report", () => {
    const rows = [{ department_id: "dept-roads", is_active: true, gov_state: "Andhra Pradesh", gov_district: "Palnadu", gov_constituency: null, gov_area: null }];
    expect(evaluateInchargeAccess(input({ inchargeRows: rows }))).toEqual({ ok: true });
  });

  it("DENIES a different in-charge (same department) for someone else's report", () => {
    expect(evaluateInchargeAccess(input({ userId: "incharge-b" }))).toEqual({ ok: false, reason: "not_assigned" });
  });

  it("DENIES an unassigned report (no assignment row / no in-charge)", () => {
    expect(evaluateInchargeAccess(input({ assignment: null }))).toEqual({ ok: false, reason: "not_assigned" });
    expect(
      evaluateInchargeAccess(input({ assignment: { incharge_id: null, department_id: "dept-roads" } }))
    ).toEqual({ ok: false, reason: "not_assigned" });
  });

  it("DENIES non-in-charge roles (citizen, government, admin go through their own paths)", () => {
    for (const role of ["citizen", "government", "admin"]) {
      expect(evaluateInchargeAccess(input({ profile: { role, department_id: "dept-roads" } }))).toEqual({
        ok: false,
        reason: "not_incharge",
      });
    }
    expect(evaluateInchargeAccess(input({ profile: null }))).toEqual({ ok: false, reason: "not_incharge" });
  });

  it("STALE: in-charge moved to another department keeps no access to the old assignment", () => {
    expect(
      evaluateInchargeAccess(input({ profile: { role: "department_incharge", department_id: "dept-water" } }))
    ).toEqual({ ok: false, reason: "wrong_department" });
  });

  it("STALE: deactivated in-charge row grants nothing", () => {
    const rows = [{ department_id: "dept-roads", is_active: false, ...scopeOf(NARASARAOPET) }];
    expect(evaluateInchargeAccess(input({ inchargeRows: rows }))).toEqual({ ok: false, reason: "inactive" });
  });

  it("STALE: an active row for a DIFFERENT department does not count", () => {
    const rows = [{ department_id: "dept-water", is_active: true, ...scopeOf(NARASARAOPET) }];
    expect(evaluateInchargeAccess(input({ inchargeRows: rows }))).toEqual({ ok: false, reason: "inactive" });
  });

  it("STALE: in-charge re-scoped to another jurisdiction loses the old report", () => {
    const rows = [{ department_id: "dept-roads", is_active: true, ...scopeOf(TENALI) }];
    expect(evaluateInchargeAccess(input({ inchargeRows: rows }))).toEqual({ ok: false, reason: "out_of_jurisdiction" });
  });

  it("DENIES when the report has no stored location (jurisdiction can't be verified — fail closed)", () => {
    expect(evaluateInchargeAccess(input({ location: null }))).toEqual({ ok: false, reason: "out_of_jurisdiction" });
  });

  it("DENIES an in-charge row with no scope at all (covers nothing, same as G3 routing)", () => {
    const rows = [{ department_id: "dept-roads", is_active: true, gov_state: null, gov_district: null, gov_constituency: null, gov_area: null }];
    expect(evaluateInchargeAccess(input({ inchargeRows: rows }))).toEqual({ ok: false, reason: "out_of_jurisdiction" });
  });
});
