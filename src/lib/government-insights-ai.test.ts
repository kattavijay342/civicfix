import { describe, it, expect } from "vitest";
import {
  buildGovernmentMetricsSnapshot,
  validateInsightsAgainstMetrics,
  insightSchema,
  type GovernmentAIInsight,
} from "./government-insights-ai";

function insight(overrides: Partial<GovernmentAIInsight> = {}): GovernmentAIInsight {
  return {
    insight_type: "workload",
    title: "Test insight",
    summary: "A test summary.",
    supporting_metrics: [{ metric: "critical", value: 3 }],
    confidence: 0.8,
    ...overrides,
  };
}

describe("buildGovernmentMetricsSnapshot", () => {
  it("flattens overview fields into the metrics map", () => {
    const metrics = buildGovernmentMetricsSnapshot({
      overview: { totalIssues: 10, resolved: 6, pending: 4, critical: 2, resolutionRate: 60 },
      aging: null,
      quality: null,
      categories: [],
      workload: [],
    });
    expect(metrics.total_issues).toBe(10);
    expect(metrics.resolved).toBe(6);
    expect(metrics.critical).toBe(2);
    expect(metrics.resolution_rate).toBe(60);
  });

  it("omits aging/quality keys entirely when those aggregates are unavailable, rather than fabricating zeros", () => {
    const metrics = buildGovernmentMetricsSnapshot({
      overview: { totalIssues: 1, resolved: 0, pending: 1, critical: 0, resolutionRate: 0 },
      aging: null,
      quality: null,
      categories: [],
      workload: [],
    });
    expect(metrics.aging_0_1_days).toBeUndefined();
    expect(metrics.resolution_quality_resolved).toBeUndefined();
  });

  it("includes real aging/quality/category/department fields when available", () => {
    const metrics = buildGovernmentMetricsSnapshot({
      overview: { totalIssues: 20, resolved: 12, pending: 8, critical: 3, resolutionRate: 60 },
      aging: { "0_1": 2, "2_3": 3, "4_7": 1, "8_14": 1, "15_30": 1, "30_plus": 0 },
      quality: {
        resolved: 12,
        citizenConfirmed: 9,
        confirmationPending: 2,
        currentlyReopened: 1,
        reopenedTotalEver: 3,
        reopenedPercentage: 25,
      },
      categories: [{ category: "ROAD", count: 8 }],
      workload: [{ departmentId: "d1", name: "Roads & Engineering", activeIssues: 5, currentlyReopened: 1, awaitingAcknowledgement: 2, inProgressOver7Days: 0 }],
    });
    expect(metrics.aging_15_30_days).toBe(1);
    expect(metrics.resolution_quality_currently_reopened).toBe(1);
    expect(metrics.category_road).toBe(8);
    expect(metrics.department_roads_engineering_active).toBe(5);
  });
});

describe("validateInsightsAgainstMetrics", () => {
  const realMetrics = { critical: 3, resolved: 12, category_road: 8 };

  it("accepts an insight whose supporting_metrics exactly match real values", () => {
    const result = validateInsightsAgainstMetrics([insight()], realMetrics);
    expect(result).toHaveLength(1);
    expect(result[0].supportingMetrics).toEqual({ critical: 3 });
  });

  it("rejects an insight that cites a metric key not present in the real metrics", () => {
    const result = validateInsightsAgainstMetrics(
      [insight({ supporting_metrics: [{ metric: "fabricated_metric", value: 99 }] })],
      realMetrics
    );
    expect(result).toHaveLength(0);
  });

  it("rejects an insight whose cited value doesn't match the real value (AI misquoted the number)", () => {
    const result = validateInsightsAgainstMetrics(
      [insight({ supporting_metrics: [{ metric: "critical", value: 999 }] })],
      realMetrics
    );
    expect(result).toHaveLength(0);
  });

  it("rejects an insight with zero supporting metrics", () => {
    const result = validateInsightsAgainstMetrics([insight({ supporting_metrics: [] })], realMetrics);
    expect(result).toHaveLength(0);
  });

  it("rejects only the bad insight when mixed with a good one, keeping the database as the source of truth", () => {
    const good = insight({ title: "Good", supporting_metrics: [{ metric: "resolved", value: 12 }] });
    const bad = insight({ title: "Bad", supporting_metrics: [{ metric: "resolved", value: 5 }] });
    const result = validateInsightsAgainstMetrics([good, bad], realMetrics);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Good");
  });

  it("accepts an insight citing multiple real metrics together", () => {
    const result = validateInsightsAgainstMetrics(
      [insight({ supporting_metrics: [{ metric: "critical", value: 3 }, { metric: "category_road", value: 8 }] })],
      realMetrics
    );
    expect(result).toHaveLength(1);
    expect(result[0].supportingMetrics).toEqual({ critical: 3, category_road: 8 });
  });
});

describe("insightSchema", () => {
  it("rejects confidence outside [0,1]", () => {
    expect(insightSchema.safeParse(insight({ confidence: 1.5 })).success).toBe(false);
    expect(insightSchema.safeParse(insight({ confidence: -0.1 })).success).toBe(false);
  });

  it("rejects an unknown insight_type", () => {
    expect(insightSchema.safeParse({ ...insight(), insight_type: "political_ranking" }).success).toBe(false);
  });

  it("accepts a well-formed insight", () => {
    expect(insightSchema.safeParse(insight()).success).toBe(true);
  });
});
