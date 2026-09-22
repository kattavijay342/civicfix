import { describe, it, expect, vi, beforeEach } from "vitest";
import { findIncidentMatch } from "./incident-detection";
import { makeFakeClient, type FakeDb } from "../../test/fake-supabase";
import type { CivicLocation } from "@/lib/types";

const DAY = 24 * 60 * 60 * 1000;

vi.mock("./incident-ai-confirm", async () => {
  const actual = await vi.importActual<typeof import("./incident-ai-confirm")>("./incident-ai-confirm");
  return { ...actual, confirmSameIncident: vi.fn() };
});
import { confirmSameIncident, IncidentAIUnavailableError } from "./incident-ai-confirm";

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

function candidateReport(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "existing-1",
    description: "There is a large pothole in the middle of the road that keeps growing after rain.",
    created_at: new Date(Date.now() - DAY).toISOString(),
    category: "road",
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
    display_name: "Ward 12, Narasaraopet",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(confirmSameIncident).mockReset();
});

describe("findIncidentMatch", () => {
  it("classifies two clearly related reports (same area, same category, similar wording, close in time) as an auto-linkable match", async () => {
    const db: FakeDb = {
      reports: [candidateReport()],
      report_locations: [locationRow()],
      ai_analyses: [],
    };
    const result = await findIncidentMatch(makeFakeClient(db) as never, {
      reportId: "new-1",
      category: "road",
      location: baseLocation(),
      description: "Large pothole in the middle of the road, keeps growing after the rain.",
      createdAt: new Date().toISOString(),
    });

    expect(result).not.toBeNull();
    expect(result?.reportId).toBe("existing-1");
    expect(["duplicate", "related"]).toContain(result?.relationshipType);
    expect(result?.detectionMethod).toBe("rule_based");
    expect(confirmSameIncident).not.toHaveBeenCalled();
  });

  it("does NOT merge same category but a distant location", async () => {
    const db: FakeDb = {
      reports: [candidateReport()],
      report_locations: [
        locationRow({ district: "Guntur", constituency: "Tenali", area: "Ward 2", latitude: 16.9, longitude: 81.5 }),
      ],
      ai_analyses: [],
    };
    const result = await findIncidentMatch(makeFakeClient(db) as never, {
      reportId: "new-1",
      category: "road",
      location: baseLocation(),
      description: "Large pothole in the middle of the road, keeps growing after the rain.",
      createdAt: new Date().toISOString(),
    });
    expect(result).toBeNull();
  });

  it("does NOT merge same location but an unrelated category (the query itself never surfaces it as a candidate)", async () => {
    const db: FakeDb = {
      reports: [candidateReport({ category: "garbage" })],
      report_locations: [locationRow()],
      ai_analyses: [],
    };
    const result = await findIncidentMatch(makeFakeClient(db) as never, {
      reportId: "new-1",
      category: "road",
      location: baseLocation(),
      description: "Large pothole in the middle of the road, keeps growing after the rain.",
      createdAt: new Date().toISOString(),
    });
    expect(result).toBeNull();
  });

  it("does NOT merge similar wording when the location is different", async () => {
    const db: FakeDb = {
      reports: [candidateReport()],
      report_locations: [
        locationRow({ district: "Guntur", constituency: "Tenali", area: "Ward 9", latitude: 17.1, longitude: 81.9 }),
      ],
      ai_analyses: [],
    };
    const result = await findIncidentMatch(makeFakeClient(db) as never, {
      reportId: "new-1",
      category: "road",
      location: baseLocation(),
      description: candidateReport().description as string,
      createdAt: new Date().toISOString(),
    });
    expect(result).toBeNull();
  });

  it("excludes a resolved candidate report", async () => {
    const db: FakeDb = {
      reports: [candidateReport({ status: "resolved" })],
      report_locations: [locationRow()],
      ai_analyses: [],
    };
    const result = await findIncidentMatch(makeFakeClient(db) as never, {
      reportId: "new-1",
      category: "road",
      location: baseLocation(),
      description: "Large pothole in the middle of the road, keeps growing after the rain.",
      createdAt: new Date().toISOString(),
    });
    expect(result).toBeNull();
  });

  it("excludes a candidate older than the 30-day window", async () => {
    const db: FakeDb = {
      reports: [candidateReport({ created_at: new Date(Date.now() - 40 * DAY).toISOString() })],
      report_locations: [locationRow()],
      ai_analyses: [],
    };
    const result = await findIncidentMatch(makeFakeClient(db) as never, {
      reportId: "new-1",
      category: "road",
      location: baseLocation(),
      description: "Large pothole in the middle of the road, keeps growing after the rain.",
      createdAt: new Date().toISOString(),
    });
    expect(result).toBeNull();
  });

  it("keeps a genuinely low-confidence, unconfirmed match as 'candidate' rather than pretending certainty", async () => {
    const db: FakeDb = {
      reports: [candidateReport({ description: "Streetlight flickers occasionally near the market." })],
      report_locations: [locationRow({ area: "Ward 13" })], // near but not same-area
      ai_analyses: [],
    };
    vi.mocked(confirmSameIncident).mockResolvedValue({
      same_incident: false,
      confidence: 0.5,
      reasoning: "Different symptoms described.",
    });

    const result = await findIncidentMatch(makeFakeClient(db) as never, {
      reportId: "new-1",
      category: "road",
      location: baseLocation({ area: "Ward 12", latitude: 16.2334, longitude: 80.05 }),
      description: "Water pipe leaking heavily onto the road.",
      createdAt: new Date().toISOString(),
    });

    expect(result).not.toBeNull();
    expect(result?.relationshipType).toBe("candidate");
    expect(result?.detectionMethod).toBe("rule_based");
  });

  it("upgrades an ambiguous match to 'supporting'/ai_confirmed when Gemini confirms with sufficient confidence", async () => {
    const db: FakeDb = {
      reports: [candidateReport({ description: "Streetlight flickers occasionally near the market." })],
      report_locations: [locationRow({ area: "Ward 13" })],
      ai_analyses: [],
    };
    vi.mocked(confirmSameIncident).mockResolvedValue({
      same_incident: true,
      confidence: 0.85,
      reasoning: "Both describe the same broken streetlight near the market.",
    });

    const result = await findIncidentMatch(makeFakeClient(db) as never, {
      reportId: "new-1",
      category: "road",
      location: baseLocation({ area: "Ward 12", latitude: 16.2334, longitude: 80.05 }),
      description: "Water pipe leaking heavily onto the road.",
      createdAt: new Date().toISOString(),
    });

    expect(result?.relationshipType).toBe("supporting");
    expect(result?.detectionMethod).toBe("ai_confirmed");
    // Gemini's own confidence (0.85) is never substituted in as the stored score.
    expect(result?.score).toBeLessThan(0.72);
  });

  it("never crashes when Gemini is unavailable — falls back to the honest 'candidate' classification", async () => {
    const db: FakeDb = {
      reports: [candidateReport({ description: "Streetlight flickers occasionally near the market." })],
      report_locations: [locationRow({ area: "Ward 13" })],
      ai_analyses: [],
    };
    vi.mocked(confirmSameIncident).mockRejectedValue(new IncidentAIUnavailableError("quota exhausted"));

    const result = await findIncidentMatch(makeFakeClient(db) as never, {
      reportId: "new-1",
      category: "road",
      location: baseLocation({ area: "Ward 12", latitude: 16.2334, longitude: 80.05 }),
      description: "Water pipe leaking heavily onto the road.",
      createdAt: new Date().toISOString(),
    });

    expect(result).not.toBeNull();
    expect(result?.relationshipType).toBe("candidate");
  });

  it("returns null when there are no candidates at all", async () => {
    const db: FakeDb = { reports: [], report_locations: [], ai_analyses: [] };
    const result = await findIncidentMatch(makeFakeClient(db) as never, {
      reportId: "new-1",
      category: "road",
      location: baseLocation(),
      description: "A brand new unrelated issue.",
      createdAt: new Date().toISOString(),
    });
    expect(result).toBeNull();
  });

  it("boosts an existing report-level 'duplicate' classification into an auto-linked incident match", async () => {
    const db: FakeDb = {
      // Weak-ish text/geo signal on its own (near, not same-area, some overlap)…
      reports: [candidateReport({ description: "Pothole issue on the main road." })],
      report_locations: [locationRow({ area: "Ward 13" })],
      ai_analyses: [],
    };
    const result = await findIncidentMatch(makeFakeClient(db) as never, {
      reportId: "new-1",
      category: "road",
      location: baseLocation({ area: "Ward 12", latitude: 16.2334, longitude: 80.05 }),
      description: "Pothole problem on the main road, same spot as before.",
      createdAt: new Date().toISOString(),
      existingDuplicateCandidate: { reportId: "existing-1", relationType: "duplicate" },
    });

    expect(result).not.toBeNull();
    expect(result?.reportId).toBe("existing-1");
    expect(confirmSameIncident).not.toHaveBeenCalled();
  });
});
