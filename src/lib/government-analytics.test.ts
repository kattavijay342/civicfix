import { describe, it, expect } from "vitest";
import {
  compareCategoryPeriods,
  distinctLevelValues,
  formatAvgResolutionDays,
  mapAreaBreakdownRows,
  resolutionRate,
  rowsMatchingFilter,
  sumAreaBreakdown,
} from "./government-analytics";

const NRT = { state: "Andhra Pradesh", district: "Palnadu", constituency: "Narasaraopet", area: "Narasaraopet Municipality" };
const NRT_RURAL = { ...NRT, area: "Narasaraopet Rural" };
const TENALI = { state: "Andhra Pradesh", district: "Guntur", constituency: "Tenali", area: "Tenali Municipality" };
const NONE = { state: null, district: null, constituency: null, area: null };

/** Raw get_area_breakdown() rows as PostgREST returns them (bigint may arrive as string). */
const raw = [
  { ...NRT, total_issues: "5", pending_issues: 3, critical_open: 1, resolved_issues: 2 },
  { ...NRT_RURAL, total_issues: 2, pending_issues: 2, critical_open: "2", resolved_issues: 0 },
  { ...TENALI, total_issues: 4, pending_issues: 1, critical_open: 0, resolved_issues: 3 },
  { ...NONE, total_issues: 1, pending_issues: 1, critical_open: 0, resolved_issues: 0 },
];

describe("area breakdown (G8)", () => {
  const rows = mapAreaBreakdownRows(raw);

  it("maps raw rows to numbers without changing location levels", () => {
    expect(rows[0]).toEqual({ ...NRT, total: 5, pending: 3, criticalOpen: 1, resolved: 2 });
    expect(rows[1].criticalOpen).toBe(2);
    expect(rows[3].state).toBeNull();
  });

  it("unfiltered sum reconciles with get_area_overview/get_insight_metrics for the same caller", () => {
    // Same numbers get_area_overview() would return for these reports:
    // total 12, resolved 5, pending 7; get_insight_metrics().critical_unresolved = 3.
    const totals = sumAreaBreakdown(rows);
    expect(totals).toEqual({ totalIssues: 12, resolved: 5, pending: 7, criticalOpen: 3, resolutionRate: resolutionRate(5, 12) });
    expect(totals.pending).toBe(totals.totalIssues - totals.resolved);
  });

  it("filters by exact level match and sums only the matching places", () => {
    expect(sumAreaBreakdown(rowsMatchingFilter(rows, { state: "Andhra Pradesh", district: "Palnadu" }))).toEqual({
      totalIssues: 7,
      resolved: 2,
      pending: 5,
      criticalOpen: 3,
      resolutionRate: 29,
    });
    expect(sumAreaBreakdown(rowsMatchingFilter(rows, { ...NRT })).totalIssues).toBe(5);
    expect(sumAreaBreakdown(rowsMatchingFilter(rows, { state: "Telangana" }))).toEqual({
      totalIssues: 0,
      resolved: 0,
      pending: 0,
      criticalOpen: 0,
      resolutionRate: 0,
    });
  });

  it("is not capped: totals above 200 are summed exactly (the old explorer used a 200-row feed)", () => {
    const big = mapAreaBreakdownRows([{ ...NRT, total_issues: 1234, pending_issues: 1000, critical_open: 17, resolved_issues: 234 }]);
    expect(sumAreaBreakdown(rowsMatchingFilter(big, { state: NRT.state })).totalIssues).toBe(1234);
  });

  it("offers only places present in the caller's rows, sorted, never null", () => {
    expect(distinctLevelValues(rows, "state", {})).toEqual(["Andhra Pradesh"]);
    expect(distinctLevelValues(rows, "district", { state: "Andhra Pradesh" })).toEqual(["Guntur", "Palnadu"]);
    expect(distinctLevelValues(rows, "area", { state: "Andhra Pradesh", district: "Palnadu", constituency: "Narasaraopet" })).toEqual([
      "Narasaraopet Municipality",
      "Narasaraopet Rural",
    ]);
  });

  it("resolution rate uses the same rounding as get_area_overview()", () => {
    expect(resolutionRate(0, 0)).toBe(0);
    expect(resolutionRate(1, 3)).toBe(33);
    expect(resolutionRate(2, 3)).toBe(67);
  });
});

describe("compareCategoryPeriods (G8 previous-period category trends)", () => {
  it("previous = count(last 2N days) − count(last N days)", () => {
    const current = [
      { category: "road", report_count: 5 },
      { category: "garbage", report_count: "2" },
    ];
    const doubled = [
      { category: "road", report_count: 8 },
      { category: "garbage", report_count: 2 },
      { category: "drainage", report_count: 4 },
    ];
    const result = compareCategoryPeriods(current, doubled);
    const byCat = Object.fromEntries(result.map((r) => [r.category, r]));
    expect(byCat.ROAD).toMatchObject({ current: 5, previous: 3 });
    expect(byCat.GARBAGE).toMatchObject({ current: 2, previous: 0 });
    // Only in the previous window: current 0, previous 4.
    expect(byCat.DRAINAGE).toMatchObject({ current: 0, previous: 4 });
  });

  it("never reports a negative previous count (race between the two RPC calls)", () => {
    const result = compareCategoryPeriods([{ category: "road", report_count: 3 }], [{ category: "road", report_count: 2 }]);
    expect(result[0]).toMatchObject({ current: 3, previous: 0 });
  });

  it("returns nothing when both windows are empty", () => {
    expect(compareCategoryPeriods([], [])).toEqual([]);
  });
});

describe("formatAvgResolutionDays (G8)", () => {
  it('shows "—" when there is nothing to average, never "0.0 days"', () => {
    expect(formatAvgResolutionDays(null)).toBe("—");
  });
  it("formats a real average to one decimal", () => {
    expect(formatAvgResolutionDays(0.04)).toBe("0.0 days");
    expect(formatAvgResolutionDays(3.25)).toBe("3.3 days");
  });
});
