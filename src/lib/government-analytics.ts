import { categoryFromDb } from "@/lib/db-enums";
import type { ProblemCategory } from "@/lib/types";

/**
 * G8 — pure Government Analytics shaping, kept free of Supabase so it is
 * directly unit-testable (src/lib/government-analytics.test.ts). Every
 * number here comes from an RLS-scoped, security-invoker SQL aggregate the
 * caller's own session already ran (src/lib/data/government.ts); nothing in
 * this file filters by jurisdiction or is a security boundary.
 */

/** One row of get_area_breakdown() (supabase/migrations/0018_g8_area_breakdown.sql).
 * A null level means the report's stored location has no value there (or no
 * stored location at all), never "all". */
export interface AreaBreakdownRow {
  state: string | null;
  district: string | null;
  constituency: string | null;
  area: string | null;
  total: number;
  pending: number;
  criticalOpen: number;
  resolved: number;
}

export interface AreaBreakdownRowRaw {
  state: string | null;
  district: string | null;
  constituency: string | null;
  area: string | null;
  total_issues: number | string;
  pending_issues: number | string;
  critical_open: number | string;
  resolved_issues: number | string;
}

export function mapAreaBreakdownRows(rows: AreaBreakdownRowRaw[]): AreaBreakdownRow[] {
  return rows.map((r) => ({
    state: r.state,
    district: r.district,
    constituency: r.constituency,
    area: r.area,
    total: Number(r.total_issues),
    pending: Number(r.pending_issues),
    criticalOpen: Number(r.critical_open),
    resolved: Number(r.resolved_issues),
  }));
}

export interface AreaFilter {
  state?: string;
  district?: string;
  constituency?: string;
  area?: string;
}

export interface AreaTotals {
  totalIssues: number;
  resolved: number;
  pending: number;
  criticalOpen: number;
  resolutionRate: number;
}

/** Same rounding as get_area_overview()'s resolution_rate (0007): round(resolved / total * 100). */
export function resolutionRate(resolved: number, total: number): number {
  return total === 0 ? 0 : Math.round((resolved / total) * 100);
}

/** Exact-match narrowing on each level the viewer selected (empty = any),
 * the same strict comparison report_in_my_jurisdiction uses. */
export function rowsMatchingFilter(rows: AreaBreakdownRow[], filter: AreaFilter): AreaBreakdownRow[] {
  return rows.filter(
    (r) =>
      (!filter.state || r.state === filter.state) &&
      (!filter.district || r.district === filter.district) &&
      (!filter.constituency || r.constituency === filter.constituency) &&
      (!filter.area || r.area === filter.area)
  );
}

export function sumAreaBreakdown(rows: AreaBreakdownRow[]): AreaTotals {
  const totalIssues = rows.reduce((s, r) => s + r.total, 0);
  const resolved = rows.reduce((s, r) => s + r.resolved, 0);
  return {
    totalIssues,
    resolved,
    pending: rows.reduce((s, r) => s + r.pending, 0),
    criticalOpen: rows.reduce((s, r) => s + r.criticalOpen, 0),
    resolutionRate: resolutionRate(resolved, totalIssues),
  };
}

/** Distinct, sorted non-null values at one level among rows matching the
 * parent levels — the explorer's dropdowns only ever offer places that
 * actually appear in the caller's own RLS-scoped data. */
export function distinctLevelValues(
  rows: AreaBreakdownRow[],
  level: "state" | "district" | "constituency" | "area",
  parent: AreaFilter
): string[] {
  const values = new Set<string>();
  for (const r of rowsMatchingFilter(rows, parent)) {
    const v = r[level];
    if (v) values.add(v);
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

export interface CategoryPeriodComparison {
  category: ProblemCategory;
  /** Reports created in the last `days` days. */
  current: number;
  /** Reports created in the `days` days before that. */
  previous: number;
}

export interface CategoryCountRow {
  category: string;
  report_count: number | string;
}

/**
 * Previous-period counts derived from two real calls of the existing
 * get_category_trends(p_days) (0013): previous = count(last 2N days) −
 * count(last N days). Both windows are open-ended at "now", so the
 * difference is exactly the [now−2N, now−N) window. The two RPCs run as
 * separate statements (a few ms apart), so a report created in between can
 * make the difference transiently off by one — clamped at 0 rather than ever
 * showing a negative count. Sorted by current count, then previous, then
 * category name (deterministic, and not a quality ranking).
 */
export function compareCategoryPeriods(currentRows: CategoryCountRow[], doubleWindowRows: CategoryCountRow[]): CategoryPeriodComparison[] {
  const current = new Map<string, number>();
  for (const r of currentRows) current.set(r.category, Number(r.report_count));
  const doubled = new Map<string, number>();
  for (const r of doubleWindowRows) doubled.set(r.category, Number(r.report_count));

  const categories = new Set([...current.keys(), ...doubled.keys()]);
  const out: CategoryPeriodComparison[] = [];
  for (const dbCategory of categories) {
    const cur = current.get(dbCategory) ?? 0;
    const prev = Math.max(0, (doubled.get(dbCategory) ?? 0) - cur);
    if (cur === 0 && prev === 0) continue;
    out.push({ category: categoryFromDb[dbCategory] ?? (dbCategory as ProblemCategory), current: cur, previous: prev });
  }
  return out.sort((a, b) => b.current - a.current || b.previous - a.previous || a.category.localeCompare(b.category));
}

/** "—" whenever there is no resolved issue to average — never "0.0 days". */
export function formatAvgResolutionDays(avgResolutionDays: number | null): string {
  return avgResolutionDays === null ? "—" : `${avgResolutionDays.toFixed(1)} days`;
}
