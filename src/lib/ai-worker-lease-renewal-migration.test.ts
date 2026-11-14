import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Source-level checks on supabase/migrations/0021_ai_worker_lease_renewal.sql
 * (NOT applied anywhere). The behavioral proof — real Postgres compare-and-
 * set and now() semantics — needs local Postgres (CP3-style integration
 * checks, not run here per CP2.2 scope).
 */
const dir = path.resolve(__dirname, "../../supabase/migrations");
const sql = readFileSync(path.join(dir, "0021_ai_worker_lease_renewal.sql"), "utf-8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .toLowerCase();

function fnBlock(name: string): string {
  const start = code.indexOf(`create or replace function public.${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = code.indexOf("$$;", start);
  return code.slice(start, end + 3);
}

describe("migration 0021 (renew_ai_worker_lease)", () => {
  it("is numbered right after 0020 and is the only 0021", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const i = files.indexOf("0021_ai_worker_lease_renewal.sql");
    expect(files[i - 1]).toBe("0020_ai_worker.sql");
    expect(files.filter((f) => f.startsWith("0021_"))).toEqual(["0021_ai_worker_lease_renewal.sql"]);
  });

  it("defines renew_ai_worker_lease(text, uuid, integer) returning bigint", () => {
    expect(code).toContain("create or replace function public.renew_ai_worker_lease(p_name text, p_holder uuid, p_seconds integer)");
    expect(code).toContain("returns bigint");
  });

  it("is SECURITY INVOKER with search_path pinned, never SECURITY DEFINER", () => {
    const block = fnBlock("renew_ai_worker_lease");
    expect(block).toContain("security invoker");
    expect(block).toContain("set search_path = public");
    expect(code).not.toContain("security definer");
  });

  it("uses Postgres now() for the new expiry, never an app-supplied timestamp parameter", () => {
    const block = fnBlock("renew_ai_worker_lease");
    expect(block).toContain("locked_until = now() + make_interval(secs => p_seconds)");
    expect(block).not.toMatch(/p_locked_until|p_expires|p_now/);
  });

  it("updates only the row matching BOTH name and holder (compare-and-set)", () => {
    const block = fnBlock("renew_ai_worker_lease");
    expect(block).toContain("where name = p_name and holder = p_holder");
  });

  it("returns a duration computed from the same statement's now(), not a timestamp", () => {
    const block = fnBlock("renew_ai_worker_lease");
    expect(block).toContain("extract(epoch from (v_new_locked_until - now()))");
    expect(block).toContain("* 1000");
  });

  it("returns NULL when the update matched no row (wrong holder, or no lease at all)", () => {
    const block = fnBlock("renew_ai_worker_lease");
    expect(block).toContain("if v_new_locked_until is null then");
    expect(block).toMatch(/if v_new_locked_until is null then\s*return null;/);
  });

  it("EXECUTE is revoked from public/anon/authenticated and granted to service_role only", () => {
    expect(code).toContain("revoke all on function public.renew_ai_worker_lease(text, uuid, integer) from public, anon, authenticated;");
    expect(code).toContain("grant execute on function public.renew_ai_worker_lease(text, uuid, integer) to service_role;");
    const grants = [...code.matchAll(/grant [^;]* to ([a-z_]+);/g)].map((m) => m[1]);
    expect(new Set(grants)).toEqual(new Set(["service_role"]));
  });

  it("is additive: touches no table and does not modify 0019 or 0020's objects", () => {
    expect(code).not.toMatch(/\b(drop table|drop policy|drop function|alter table|alter policy|truncate|insert into|update public\.(?!ai_worker_lease)|delete from)\b/);
    // The only DML is the function's own single UPDATE on ai_worker_lease,
    // guarded by name+holder above — not asserted again here to avoid
    // duplicating the compare-and-set test's regex.
    const created = [...code.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);
    expect(created).toEqual(["renew_ai_worker_lease"]);
    expect(code).not.toContain("create table");
    expect(code).not.toContain("create policy");
    expect(code).not.toContain("create trigger");
  });
});
