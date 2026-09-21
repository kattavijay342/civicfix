import { describe, it, expect } from "vitest";
import { stateNames, getDistricts, getConstituencies, getAreas } from "@/lib/jurisdiction";

describe("jurisdiction hierarchy lookups", () => {
  it("lists at least the two configured demo states", () => {
    expect(stateNames).toContain("Andhra Pradesh");
    expect(stateNames).toContain("Telangana");
  });

  it("returns districts only for a real state", () => {
    expect(getDistricts("Andhra Pradesh").length).toBeGreaterThan(0);
    expect(getDistricts("Nonexistent State")).toEqual([]);
  });

  it("returns constituencies scoped to state + district", () => {
    const constituencies = getConstituencies("Andhra Pradesh", "Palnadu");
    expect(constituencies).toContain("Narasaraopet");
    // A real constituency name under the wrong district must not leak through.
    expect(getConstituencies("Andhra Pradesh", "Guntur")).not.toContain("Narasaraopet");
  });

  it("returns areas scoped to the full state + district + constituency chain", () => {
    const areas = getAreas("Andhra Pradesh", "Palnadu", "Narasaraopet");
    expect(areas).toContain("Ward 12");
    expect(getAreas("Andhra Pradesh", "Palnadu", "Gurazala")).not.toContain("Ward 12");
  });

  it("returns an empty list for any unmatched level rather than throwing", () => {
    expect(getConstituencies("Telangana", "Nonexistent District")).toEqual([]);
    expect(getAreas("Telangana", "Hyderabad", "Nonexistent Constituency")).toEqual([]);
  });
});
