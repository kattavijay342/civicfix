import { describe, it, expect } from "vitest";
import { buildCitizenSummary, STATUS_EXPLANATIONS } from "./citizen-summary";
import type { ReportDetail } from "./data/report-detail";
import type { IssueStatus } from "./types";

function baseReport(overrides: Partial<ReportDetail> = {}): ReportDetail {
  return {
    id: "report-1",
    title: "Pothole near RTC Bus Stand",
    description: "A large pothole.",
    category: "ROAD",
    status: "REPORTED",
    priority: null,
    severity: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    reporterId: "citizen-1",
    location: { displayName: "Sattenapalli", district: "Palnadu", state: "Andhra Pradesh", source: "manual" },
    media: [],
    aiAnalysis: null,
    assignment: null,
    followUps: [],
    statusHistory: [],
    resolutionEvidence: null,
    duplicateOf: null,
    resolutionFeedback: null,
    reopenedAt: null,
    ...overrides,
  };
}

describe("STATUS_EXPLANATIONS", () => {
  it("has an English and Telugu explanation for every IssueStatus, including REOPENED", () => {
    const statuses: IssueStatus[] = ["REPORTED", "AI_ANALYZED", "ROUTED", "ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED", "REOPENED"];
    for (const status of statuses) {
      expect(STATUS_EXPLANATIONS[status].whatItMeans.en.length).toBeGreaterThan(0);
      expect(STATUS_EXPLANATIONS[status].whatItMeans.te.length).toBeGreaterThan(0);
      expect(STATUS_EXPLANATIONS[status].nextStep.en.length).toBeGreaterThan(0);
      expect(STATUS_EXPLANATIONS[status].nextStep.te.length).toBeGreaterThan(0);
    }
  });
});

describe("buildCitizenSummary", () => {
  it("grounds the summary only in the title, location, and category when there is no AI analysis or assignment yet", () => {
    const summary = buildCitizenSummary(baseReport());
    expect(summary).toContain("Pothole near RTC Bus Stand");
    expect(summary).toContain("Palnadu");
    expect(summary).not.toMatch(/routed|department/i);
  });

  it("includes the AI-recommended department and priority when analysis exists", () => {
    const report = baseReport({
      status: "AI_ANALYZED",
      aiAnalysis: {
        problemSummary: "Pothole",
        category: "ROAD",
        severity: "HIGH",
        priority: "HIGH",
        reasoning: "Busy road",
        recommendedDepartment: "Roads & Engineering",
        recommendedAction: "Patch the road",
        confidence: 0.9,
        model: "gemini-3.6-flash",
        extended: null,
      },
    });
    const summary = buildCitizenSummary(report);
    expect(summary).toContain("high-priority");
    expect(summary).toContain("Roads & Engineering");
  });

  it("includes the assigned in-charge name when an assignment exists", () => {
    const report = baseReport({
      status: "ROUTED",
      assignment: { departmentName: "Roads & Engineering", inchargeName: "Ravi Kumar", inchargeId: "incharge-1" },
    });
    const summary = buildCitizenSummary(report);
    expect(summary).toContain("Roads & Engineering");
    expect(summary).toContain("Ravi Kumar");
  });

  it("never fabricates an in-charge name when none is assigned yet", () => {
    const report = baseReport({
      status: "ROUTED",
      assignment: { departmentName: "Roads & Engineering", inchargeName: null, inchargeId: null },
    });
    const summary = buildCitizenSummary(report);
    expect(summary).toContain("Roads & Engineering");
    expect(summary).not.toMatch(/null|undefined/i);
  });

  it("ends with the deterministic status explanation for the current status", () => {
    const report = baseReport({ status: "RESOLVED" });
    const summary = buildCitizenSummary(report);
    expect(summary).toContain(STATUS_EXPLANATIONS.RESOLVED.whatItMeans.en);
  });
});
