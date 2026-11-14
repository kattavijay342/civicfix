import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Source-level checks on supabase/migrations/0020_ai_worker.sql (NOT applied
 * anywhere). The behavioral proof — real Postgres concurrency, CHECKs,
 * cascades and grants — is scripts/verify-ai-worker-local.mjs (CP3).
 */
const dir = path.resolve(__dirname, "../../supabase/migrations");
const sql = readFileSync(path.join(dir, "0020_ai_worker.sql"), "utf-8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .toLowerCase();

const FUNCTIONS = [
  "claim_due_ai_jobs(integer, integer, text)",
  "claim_due_incident_jobs(integer, integer, text)",
  "find_reports_missing_ai_job(timestamptz, integer)",
  "acquire_ai_worker_lease(text, uuid, integer)",
  "release_ai_worker_lease(text, uuid)",
];

/** The body of one `create or replace function public.<name>` statement. */
function fnBlock(name: string): string {
  const start = code.indexOf(`create or replace function public.${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = code.indexOf("$$;", start);
  return code.slice(start, end + 3);
}

describe("migration 0020 (AI-2 worker)", () => {
  it("is numbered right after 0019 and is the only 0020", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const i = files.indexOf("0020_ai_worker.sql");
    expect(files[i - 1]).toBe("0019_ai_analysis_jobs.sql");
    expect(files.filter((f) => f.startsWith("0020_"))).toEqual(["0020_ai_worker.sql"]);
  });

  it("adds notified_at to ai_analysis_jobs only", () => {
    expect(code).toContain("alter table public.ai_analysis_jobs\n  add column if not exists notified_at timestamptz;");
  });

  it("creates incident_confirmation_jobs with cascading FKs on both reports and the approved defaults/constraints", () => {
    expect(code).toContain("create table if not exists public.incident_confirmation_jobs");
    expect(code).toContain("report_id uuid primary key references public.reports (id) on delete cascade");
    expect(code).toContain("candidate_report_id uuid not null references public.reports (id) on delete cascade");
    expect(code).toContain("max_attempts integer not null default 3");
    expect(code).toContain("check (candidate_report_id <> report_id)");
    expect(code).toContain("check (match_score >= 0 and match_score <= 1)");
    expect(code).toContain("check (attempts >= 0 and attempts <= max_attempts)");
    expect(code).toContain("check (status <> 'processing' or locked_until is not null)");
    expect(code).toContain("check (status in ('pending', 'processing', 'completed', 'failed'))");
    expect(code).toMatch(/on public\.incident_confirmation_jobs \(next_attempt_at\)\s*where status = 'pending'/);
    expect(code).toMatch(/on public\.incident_confirmation_jobs \(locked_until\)\s*where status = 'processing'/);
  });

  it("creates ai_worker_lease with a holder/expiry pairing constraint", () => {
    expect(code).toContain("create table if not exists public.ai_worker_lease");
    expect(code).toContain("check ((holder is null) = (locked_until is null))");
  });

  it("new tables: RLS on, no policies, no anon/authenticated privileges", () => {
    for (const t of ["incident_confirmation_jobs", "ai_worker_lease"]) {
      expect(code).toContain(`alter table public.${t} enable row level security;`);
      expect(code).toContain(`revoke all on public.${t} from anon, authenticated;`);
    }
    expect(code).not.toContain("create policy");
  });

  it("every function is SECURITY INVOKER with search_path = public, and never SECURITY DEFINER", () => {
    expect(code).not.toContain("security definer");
    for (const name of ["claim_due_ai_jobs", "claim_due_incident_jobs", "find_reports_missing_ai_job", "acquire_ai_worker_lease", "release_ai_worker_lease"]) {
      const block = fnBlock(name);
      expect(block).toContain("security invoker");
      expect(block).toContain("set search_path = public");
    }
  });

  it("EXECUTE is revoked from public/anon/authenticated and granted to service_role only", () => {
    for (const fn of FUNCTIONS) {
      expect(code).toContain(`revoke all on function public.${fn} from public, anon, authenticated;`);
      expect(code).toContain(`grant execute on function public.${fn} to service_role;`);
    }
    const grants = [...code.matchAll(/grant [^;]* to ([a-z_]+);/g)].map((m) => m[1]);
    expect(new Set(grants)).toEqual(new Set(["service_role"]));
  });

  it("claims use the database clock and FOR UPDATE SKIP LOCKED, and never exceed max_attempts", () => {
    for (const name of ["claim_due_ai_jobs", "claim_due_incident_jobs"]) {
      const block = fnBlock(name);
      expect(block).toContain("for update of j skip locked");
      expect(block).toContain("j.next_attempt_at <= now()");
      expect(block).toContain("j.locked_until < now()");
      expect(block).toContain("j.attempts < j.max_attempts");
      expect(block).toContain("attempts = a.attempts + 1");
      expect(block).toContain("locked_until = now() + make_interval(secs => p_lease_seconds)");
    }
  });

  it("the lease is taken only when free or expired (database clock) and released only by its holder", () => {
    const acquire = fnBlock("acquire_ai_worker_lease");
    expect(acquire).toContain("on conflict (name) do update");
    expect(acquire).toContain("where l.locked_until is null or l.locked_until < now()");
    const release = fnBlock("release_ai_worker_lease");
    expect(release).toContain("where name = p_name and holder = p_holder");
  });

  it("missing-job lookup enforces the 48h ceiling, excludes E2E locations and analyzed/queued reports, and requires p_since", () => {
    const block = fnBlock("find_reports_missing_ai_job");
    expect(block).toContain("r.created_at >= greatest(p_since, now() - interval '48 hours')");
    expect(block).toContain("rl.area like 'e2e-%'");
    expect(block).toContain("from public.ai_analyses a where a.report_id = r.id");
    expect(block).toContain("from public.ai_analysis_jobs j where j.report_id = r.id");
    expect(block).toContain("if p_since is null then");
    expect(block).toContain("stable");
  });

  it("is additive: no drops, no data writes outside function bodies, no changes to existing tables or policies", () => {
    expect(code).not.toMatch(/\b(drop table|drop policy|drop function|alter policy|truncate)\b/);
    const altered = [...code.matchAll(/alter table public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(["ai_analysis_jobs", "incident_confirmation_jobs", "ai_worker_lease"]));
    // Outside function bodies there is no INSERT/UPDATE/DELETE at all (no backfill).
    const outside = code.replace(/\$\$[\s\S]*?\$\$/g, "");
    expect(outside).not.toMatch(/\b(insert into|update public\.|delete from)\b/);
    for (const t of ["reports", "report_assignments", "notifications", "incident_reports", "civic_incidents"]) {
      expect(code).not.toMatch(new RegExp(`alter table public\\.${t}\\b`));
      expect(outside).not.toMatch(new RegExp(`on public\\.${t}\\b`));
    }
    const triggers = [...code.matchAll(/create trigger \w+ before update on public\.(\w+)/g)].map((m) => m[1]);
    expect(triggers).toEqual(["incident_confirmation_jobs"]);
  });
});
