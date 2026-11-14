import { describe, it, expect, vi } from "vitest";
import {
  loadAreaBreakdown,
  loadAreaOverview,
  loadCategoryTrendsWithComparison,
  loadDepartmentPerformance,
  loadInsightMetrics,
} from "@/lib/data/government";

/**
 * G8 loaders. The fake stands in for the caller's RLS-scoped session client
 * and only models `.rpc()` results — it is not an authorization test. The
 * live boundary (jurisdiction isolation, anon, citizen/in-charge scope) is
 * proven by scripts/verify-g8-analytics-live.mjs.
 */
type RpcResult = { data: unknown; error: { message: string } | null };

function fakeRpc(results: Record<string, RpcResult | ((args?: Record<string, unknown>) => RpcResult)>) {
  const calls: Array<{ fn: string; args?: Record<string, unknown> }> = [];
  const client = {
    rpc(fn: string, args?: Record<string, unknown>) {
      calls.push({ fn, args });
      const entry = results[fn];
      const result: RpcResult = typeof entry === "function" ? entry(args) : entry ?? { data: null, error: { message: `no fake for ${fn}` } };
      const single = (): RpcResult => ({ data: Array.isArray(result.data) ? result.data[0] ?? null : result.data, error: result.error });
      return {
        maybeSingle: async () => single(),
        then: (resolve: (r: RpcResult) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls };
}

const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

const OVERVIEW_ROW = { total_issues: 12, resolved: 5, pending: 7, critical: 6, resolution_rate: 42, on_time_resolution_rate: 99 };
const INSIGHT_ROW = {
  top_category: "road",
  top_category_count: 4,
  total_reports: 12,
  critical_unresolved: 3,
  aging_count: 1,
  last_7_days: 2,
  prior_7_days: 1,
};

describe("loadAreaOverview — open-critical KPI (G8)", () => {
  it("uses get_insight_metrics().critical_unresolved, not get_area_overview().critical (which includes resolved)", async () => {
    const { client } = fakeRpc({ get_area_overview: { data: [OVERVIEW_ROW], error: null } });
    const overview = await loadAreaOverview(client, INSIGHT_ROW);
    expect(overview).toEqual({ totalIssues: 12, resolved: 5, pending: 7, critical: 3, resolutionRate: 42 });
  });

  it("open critical is null (shown as —) when get_insight_metrics failed — never the all-time count", async () => {
    const { client } = fakeRpc({ get_area_overview: { data: [OVERVIEW_ROW], error: null } });
    expect((await loadAreaOverview(client, null)).critical).toBeNull();
  });

  it("loadInsightMetrics returns null on RPC error", async () => {
    const spy = quiet();
    const { client } = fakeRpc({ get_insight_metrics: { data: null, error: { message: "boom" } } });
    expect(await loadInsightMetrics(client)).toBeNull();
    spy.mockRestore();
  });

  it("open critical never exceeds pending for consistent aggregates", async () => {
    const { client } = fakeRpc({ get_area_overview: { data: [OVERVIEW_ROW], error: null } });
    const overview = await loadAreaOverview(client, INSIGHT_ROW);
    expect(overview.critical!).toBeLessThanOrEqual(overview.pending);
  });
});

describe("loadDepartmentPerformance (G8)", () => {
  const rows = [
    { department_id: "d1", name: "Roads", total_issues: 4, resolved_issues: 2, pending_issues: 2, resolution_rate: 50, on_time_rate: 100, avg_resolution_days: 3.4 },
    { department_id: "d2", name: "Water", total_issues: 3, resolved_issues: 0, pending_issues: 3, resolution_rate: 0, on_time_rate: 0, avg_resolution_days: 0 },
  ];

  it("has no fabricated trend field at all", async () => {
    const { client } = fakeRpc({ get_department_performance: { data: rows, error: null } });
    const result = await loadDepartmentPerformance(client);
    for (const d of result) expect("trend" in d).toBe(false);
  });

  it("average resolution time is null (→ —) when a department has no resolved issues", async () => {
    const { client } = fakeRpc({ get_department_performance: { data: rows, error: null } });
    const [roads, water] = await loadDepartmentPerformance(client);
    expect(roads.avgResolutionDays).toBe(3.4);
    expect(water.avgResolutionDays).toBeNull();
  });

  it("never surfaces the hardcoded-SLA on-time rate", async () => {
    const { client } = fakeRpc({ get_department_performance: { data: rows, error: null } });
    for (const d of await loadDepartmentPerformance(client)) expect(d.onTimeRate).toBeNull();
  });
});

describe("loadCategoryTrendsWithComparison (G8)", () => {
  it("calls the existing get_category_trends for N and 2N days and derives the previous period", async () => {
    const { client, calls } = fakeRpc({
      get_category_trends: (args) =>
        args?.p_days === 30
          ? { data: [{ category: "road", report_count: 5 }], error: null }
          : { data: [{ category: "road", report_count: 7 }, { category: "sewage", report_count: 1 }], error: null },
    });
    const result = await loadCategoryTrendsWithComparison(client, 30);
    expect(calls.map((c) => c.args?.p_days).sort()).toEqual([30, 60]);
    expect(result.current).toEqual([{ category: "ROAD", count: 5 }]);
    expect(result.comparison).toEqual([
      { category: "ROAD", current: 5, previous: 2 },
      { category: "SEWAGE", current: 0, previous: 1 },
    ]);
  });

  it("keeps the current period but drops the comparison when the 2N-day call fails", async () => {
    const spy = quiet();
    const { client } = fakeRpc({
      get_category_trends: (args) =>
        args?.p_days === 30 ? { data: [{ category: "road", report_count: 5 }], error: null } : { data: null, error: { message: "boom" } },
    });
    const result = await loadCategoryTrendsWithComparison(client, 30);
    expect(result.current).toEqual([{ category: "ROAD", count: 5 }]);
    expect(result.comparison).toBeNull();
    spy.mockRestore();
  });

  it("is null (unknown), not empty, when the current-period call fails", async () => {
    const spy = quiet();
    const { client } = fakeRpc({ get_category_trends: { data: null, error: { message: "boom" } } });
    expect(await loadCategoryTrendsWithComparison(client, 30)).toEqual({ current: null, comparison: null });
    spy.mockRestore();
  });
});

describe("loadAreaBreakdown (G8)", () => {
  it("maps rows from get_area_breakdown()", async () => {
    const { client, calls } = fakeRpc({
      get_area_breakdown: {
        data: [{ state: "Andhra Pradesh", district: "Palnadu", constituency: "Narasaraopet", area: "Narasaraopet Municipality", total_issues: "3", pending_issues: 2, critical_open: 1, resolved_issues: 1 }],
        error: null,
      },
    });
    expect(await loadAreaBreakdown(client)).toEqual([
      { state: "Andhra Pradesh", district: "Palnadu", constituency: "Narasaraopet", area: "Narasaraopet Municipality", total: 3, pending: 2, criticalOpen: 1, resolved: 1 },
    ]);
    // No parameters are ever sent — nothing a caller could use to steer scope.
    expect(calls).toEqual([{ fn: "get_area_breakdown", args: undefined }]);
  });

  it("returns null (unavailable), never zero rows, when the RPC is missing (migration 0018 not applied)", async () => {
    const spy = quiet();
    const { client } = fakeRpc({ get_area_breakdown: { data: null, error: { message: "Could not find the function" } } });
    expect(await loadAreaBreakdown(client)).toBeNull();
    spy.mockRestore();
  });
});
