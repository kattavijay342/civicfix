import { describe, it, expect } from "vitest";
import { canAdvanceStatus, canSubmitResolution, FORWARD_STATUSES, STATUS_ORDER } from "@/lib/status-transitions";
import type { IssueStatus } from "@/lib/types";

describe("canAdvanceStatus — valid transitions", () => {
  it("allows Routed -> Acknowledged", () => {
    expect(canAdvanceStatus("ROUTED", "ACKNOWLEDGED")).toBe(true);
  });
  it("allows Acknowledged -> In Progress", () => {
    expect(canAdvanceStatus("ACKNOWLEDGED", "IN_PROGRESS")).toBe(true);
  });
  it("allows Reported -> In Progress (skipping intermediate stages forward is fine)", () => {
    expect(canAdvanceStatus("REPORTED", "IN_PROGRESS")).toBe(true);
  });
});

describe("canAdvanceStatus — rejected transitions", () => {
  it("rejects moving backward from In Progress to Acknowledged", () => {
    expect(canAdvanceStatus("IN_PROGRESS", "ACKNOWLEDGED")).toBe(false);
  });
  it("rejects re-applying the same status", () => {
    expect(canAdvanceStatus("ACKNOWLEDGED", "ACKNOWLEDGED")).toBe(false);
  });
  it("rejects setting Resolved directly (must go through submitResolution)", () => {
    expect(canAdvanceStatus("IN_PROGRESS", "RESOLVED")).toBe(false);
  });
  it("rejects every status not in FORWARD_STATUSES as a direct target", () => {
    const disallowed: IssueStatus[] = ["REPORTED", "AI_ANALYZED", "ROUTED", "RESOLVED", "REOPENED"];
    for (const target of disallowed) {
      expect(FORWARD_STATUSES).not.toContain(target);
      expect(canAdvanceStatus("REPORTED", target)).toBe(false);
    }
  });
});

describe("REOPENED — Phase 6D", () => {
  it("is ranked below ACKNOWLEDGED/IN_PROGRESS, not above RESOLVED", () => {
    expect(STATUS_ORDER.REOPENED).toBeLessThan(STATUS_ORDER.ACKNOWLEDGED);
    expect(STATUS_ORDER.REOPENED).toBeLessThan(STATUS_ORDER.IN_PROGRESS);
    expect(STATUS_ORDER.REOPENED).toBeLessThan(STATUS_ORDER.RESOLVED);
  });

  it("can never be set directly via updateReportStatus (only via submitResolutionFeedback)", () => {
    expect(canAdvanceStatus("RESOLVED", "REOPENED")).toBe(false);
  });

  it("requires the department to acknowledge/progress again before resolving a second time", () => {
    expect(canAdvanceStatus("REOPENED", "ACKNOWLEDGED")).toBe(true);
    expect(canAdvanceStatus("REOPENED", "IN_PROGRESS")).toBe(true);
    expect(canSubmitResolution("REOPENED")).toBe(false);
    expect(canSubmitResolution("ACKNOWLEDGED")).toBe(true);
  });
});

describe("canSubmitResolution", () => {
  it("allows resolution once acknowledged or later, before Resolved", () => {
    expect(canSubmitResolution("ACKNOWLEDGED")).toBe(true);
    expect(canSubmitResolution("IN_PROGRESS")).toBe(true);
  });
  it("rejects resolution before acknowledgement", () => {
    expect(canSubmitResolution("REPORTED")).toBe(false);
    expect(canSubmitResolution("AI_ANALYZED")).toBe(false);
    expect(canSubmitResolution("ROUTED")).toBe(false);
  });
  it("rejects resolving an already-resolved report a second time", () => {
    expect(canSubmitResolution("RESOLVED")).toBe(false);
  });
});

describe("STATUS_ORDER", () => {
  it("is strictly increasing along the documented lifecycle", () => {
    const lifecycle: IssueStatus[] = ["REPORTED", "AI_ANALYZED", "ROUTED", "ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED"];
    for (let i = 1; i < lifecycle.length; i++) {
      expect(STATUS_ORDER[lifecycle[i]]).toBeGreaterThan(STATUS_ORDER[lifecycle[i - 1]]);
    }
  });
});
