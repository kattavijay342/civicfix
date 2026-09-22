import { describe, it, expect } from "vitest";
import { deriveIncidentDisplayStatus } from "./incident-status";

describe("deriveIncidentDisplayStatus", () => {
  it("shows the stored status when nothing is reopened", () => {
    expect(deriveIncidentDisplayStatus("open", false)).toBe("ROUTED");
    expect(deriveIncidentDisplayStatus("in_progress", false)).toBe("IN_PROGRESS");
    expect(deriveIncidentDisplayStatus("resolved", false)).toBe("RESOLVED");
  });

  it("a reopened linked report always wins, even over an explicit 'resolved'", () => {
    expect(deriveIncidentDisplayStatus("resolved", true)).toBe("REOPENED");
    expect(deriveIncidentDisplayStatus("in_progress", true)).toBe("REOPENED");
    expect(deriveIncidentDisplayStatus("open", true)).toBe("REOPENED");
  });
});
