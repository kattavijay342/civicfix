import { describe, it, expect } from "vitest";
import { maxLevel, levelFromRank, computeIncidentPriority, computeIncidentConfidence } from "./incident-priority";

describe("maxLevel", () => {
  it("returns the highest of several severities", () => {
    expect(maxLevel(["low", "high", "medium"])).toBe("high");
  });
  it("returns 'low' for an empty set rather than throwing", () => {
    expect(maxLevel([])).toBe("low");
  });
});

describe("levelFromRank", () => {
  it("maps 0-3 to low..critical", () => {
    expect(levelFromRank(0)).toBe("low");
    expect(levelFromRank(1)).toBe("medium");
    expect(levelFromRank(2)).toBe("high");
    expect(levelFromRank(3)).toBe("critical");
  });
  it("clamps out-of-range ranks instead of returning undefined", () => {
    expect(levelFromRank(-1)).toBe("low");
    expect(levelFromRank(99)).toBe("critical");
  });
});

describe("computeIncidentPriority", () => {
  const base = {
    memberSeverities: ["medium"] as const,
    affectedReportCount: 1,
    anyReopened: false,
    oldestReportAgeDays: 1,
    stillUnresolved: true,
  };

  it("starts at the highest member severity with no escalation", () => {
    const result = computeIncidentPriority({ ...base, memberSeverities: ["medium"] });
    expect(result.severity).toBe("medium");
    expect(result.priority).toBe("medium");
  });

  it("escalates one level when 3+ reports corroborate the same problem", () => {
    const result = computeIncidentPriority({ ...base, memberSeverities: ["medium"], affectedReportCount: 3 });
    expect(result.priority).toBe("high");
  });

  it("escalates one level when any linked report is reopened", () => {
    const result = computeIncidentPriority({ ...base, memberSeverities: ["low"], anyReopened: true });
    expect(result.priority).toBe("medium");
  });

  it("escalates one level when unresolved for more than 15 days", () => {
    const result = computeIncidentPriority({
      ...base,
      memberSeverities: ["low"],
      oldestReportAgeDays: 20,
      stillUnresolved: true,
    });
    expect(result.priority).toBe("medium");
  });

  it("does not escalate for aging when the incident is already resolved", () => {
    const result = computeIncidentPriority({
      ...base,
      memberSeverities: ["low"],
      oldestReportAgeDays: 40,
      stillUnresolved: false,
    });
    expect(result.priority).toBe("low");
  });

  it("caps escalation at critical even when every signal fires at once", () => {
    const result = computeIncidentPriority({
      memberSeverities: ["high"],
      affectedReportCount: 5,
      anyReopened: true,
      oldestReportAgeDays: 30,
      stillUnresolved: true,
    });
    expect(result.priority).toBe("critical");
  });

  it("never reports a severity higher than the worst linked report", () => {
    const result = computeIncidentPriority({
      memberSeverities: ["low", "medium"],
      affectedReportCount: 10,
      anyReopened: true,
      oldestReportAgeDays: 100,
      stillUnresolved: true,
    });
    expect(result.severity).toBe("medium");
    // priority may escalate well past severity, but severity itself never does.
    expect(result.priority).toBe("critical");
  });
});

describe("computeIncidentConfidence", () => {
  it("returns the max of member link confidences, not the average", () => {
    expect(computeIncidentConfidence([0.5, 0.9, 0.6])).toBeCloseTo(0.9);
  });
  it("returns 0 for no members rather than throwing", () => {
    expect(computeIncidentConfidence([])).toBe(0);
  });
});
