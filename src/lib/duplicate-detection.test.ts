import { describe, it, expect } from "vitest";
import { findPossibleDuplicate } from "@/lib/duplicate-detection";
import { makeFakeClient, type FakeDb } from "../../test/fake-supabase";
import type { CivicLocation } from "@/lib/types";

const DAY = 24 * 60 * 60 * 1000;

function baseLocation(overrides: Partial<CivicLocation> = {}): CivicLocation {
  return {
    displayName: "Ward 12, Narasaraopet",
    district: "Palnadu",
    constituency: "Narasaraopet",
    area: "Ward 12",
    latitude: 16.2333,
    longitude: 80.0499,
    source: "manual",
    ...overrides,
  };
}

function existingReport(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "existing-1",
    title: "Large pothole near bus stand",
    description: "There is a large pothole in the middle of the road that keeps growing after rain.",
    created_at: new Date(Date.now() - DAY).toISOString(),
    ...overrides,
  };
}

function locationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    report_id: "existing-1",
    district: "Palnadu",
    constituency: "Narasaraopet",
    area: "Ward 12",
    latitude: 16.2333,
    longitude: 80.0499,
    ...overrides,
  };
}

describe("findPossibleDuplicate", () => {
  it("flags a similar report in the same area, same category, recent, unresolved", async () => {
    const db: FakeDb = {
      reports: [existingReport({ category: "road" })],
      report_locations: [locationRow()],
    };
    const result = await findPossibleDuplicate(makeFakeClient(db) as never, {
      category: "road",
      location: baseLocation(),
      description: "Big pothole in the road, keeps growing after the rain.",
    });

    expect(result).not.toBeNull();
    expect(result?.reportId).toBe("existing-1");
    expect(result?.score).toBeGreaterThanOrEqual(0.55);
    expect(result?.reason).toBeTruthy();
    expect(["duplicate", "related"]).toContain(result?.relationType);
  });

  it("classifies a near-identical description in the same area as 'duplicate'", async () => {
    const db: FakeDb = {
      reports: [existingReport({ category: "road", description: "Big pothole in the middle of the road that keeps growing after rain." })],
      report_locations: [locationRow()],
    };
    const result = await findPossibleDuplicate(makeFakeClient(db) as never, {
      category: "road",
      location: baseLocation(),
      description: "Big pothole in the middle of the road that keeps growing after rain.",
    });

    expect(result).not.toBeNull();
    expect(result?.relationType).toBe("duplicate");
    expect(result?.reason).toContain("similar wording");
  });

  it("classifies a same-area, differently-worded report as 'related' rather than 'duplicate'", async () => {
    const db: FakeDb = {
      reports: [existingReport({ category: "road", description: "Streetlight pole leaning dangerously near the school gate." })],
      report_locations: [locationRow()],
    };
    const result = await findPossibleDuplicate(makeFakeClient(db) as never, {
      category: "road",
      location: baseLocation(),
      description: "Garbage piling up outside the market entrance.",
    });

    expect(result).not.toBeNull();
    expect(result?.relationType).toBe("related");
  });

  it("returns null when there is no report in the same area or nearby", async () => {
    const db: FakeDb = {
      reports: [existingReport({ category: "road" })],
      report_locations: [locationRow({ district: "Guntur", constituency: "Tenali", area: "Ward 2", latitude: 16.5, longitude: 80.6 })],
    };
    const result = await findPossibleDuplicate(makeFakeClient(db) as never, {
      category: "road",
      location: baseLocation(),
      description: "Big pothole in the road.",
    });

    expect(result).toBeNull();
  });

  it("ignores a resolved report even in the same area", async () => {
    // findPossibleDuplicate's own query already excludes status = 'resolved'
    // — model that exclusion here since the fake client has no .neq semantics
    // beyond a plain filter (it does support neq; this asserts the real
    // query actually applies it).
    const db: FakeDb = {
      reports: [existingReport({ category: "road", status: "resolved" })],
      report_locations: [locationRow()],
    };
    const result = await findPossibleDuplicate(makeFakeClient(db) as never, {
      category: "road",
      location: baseLocation(),
      description: "Big pothole in the road.",
    });

    expect(result).toBeNull();
  });

  it("ignores a report older than the 14-day window", async () => {
    const db: FakeDb = {
      reports: [existingReport({ category: "road", created_at: new Date(Date.now() - 20 * DAY).toISOString() })],
      report_locations: [locationRow()],
    };
    const result = await findPossibleDuplicate(makeFakeClient(db) as never, {
      category: "road",
      location: baseLocation(),
      description: "Big pothole in the road.",
    });

    expect(result).toBeNull();
  });

  it("flags a nearby report (within ~300m) even when jurisdiction fields differ", async () => {
    const db: FakeDb = {
      reports: [existingReport({ category: "drainage" })],
      // ~50m away, different area label but close coordinates.
      report_locations: [locationRow({ area: "Ward 5", latitude: 16.2337, longitude: 80.0502 })],
    };
    const result = await findPossibleDuplicate(makeFakeClient(db) as never, {
      category: "drainage",
      location: baseLocation({ area: "Ward 12" }),
      description: "Drain overflowing near the bus stand.",
    });

    expect(result).not.toBeNull();
  });

  it("never blocks submission if duplicate detection has no candidates", async () => {
    const db: FakeDb = { reports: [], report_locations: [] };
    const result = await findPossibleDuplicate(makeFakeClient(db) as never, {
      category: "road",
      location: baseLocation(),
      description: "A new unrelated issue.",
    });
    expect(result).toBeNull();
  });
});
