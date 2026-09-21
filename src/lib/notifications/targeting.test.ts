import { describe, it, expect } from "vitest";
import { findGovernmentUsersForJurisdiction } from "./targeting";
import { makeFakeClient, type FakeDb } from "../../../test/fake-supabase";

describe("findGovernmentUsersForJurisdiction", () => {
  it("matches a government user scoped to exactly this location", async () => {
    const db: FakeDb = {
      profiles: [
        {
          id: "gov-1",
          role: "government",
          gov_state: "Andhra Pradesh",
          gov_district: "Palnadu",
          gov_constituency: "Narasaraopet",
          gov_area: "Narasaraopet Municipality",
        },
      ],
    };
    const ids = await findGovernmentUsersForJurisdiction(makeFakeClient(db) as never, {
      state: "Andhra Pradesh",
      district: "Palnadu",
      constituency: "Narasaraopet",
      area: "Narasaraopet Municipality",
    });
    expect(ids).toEqual(["gov-1"]);
  });

  it("matches a broader-scoped government user (null fields = wider jurisdiction)", async () => {
    const db: FakeDb = {
      profiles: [{ id: "gov-1", role: "government", gov_state: "Andhra Pradesh", gov_district: null, gov_constituency: null, gov_area: null }],
    };
    const ids = await findGovernmentUsersForJurisdiction(makeFakeClient(db) as never, {
      state: "Andhra Pradesh",
      district: "Guntur",
      constituency: "Tenali",
      area: "Tenali Municipality",
    });
    expect(ids).toEqual(["gov-1"]);
  });

  it("excludes a government user with no jurisdiction configured at all (never 'everyone' by default)", async () => {
    const db: FakeDb = {
      profiles: [{ id: "gov-1", role: "government", gov_state: null, gov_district: null, gov_constituency: null, gov_area: null }],
    };
    const ids = await findGovernmentUsersForJurisdiction(makeFakeClient(db) as never, {
      state: "Andhra Pradesh",
      district: "Palnadu",
      constituency: "Narasaraopet",
      area: "Narasaraopet Municipality",
    });
    expect(ids).toEqual([]);
  });

  it("excludes a government user scoped to a different area", async () => {
    const db: FakeDb = {
      profiles: [{ id: "gov-1", role: "government", gov_state: "Andhra Pradesh", gov_district: "Palnadu", gov_constituency: "Narasaraopet", gov_area: "Ward 5" }],
    };
    const ids = await findGovernmentUsersForJurisdiction(makeFakeClient(db) as never, {
      state: "Andhra Pradesh",
      district: "Palnadu",
      constituency: "Narasaraopet",
      area: "Narasaraopet Municipality",
    });
    expect(ids).toEqual([]);
  });

  it("never matches a non-government profile", async () => {
    const db: FakeDb = {
      profiles: [{ id: "citizen-1", role: "citizen", gov_state: null, gov_district: null, gov_constituency: null, gov_area: null }],
    };
    const ids = await findGovernmentUsersForJurisdiction(makeFakeClient(db) as never, {
      state: "Andhra Pradesh",
    });
    expect(ids).toEqual([]);
  });

  it("returns multiple matching government users when more than one covers the jurisdiction", async () => {
    const db: FakeDb = {
      profiles: [
        { id: "gov-1", role: "government", gov_state: "Andhra Pradesh", gov_district: null, gov_constituency: null, gov_area: null },
        { id: "gov-2", role: "government", gov_state: "Andhra Pradesh", gov_district: "Palnadu", gov_constituency: null, gov_area: null },
      ],
    };
    const ids = await findGovernmentUsersForJurisdiction(makeFakeClient(db) as never, {
      state: "Andhra Pradesh",
      district: "Palnadu",
    });
    expect(ids.sort()).toEqual(["gov-1", "gov-2"]);
  });
});
