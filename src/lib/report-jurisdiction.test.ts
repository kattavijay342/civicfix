import { describe, it, expect } from "vitest";
import { resolveReportJurisdiction, MAX_AREA_LENGTH } from "./report-jurisdiction";

const NARASARAOPET = {
  state: "Andhra Pradesh",
  district: "Palnadu",
  constituency: "Narasaraopet",
  area: "Narasaraopet Municipality",
};

describe("resolveReportJurisdiction", () => {
  it("accepts a valid chain from the configured hierarchy unchanged", () => {
    expect(resolveReportJurisdiction(NARASARAOPET)).toEqual({ ok: true, jurisdiction: NARASARAOPET });
  });

  it("canonicalizes case/whitespace so it matches government scopes exactly", () => {
    const result = resolveReportJurisdiction({
      state: "  andhra pradesh ",
      district: "PALNADU",
      constituency: "narasaraopet",
      area: "narasaraopet   municipality",
    });
    expect(result).toEqual({ ok: true, jurisdiction: NARASARAOPET });
  });

  it("keeps a free-typed area that isn't in the list (the form allows it)", () => {
    const result = resolveReportJurisdiction({ ...NARASARAOPET, area: "  Ramireddypet  " });
    expect(result).toEqual({ ok: true, jurisdiction: { ...NARASARAOPET, area: "Ramireddypet" } });
  });

  it("rejects an unknown state", () => {
    expect(resolveReportJurisdiction({ ...NARASARAOPET, state: "Atlantis" }).ok).toBe(false);
  });

  it("rejects a district that isn't under the given state", () => {
    expect(resolveReportJurisdiction({ ...NARASARAOPET, district: "Hyderabad" }).ok).toBe(false);
  });

  it("rejects a constituency from a different district (can't forge another jurisdiction's chain)", () => {
    expect(resolveReportJurisdiction({ ...NARASARAOPET, constituency: "Tenali" }).ok).toBe(false);
  });

  it("rejects missing levels instead of storing a partial jurisdiction", () => {
    expect(resolveReportJurisdiction({ state: "Andhra Pradesh" }).ok).toBe(false);
    expect(resolveReportJurisdiction({ ...NARASARAOPET, constituency: undefined }).ok).toBe(false);
    expect(resolveReportJurisdiction({ ...NARASARAOPET, area: "   " }).ok).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(resolveReportJurisdiction({ ...NARASARAOPET, state: ["Andhra Pradesh"] }).ok).toBe(false);
    expect(resolveReportJurisdiction({ ...NARASARAOPET, area: 12 }).ok).toBe(false);
  });

  it("rejects an over-long area", () => {
    expect(resolveReportJurisdiction({ ...NARASARAOPET, area: "x".repeat(MAX_AREA_LENGTH + 1) }).ok).toBe(false);
  });
});
