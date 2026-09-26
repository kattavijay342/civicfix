import { describe, it, expect } from "vitest";
import {
  normalizeDepartmentName,
  matchConfiguredDepartment,
  decideDepartment,
  jurisdictionMatchSpecificity,
  isJurisdictionCompatible,
  pickIncharge,
  routingStateFor,
  type ConfiguredDepartment,
  type InchargeCandidate,
} from "./routing";

const DEPARTMENTS: ConfiguredDepartment[] = [
  { id: "dept-roads", name: "Roads & Infrastructure" },
  { id: "dept-sanitation", name: "Sanitation" },
  { id: "dept-water", name: "Water Supply" },
  { id: "dept-drainage", name: "Drainage" },
  { id: "dept-electrical", name: "Electrical" },
  { id: "dept-general", name: "General Administration" },
];

const NARASARAOPET = {
  state: "Andhra Pradesh",
  district: "Palnadu",
  constituency: "Narasaraopet",
  area: "Narasaraopet Municipality",
};

function incharge(profile_id: string, scope: Partial<InchargeCandidate> = {}): InchargeCandidate {
  return {
    profile_id,
    gov_state: null,
    gov_district: null,
    gov_constituency: null,
    gov_area: null,
    created_at: "2026-09-01T00:00:00Z",
    ...scope,
  };
}

describe("normalizeDepartmentName", () => {
  it("ignores case, '&' vs 'and', punctuation and a trailing 'Department'", () => {
    expect(normalizeDepartmentName("Roads & Infrastructure")).toBe("roads and infrastructure");
    expect(normalizeDepartmentName("ROADS AND INFRASTRUCTURE DEPARTMENT")).toBe("roads and infrastructure");
    expect(normalizeDepartmentName("  Water-Supply Dept. ")).toBe("water supply");
    expect(normalizeDepartmentName("Electrical (Street Lighting)")).toBe("electrical");
  });
});

describe("matchConfiguredDepartment", () => {
  it("resolves the exact configured name", () => {
    expect(matchConfiguredDepartment("Roads & Infrastructure", DEPARTMENTS)?.id).toBe("dept-roads");
  });

  it("resolves the free-text variants Gemini has actually produced on the live project", () => {
    expect(matchConfiguredDepartment("Roads & Infrastructure Department", DEPARTMENTS)?.id).toBe("dept-roads");
    expect(matchConfiguredDepartment("Roads and Infrastructure Department", DEPARTMENTS)?.id).toBe("dept-roads");
    expect(matchConfiguredDepartment("Roads & Buildings Department", DEPARTMENTS)?.id).toBe("dept-roads");
    expect(matchConfiguredDepartment("Roads and Buildings Department", DEPARTMENTS)?.id).toBe("dept-roads");
    expect(matchConfiguredDepartment("Electricity and Public Lighting Department", DEPARTMENTS)?.id).toBe(
      "dept-electrical"
    );
    expect(
      matchConfiguredDepartment("Electrical Department / Street Lighting Division", DEPARTMENTS)?.id
    ).toBe("dept-electrical");
  });

  it("returns null for an unknown department instead of guessing", () => {
    expect(matchConfiguredDepartment("Ministry of Magic", DEPARTMENTS)).toBeNull();
    expect(matchConfiguredDepartment("Roads Maintenance Cell", DEPARTMENTS)).toBeNull();
    expect(matchConfiguredDepartment("", DEPARTMENTS)).toBeNull();
    expect(matchConfiguredDepartment(null, DEPARTMENTS)).toBeNull();
  });

  it("an alias can only resolve to a department that is actually configured", () => {
    const withoutRoads = DEPARTMENTS.filter((d) => d.id !== "dept-roads");
    expect(matchConfiguredDepartment("Roads & Buildings Department", withoutRoads)).toBeNull();
    expect(matchConfiguredDepartment("Roads & Infrastructure", withoutRoads)).toBeNull();
  });
});

describe("decideDepartment", () => {
  it("accepts a valid AI recommendation consistent with the category", () => {
    const d = decideDepartment({
      aiRecommendation: "Roads & Buildings Department",
      aiCategory: "ROAD",
      citizenCategory: "ROAD",
      departments: DEPARTMENTS,
    });
    expect(d).toMatchObject({ ok: true, basis: "ai_recommendation", department: { id: "dept-roads" } });
  });

  it("lets the AI correct a mis-picked citizen category (citizen: Other, AI: road)", () => {
    const d = decideDepartment({
      aiRecommendation: "Roads & Infrastructure",
      aiCategory: "ROAD",
      citizenCategory: "OTHER",
      departments: DEPARTMENTS,
    });
    expect(d).toMatchObject({ ok: true, basis: "ai_recommendation", department: { id: "dept-roads" } });
  });

  it("rejects a configured-but-inconsistent recommendation (pothole -> Water Supply) and uses the category mapping", () => {
    const d = decideDepartment({
      aiRecommendation: "Water Supply",
      aiCategory: "ROAD",
      citizenCategory: "ROAD",
      departments: DEPARTMENTS,
    });
    expect(d).toMatchObject({ ok: true, basis: "category_mapping", department: { id: "dept-roads" } });
    if (d.ok) expect(d.note).toContain("did not match the issue category");
  });

  it("falls back to the configured category mapping for an unknown recommendation — never invents one", () => {
    const d = decideDepartment({
      aiRecommendation: "Department of Potholes and Craters",
      aiCategory: "ROAD",
      citizenCategory: "ROAD",
      departments: DEPARTMENTS,
    });
    expect(d).toMatchObject({ ok: true, basis: "category_mapping", department: { id: "dept-roads" } });
    if (d.ok) expect(d.note).toContain("not a configured department");
  });

  it("is unresolved when the mapped department is not configured at all", () => {
    const d = decideDepartment({
      aiRecommendation: "Some Unknown Office",
      aiCategory: "ROAD",
      citizenCategory: "ROAD",
      departments: DEPARTMENTS.filter((x) => x.id !== "dept-roads"),
    });
    expect(d).toEqual({ ok: false, reason: "department_not_configured" });
  });

  it("uses the citizen category when there is no AI category", () => {
    const d = decideDepartment({
      aiRecommendation: null,
      aiCategory: null,
      citizenCategory: "STREETLIGHT",
      departments: DEPARTMENTS,
    });
    expect(d).toMatchObject({ ok: true, basis: "category_mapping", department: { id: "dept-electrical" } });
  });
});

