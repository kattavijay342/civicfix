import { describe, it, expect } from "vitest";
import {
  canAdvanceStatus,
  canSubmitResolution,
  nextDepartmentStatus,
  transitionErrorMessage,
  FORWARD_STATUSES,
  STATUS_ORDER,
} from "@/lib/status-transitions";
import type { IssueStatus } from "@/lib/types";

const ALL: IssueStatus[] = ["REPORTED", "AI_ANALYZED", "ROUTED", "ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED", "REOPENED"];

describe("G4 department lifecycle — Routed -> Acknowledged -> In Progress -> Resolved", () => {
  it("offers exactly one next step per status", () => {
    expect(nextDepartmentStatus("ROUTED")).toBe("ACKNOWLEDGED");
    expect(nextDepartmentStatus("ACKNOWLEDGED")).toBe("IN_PROGRESS");
    expect(nextDepartmentStatus("IN_PROGRESS")).toBe("RESOLVED");
    expect(nextDepartmentStatus("REOPENED")).toBe("ACKNOWLEDGED");
  });

  it("offers no department step before routing or after resolution", () => {
    expect(nextDepartmentStatus("REPORTED")).toBeNull();
    expect(nextDepartmentStatus("AI_ANALYZED")).toBeNull();
    expect(nextDepartmentStatus("RESOLVED")).toBeNull();
  });
});

describe("canAdvanceStatus — valid transitions", () => {
  it("allows Routed -> Acknowledged", () => {
    expect(canAdvanceStatus("ROUTED", "ACKNOWLEDGED")).toBe(true);
  });
  it("allows Acknowledged -> In Progress", () => {
    expect(canAdvanceStatus("ACKNOWLEDGED", "IN_PROGRESS")).toBe(true);
  });
  it("allows Reopened -> Acknowledged", () => {
    expect(canAdvanceStatus("REOPENED", "ACKNOWLEDGED")).toBe(true);
  });
});

describe("canAdvanceStatus — rejected transitions", () => {
  it("rejects skipping acknowledgement (Routed -> In Progress)", () => {
    expect(canAdvanceStatus("ROUTED", "IN_PROGRESS")).toBe(false);
  });
  it("rejects skipping from an unrouted report", () => {
    expect(canAdvanceStatus("REPORTED", "ACKNOWLEDGED")).toBe(false);
    expect(canAdvanceStatus("REPORTED", "IN_PROGRESS")).toBe(false);
    expect(canAdvanceStatus("AI_ANALYZED", "ACKNOWLEDGED")).toBe(false);
  });
  it("rejects moving backward from In Progress to Acknowledged", () => {
    expect(canAdvanceStatus("IN_PROGRESS", "ACKNOWLEDGED")).toBe(false);
  });
  it("rejects re-applying the same status (double click)", () => {
    expect(canAdvanceStatus("ACKNOWLEDGED", "ACKNOWLEDGED")).toBe(false);
    expect(canAdvanceStatus("IN_PROGRESS", "IN_PROGRESS")).toBe(false);
  });
  it("rejects setting Resolved directly (must go through submitResolution)", () => {
    expect(canAdvanceStatus("IN_PROGRESS", "RESOLVED")).toBe(false);
  });
  it("rejects every status not in FORWARD_STATUSES as a direct target, from any status", () => {
    const disallowed: IssueStatus[] = ["REPORTED", "AI_ANALYZED", "ROUTED", "RESOLVED", "REOPENED"];
    for (const target of disallowed) {
      expect(FORWARD_STATUSES).not.toContain(target);
      for (const from of ALL) expect(canAdvanceStatus(from, target)).toBe(false);
    }
  });
  it("never leaves Resolved (reopening is the citizen's action, not the department's)", () => {
    for (const target of ALL) expect(canAdvanceStatus("RESOLVED", target)).toBe(false);
    expect(canSubmitResolution("RESOLVED")).toBe(false);
  });
});

describe("canSubmitResolution", () => {
  it("allows resolution only from In Progress", () => {
    expect(canSubmitResolution("IN_PROGRESS")).toBe(true);
    for (const s of ALL.filter((s) => s !== "IN_PROGRESS")) expect(canSubmitResolution(s)).toBe(false);
  });
  it("rejects Reported -> Resolved and Acknowledged -> Resolved", () => {
    expect(canSubmitResolution("REPORTED")).toBe(false);
    expect(canSubmitResolution("ACKNOWLEDGED")).toBe(false);
  });
  it("requires a reopened report to go through acknowledge + in progress again", () => {
    expect(canSubmitResolution("REOPENED")).toBe(false);
    expect(canAdvanceStatus("REOPENED", "IN_PROGRESS")).toBe(false);
  });
});

describe("transitionErrorMessage", () => {
  it("explains duplicates, finished reports and the correct next step without internals", () => {
    expect(transitionErrorMessage("ACKNOWLEDGED", "ACKNOWLEDGED")).toBe("This report is already acknowledged.");
    expect(transitionErrorMessage("RESOLVED", "RESOLVED")).toBe("This report has already been resolved.");
    expect(transitionErrorMessage("ROUTED", "RESOLVED")).toContain('"Acknowledge"');
    expect(transitionErrorMessage("REPORTED", "ACKNOWLEDGED")).toContain("hasn't been routed");
  });
});

describe("STATUS_ORDER", () => {
  it("is strictly increasing along the documented lifecycle", () => {
    const lifecycle: IssueStatus[] = ["REPORTED", "AI_ANALYZED", "ROUTED", "ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED"];
    for (let i = 1; i < lifecycle.length; i++) {
      expect(STATUS_ORDER[lifecycle[i]]).toBeGreaterThan(STATUS_ORDER[lifecycle[i - 1]]);
    }
  });
  it("ranks Reopened with Routed, below Acknowledged", () => {
    expect(STATUS_ORDER.REOPENED).toBe(STATUS_ORDER.ROUTED);
    expect(STATUS_ORDER.REOPENED).toBeLessThan(STATUS_ORDER.ACKNOWLEDGED);
  });
});
