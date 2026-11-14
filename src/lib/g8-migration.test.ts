import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Source-level checks on supabase/migrations/0018_g8_area_breakdown.sql —
 * the security properties that must hold before it is ever applied. The
 * behavioral/RLS proof runs against a real project in
 * scripts/verify-g8-analytics-live.mjs.
 */
const dir = path.resolve(__dirname, "../../supabase/migrations");
const sql = readFileSync(path.join(dir, "0018_g8_area_breakdown.sql"), "utf-8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .toLowerCase();

describe("migration 0018 (G8 get_area_breakdown)", () => {
  it("defines get_area_breakdown() with no parameters, SECURITY INVOKER and STABLE", () => {
    expect(code).toMatch(/create or replace function public\.get_area_breakdown\(\)\s*returns table/);
    expect(code).toContain("security invoker");
    expect(code).toContain("stable");
    expect(code).not.toContain("security definer");
    expect(code).toContain("set search_path = public");
  });

  it("reads only reports + report_locations (both RLS-protected), with a LEFT JOIN so unlocated reports still count", () => {
    expect(code).toContain("from public.reports r");
    expect(code).toContain("left join public.report_locations rl on rl.report_id = r.id");
    expect(code).not.toMatch(/auth\.uid\(\)|set_config|set role|bypassrls/);
  });

  it("uses the same status/priority semantics as the existing aggregates", () => {
    expect(code).toContain("count(*) filter (where r.status <> 'resolved')");
    expect(code).toContain("count(*) filter (where r.priority = 'critical' and r.status <> 'resolved')");
    expect(code).toContain("count(*) filter (where r.status = 'resolved')");
  });

  it("orders by place, never by a count", () => {
    expect(code).toMatch(/order by rl\.state nulls last, rl\.district nulls last, rl\.constituency nulls last, rl\.area nulls last;/);
  });

  it("grants EXECUTE to authenticated only and revokes it from public and anon", () => {
    expect(code).toContain("revoke all on function public.get_area_breakdown() from public;");
    expect(code).toContain("revoke all on function public.get_area_breakdown() from anon;");
    expect(code).toContain("grant execute on function public.get_area_breakdown() to authenticated;");
    expect(code).not.toMatch(/grant [^;]* to (anon|public)/);
  });

  it("removes anon EXECUTE from every Government-dashboard analytics function", () => {
    for (const fn of [
      "get_area_overview()",
      "get_department_performance()",
      "get_insight_metrics()",
      "get_area_concentration()",
      "get_aging_buckets()",
      "get_resolution_quality()",
      "get_department_workload()",
      "get_department_trend(int)",
      "get_category_trends(int)",
    ]) {
      expect(code).toContain(`revoke execute on function public.${fn} from anon;`);
    }
  });

  it("does not redefine, drop or alter any existing function, table or policy", () => {
    const created = [...code.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);
    expect(created).toEqual(["get_area_breakdown"]);
    expect(code).not.toMatch(/\b(drop|alter|truncate|delete|update|insert)\b/);
    expect(code).not.toMatch(/create (table|policy|index|trigger)/);
  });

  it("is the next migration in sequence", () => {
    // 0018 directly follows 0017 and is the only 0018 — later migrations
    // (e.g. 0019) may follow it without breaking this check.
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const index = files.indexOf("0018_g8_area_breakdown.sql");
    expect(index).toBeGreaterThan(0);
    expect(files[index - 1]).toMatch(/^0017_/);
    expect(files.filter((f) => f.startsWith("0018_"))).toEqual(["0018_g8_area_breakdown.sql"]);
  });

  it("the whole migration sequence is well-named, unique and gap-free from 0001", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    const numbers = files.map((f) => Number(f.slice(0, 4)));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });
});