describe("jurisdiction compatibility", () => {
  it("matches an in-charge whose every set level equals the report's", () => {
    expect(isJurisdictionCompatible(incharge("a", { gov_state: "Andhra Pradesh", gov_district: "Palnadu" }), NARASARAOPET)).toBe(true);
    expect(jurisdictionMatchSpecificity(incharge("a", { gov_state: "Andhra Pradesh", gov_district: "Palnadu" }), NARASARAOPET)).toBe(2);
  });

  it("rejects another municipality, constituency or district", () => {
    expect(
      isJurisdictionCompatible(
        incharge("a", {
          gov_state: "Andhra Pradesh",
          gov_district: "Guntur",
          gov_constituency: "Tenali",
          gov_area: "Tenali Municipality",
        }),
        NARASARAOPET
      )
    ).toBe(false);
    expect(
      isJurisdictionCompatible(
        incharge("a", {
          gov_state: "Andhra Pradesh",
          gov_district: "Palnadu",
          gov_constituency: "Narasaraopet",
          gov_area: "Some Other Area",
        }),
        NARASARAOPET
      )
    ).toBe(false);
    expect(isJurisdictionCompatible(incharge("a", { gov_state: "Andhra Pradesh", gov_district: "Guntur" }), NARASARAOPET)).toBe(false);
  });

  it("an in-charge with no jurisdiction scope covers nothing (never everything)", () => {
    expect(isJurisdictionCompatible(incharge("a"), NARASARAOPET)).toBe(false);
  });
});

describe("pickIncharge", () => {
  it("picks the most specifically scoped compatible in-charge", () => {
    const picked = pickIncharge(
      [
        incharge("district-level", { gov_state: "Andhra Pradesh", gov_district: "Palnadu" }),
        incharge("area-level", { ...scopeOf(NARASARAOPET) }),
        incharge("constituency-level", {
          gov_state: "Andhra Pradesh",
          gov_district: "Palnadu",
          gov_constituency: "Narasaraopet",
        }),
      ],
      NARASARAOPET
    );
    expect(picked).toBe("area-level");
  });

  it("never picks an in-charge from another jurisdiction, even if it's the only one", () => {
    expect(
      pickIncharge(
        [incharge("tenali", { gov_state: "Andhra Pradesh", gov_district: "Guntur", gov_constituency: "Tenali" })],
        NARASARAOPET
      )
    ).toBeNull();
    expect(pickIncharge([incharge("unscoped")], NARASARAOPET)).toBeNull();
    expect(pickIncharge([], NARASARAOPET)).toBeNull();
  });

  it("breaks ties deterministically (oldest assignment, then id) regardless of row order", () => {
    const a = incharge("b-newer", { ...scopeOf(NARASARAOPET), created_at: "2026-09-10T00:00:00Z" });
    const b = incharge("z-older", { ...scopeOf(NARASARAOPET), created_at: "2026-09-02T00:00:00Z" });
    const c = incharge("a-older", { ...scopeOf(NARASARAOPET), created_at: "2026-09-02T00:00:00Z" });
    expect(pickIncharge([a, b, c], NARASARAOPET)).toBe("a-older");
    expect(pickIncharge([c, b, a], NARASARAOPET)).toBe("a-older");
    expect(pickIncharge([b, a, c], NARASARAOPET)).toBe("a-older");
  });
});

describe("routingStateFor", () => {
  it("derives the state only from stored data", () => {
    expect(routingStateFor({ inchargeId: "u1" }, "ROUTED")).toBe("assigned");
    expect(routingStateFor({ inchargeId: null }, "ROUTED")).toBe("unassigned");
    expect(routingStateFor(null, "REPORTED")).toBe("pending_ai");
    expect(routingStateFor(null, "AI_ANALYZED")).toBe("pending_department");
    expect(routingStateFor(null, "RESOLVED")).toBe("not_routed");
  });
});

function scopeOf(j: typeof NARASARAOPET) {
  return { gov_state: j.state, gov_district: j.district, gov_constituency: j.constituency, gov_area: j.area };
}
