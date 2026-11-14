import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Source-level checks on supabase/migrations/0019_ai_analysis_jobs.sql —
 * the safety properties that must hold before it is ever applied (it has
 * NOT been applied anywhere; no local Supabase was available). The
 * behavioral proof needs a real Postgres (Phase 2 live verification).
 */
const dir = path.resolve(__dirname, "../../supabase/migrations");
const sql = readFileSync(path.join(dir, "0019_ai_analysis_jobs.sql"), "utf-8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .toLowerCase();

describe("migration 0019 (ai_analysis_jobs)", () => {
  it("is the only migration numbered 0019", () => {
    expect(readdirSync(dir).filter((f) => f.startsWith("0019_"))).toEqual(["0019_ai_analysis_jobs.sql"]);
  });

  it("creates one job per report, cascading with the report", () => {
    expect(code).toContain("create table if not exists public.ai_analysis_jobs");
    expect(code).toContain("report_id uuid primary key references public.reports (id) on delete cascade");
  });

  it("constrains status and the attempt counters", () => {
    expect(code).toContain("check (status in ('pending', 'processing', 'completed', 'failed'))");
    expect(code).toContain("attempts integer not null default 0");
    expect(code).toContain("max_attempts integer not null default 6");
    expect(code).toContain("check (attempts >= 0 and attempts <= max_attempts)");
    expect(code).toContain("check (status <> 'processing' or locked_until is not null)");
  });

  it("indexes due pending jobs and processing leases", () => {
    expect(code).toMatch(/on public\.ai_analysis_jobs \(next_attempt_at\)\s*where status = 'pending'/);
    expect(code).toMatch(/on public\.ai_analysis_jobs \(locked_until\)\s*where status = 'processing'/);
  });

  it("is service-role only: RLS on, no policies, no anon/authenticated privileges", () => {
    expect(code).toContain("alter table public.ai_analysis_jobs enable row level security");
    expect(code).toContain("revoke all on public.ai_analysis_jobs from anon, authenticated");
    expect(code).not.toContain("create policy");
    expect(code).not.toMatch(/\bgrant\b/);
  });

  it("is additive: touches no other table, policy or function and backfills nothing", () => {
    expect(code).not.toMatch(/\b(drop table|drop policy|drop function|alter policy|truncate|delete from|insert into|update public\.)/);
    const altered = [...code.matchAll(/alter table public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(["ai_analysis_jobs"]));
    const triggers = [...code.matchAll(/create trigger \w+ before update on public\.(\w+)/g)].map((m) => m[1]);
    expect(triggers).toEqual(["ai_analysis_jobs"]);
    expect(code).not.toMatch(/create or replace function/);
  });
});
