/**
 * In-memory emulation of the AI-2 SQL functions in
 * supabase/migrations/0020_ai_worker.sql, for unit-testing the worker's
 * APPLICATION logic against test/fake-supabase.ts. It mirrors each
 * function's documented semantics (database-clock due/lease checks, claim
 * filters, attempts + 1, lease takeover only after expiry, release only by
 * the holder, 48h recovery ceiling, E2E exclusion). Handlers run
 * synchronously, so each call is atomic just as the real statements are.
 *
 * This is NOT proof of the real SQL — that is what
 * scripts/verify-ai-worker-local.mjs checks against local Postgres (CP3).
 */
import type { FakeDb, FakeClientExtras } from "./fake-supabase";

type Row = Record<string, unknown>;
const ms = (iso: unknown) => Date.parse(String(iso));

function claimer(db: FakeDb, table: string, now: () => number) {
  return (args: Record<string, unknown>) => {
    const limit = Number(args.p_limit);
    const leaseSeconds = Number(args.p_lease_seconds);
    if (!(limit >= 1 && limit <= 10) || !(leaseSeconds >= 30 && leaseSeconds <= 900)) {
      return { data: null, error: { message: "invalid arguments", code: "P0001" } };
    }
    const t = now();
    const due = (db[table] ?? [])
      .filter(
        (j) =>
          (j.attempts as number) < (j.max_attempts as number) &&
          ((j.status === "pending" && ms(j.next_attempt_at) <= t) ||
            (j.status === "processing" && j.locked_until != null && ms(j.locked_until) < t))
      )
      .sort((a, b) => ms(a.next_attempt_at) - ms(b.next_attempt_at) || String(a.report_id).localeCompare(String(b.report_id)))
      .slice(0, limit);
    for (const j of due) {
      j.status = "processing";
      j.attempts = (j.attempts as number) + 1;
      j.locked_until = new Date(t + leaseSeconds * 1000).toISOString();
      j.last_model = (args.p_model as string | null) ?? null;
    }
    return { data: due.map((j) => ({ ...j })), error: null };
  };
}

export interface FakeWorkerDbOptions {
  now: () => number;
  /** Simulated test-account lookup for auth.admin.getUserById. The special
   * value "__TEMP__" simulates a temporary auth API failure (HTTP 500). */
  emails?: Record<string, string>;
  /** Called on every getUserById (e.g. to advance a fake clock). */
  onUserLookup?: (id: string) => void;
}

/** RPC handlers + auth stub to pass as makeFakeClient's third argument. */
export function fakeAiWorkerExtras(db: FakeDb, opts: FakeWorkerDbOptions): FakeClientExtras & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const count = <T,>(name: string, fn: (a: Record<string, unknown>) => T) => (a: Record<string, unknown>) => {
    calls[name] = (calls[name] ?? 0) + 1;
    return fn(a);
  };
  db.ai_worker_lease ??= [];

  return {
    calls,
    rpc: {
      claim_due_ai_jobs: count("claim_due_ai_jobs", claimer(db, "ai_analysis_jobs", opts.now)),
      claim_due_incident_jobs: count("claim_due_incident_jobs", claimer(db, "incident_confirmation_jobs", opts.now)),
      acquire_ai_worker_lease: count("acquire_ai_worker_lease", (a) => {
        const t = opts.now();
        const name = String(a.p_name);
        let row = db.ai_worker_lease.find((l) => l.name === name);
        if (!row) {
          row = { name, holder: null, locked_until: null };
          db.ai_worker_lease.push(row);
        }
        if (row.locked_until != null && ms(row.locked_until) >= t) return { data: false, error: null };
        row.holder = a.p_holder;
        row.locked_until = new Date(t + Number(a.p_seconds) * 1000).toISOString();
        return { data: true, error: null };
      }),
      renew_ai_worker_lease: count("renew_ai_worker_lease", (a) => {
        const t = opts.now();
        const row = db.ai_worker_lease.find((l) => l.name === a.p_name && l.holder === a.p_holder);
        if (!row) return { data: null, error: null };
        row.locked_until = new Date(t + Number(a.p_seconds) * 1000).toISOString();
        return { data: Number(a.p_seconds) * 1000, error: null };
      }),
      release_ai_worker_lease: count("release_ai_worker_lease", (a) => {
        const row = db.ai_worker_lease.find((l) => l.name === a.p_name && l.holder === a.p_holder);
        if (!row) return { data: false, error: null };
        row.holder = null;
        row.locked_until = null;
        return { data: true, error: null };
      }),
      find_reports_missing_ai_job: count("find_reports_missing_ai_job", (a) => {
        if (a.p_since == null) return { data: null, error: { message: "p_since is required", code: "P0001" } };
        const since = Math.max(ms(a.p_since), opts.now() - 48 * 60 * 60 * 1000);
        const has = (table: string, id: unknown) => (db[table] ?? []).some((r: Row) => r.report_id === id);
        const rows = (db.reports ?? [])
          .filter(
            (r) =>
              ms(r.created_at) >= since &&
              !has("ai_analyses", r.id) &&
              !has("ai_analysis_jobs", r.id) &&
              !(db.report_locations ?? []).some((l) => l.report_id === r.id && String(l.area ?? "").startsWith("E2E-"))
          )
          .sort((x, y) => ms(x.created_at) - ms(y.created_at) || String(x.id).localeCompare(String(y.id)))
          .slice(0, Number(a.p_limit))
          .map((r) => ({ report_id: r.id, reporter_id: r.reporter_id, created_at: r.created_at }));
        return { data: rows, error: null };
      }),
    },
    auth: {
      admin: {
        getUserById: async (id: string) => {
          calls.getUserById = (calls.getUserById ?? 0) + 1;
          opts.onUserLookup?.(id);
          const email = opts.emails?.[id];
          if (email === "__TEMP__") {
            return { data: { user: null }, error: { message: "upstream unavailable", status: 500 } };
          }
          return email
            ? { data: { user: { id, email } }, error: null }
            : { data: { user: null }, error: { message: "User not found", status: 404 } };
        },
      },
    },
  };
}
