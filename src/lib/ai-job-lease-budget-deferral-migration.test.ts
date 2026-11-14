import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Source-level checks on
 * supabase/migrations/0022_ai_job_lease_budget_deferral.sql (NOT applied
 * anywhere). The behavioral proof — real Postgres ALTER TABLE/CHECK
 * semantics — needs local Postgres (a future CP3-style integration pass),
 * not run here per the CP2.3 read-only/local-only scope.
 */
const dir = path.resolve(__dirname, "../../supabase/migrations");
const sql = readFileSync(path.join(dir, "0022_ai_job_lease_budget_deferral.sql"), "utf-8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .toLowerCase();

describe("migration 0022 (lease_budget_deferrals)", () => {
  it("is numbered right after 0021 and is the only 0022", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const i = files.indexOf("0022_ai_job_lease_budget_deferral.sql");
    expect(files[i - 1]).toBe("0021_ai_worker_lease_renewal.sql");
    expect(files.filter((f) => f.startsWith("0022_"))).toEqual(["0022_ai_job_lease_budget_deferral.sql"]);
  });

  it("adds lease_budget_deferrals to both job tables with a default of 0", () => {
    for (const t of ["ai_analysis_jobs", "incident_confirmation_jobs"]) {
      expect(code).toContain(`alter table public.${t}\n  add column if not exists lease_budget_deferrals integer not null default 0;`);
    }
  });

  it("bounds the new column on both tables with a looser-than-app-policy CHECK", () => {
    expect(code).toContain("check (lease_budget_deferrals >= 0 and lease_budget_deferrals <= 50)");
    expect(code).toMatch(/constraint ai_analysis_jobs_lease_budget_deferrals_range/);
    expect(code).toMatch(/constraint incident_confirmation_jobs_lease_budget_deferrals_range/);
  });

  it("is additive: no drops, no table creation, no function changes, no backfill, no existing-table rewrites beyond the two ALTERs", () => {
    expect(code).not.toMatch(/\b(drop table|drop policy|drop function|alter policy|truncate|insert into|delete from)\b/);
    expect(code).not.toContain("create table");
    expect(code).not.toContain("create or replace function");
    expect(code).not.toContain("create policy");
    const altered = [...code.matchAll(/alter table public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(["ai_analysis_jobs", "incident_confirmation_jobs"]));
    // Only ADD COLUMN / ADD CONSTRAINT statements, never an UPDATE on existing rows.
    expect(code).not.toMatch(/update public\./);
  });

  it("touches no RLS or grants — the existing lockdown on both tables already covers a new column", () => {
    expect(code).not.toContain("enable row level security");
    expect(code).not.toContain("revoke all");
    expect(code).not.toMatch(/\bgrant\b/);
  });
});
