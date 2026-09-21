/**
 * Minimal fake Supabase client for unit-testing CivicFix's own query logic
 * (claim loops, scoring, dedupe) against an in-memory table set — NOT a
 * re-implementation of Postgres/PostgREST, and never used as a substitute
 * for the real RLS-enforced authorization boundary (see vitest.config.ts's
 * top comment for why AUTH/AUTHORIZATION/DATABASE coverage instead lives in
 * scripts/verify-*.mjs against a real Supabase project).
 *
 * Supports exactly the query-builder surface CivicFix's server code
 * actually calls: eq/neq/gte/lte/in/limit/order, select, insert, update,
 * delete, maybeSingle, single, and plain awaiting the builder itself.
 */

export type FakeDb = Record<string, Array<Record<string, unknown>>>;

type Row = Record<string, unknown>;

/** Composite unique constraints per table, e.g. `{ idempotency_keys: ["user_id", "action", "client_key"] }`
 * — mirrors a real `unique (...)` constraint so a second insert with the
 * same combination is rejected instead of silently creating a duplicate
 * row (which the real Postgres schema would never allow either). */
export type UniqueConstraints = Record<string, string[]>;

export function makeFakeClient(db: FakeDb, uniqueConstraints: UniqueConstraints = {}) {
  return { from: (table: string) => new FakeQuery(db, table, uniqueConstraints[table]) };
}

class FakeQuery {
  private predicates: Array<(row: Row) => boolean> = [];
  private mode: "select" | "update" | "insert" | "delete" = "select";
  private payload: Row | null = null;
  private limitN: number | null = null;
  private orderBy: { column: string; ascending: boolean } | null = null;
  /** Set by a test to simulate a failure for this table's next write. */
  static forcedErrors = new Map<string, string>();

  constructor(
    private db: FakeDb,
    private table: string,
    private uniqueColumns?: string[]
  ) {
    if (!this.db[table]) this.db[table] = [];
  }

  /** Column projection / count options are accepted (to match real call
   * sites) but not modeled — this fake always returns full rows. */
  select(...args: unknown[]) {
    void args;
    return this;
  }
  insert(data: Row) {
    this.mode = "insert";
    this.payload = data;
    return this;
  }
  update(data: Row) {
    this.mode = "update";
    this.payload = data;
    return this;
  }
  delete() {
    this.mode = "delete";
    return this;
  }
  eq(column: string, value: unknown) {
    this.predicates.push((r) => r[column] === value);
    return this;
  }
  neq(column: string, value: unknown) {
    this.predicates.push((r) => r[column] !== value);
    return this;
  }
  gte(column: string, value: unknown) {
    this.predicates.push((r) => (r[column] as string | number) >= (value as string | number));
    return this;
  }
  lte(column: string, value: unknown) {
    this.predicates.push((r) => (r[column] as string | number) <= (value as string | number));
    return this;
  }
  in(column: string, values: unknown[]) {
    const set = new Set(values);
    this.predicates.push((r) => set.has(r[column]));
    return this;
  }
  order(column: string, opts?: { ascending?: boolean }) {
    this.orderBy = { column, ascending: opts?.ascending ?? true };
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }

  private rows(): Row[] {
    return this.db[this.table];
  }
  private matched(): Row[] {
    let result = this.rows().filter((r) => this.predicates.every((p) => p(r)));
    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      result = [...result].sort((a, b) => {
        const av = a[column] as string | number;
        const bv = b[column] as string | number;
        return ascending ? (av < bv ? -1 : av > bv ? 1 : 0) : av > bv ? -1 : av < bv ? 1 : 0;
      });
    }
    if (this.limitN != null) result = result.slice(0, this.limitN);
    return result;
  }

  private execute(): { data: Row[]; error: { message: string; code?: string } | null; count: number | null } {
    const forced = FakeQuery.forcedErrors.get(this.table);
    if (forced && this.mode !== "select") {
      return { data: [], error: { message: forced }, count: null };
    }

    if (this.mode === "insert") {
      if (this.uniqueColumns && this.payload) {
        const payload = this.payload;
        const conflict = this.rows().some((r) => this.uniqueColumns!.every((col) => r[col] === payload[col]));
        if (conflict) {
          return {
            data: [],
            // 23505 is Postgres's real unique_violation SQLSTATE code —
            // matched here because src/lib/idempotency.ts branches on it.
            error: {
              message: `duplicate key value violates unique constraint on ${this.table}(${this.uniqueColumns.join(", ")})`,
              code: "23505",
            },
            count: null,
          };
        }
      }
      const row: Row = { id: `${this.table}_${this.rows().length + 1}_${Math.random().toString(36).slice(2, 8)}`, ...this.payload };
      this.rows().push(row);
      return { data: [row], error: null, count: null };
    }
    if (this.mode === "update") {
      const matched = this.matched();
      for (const row of matched) Object.assign(row, this.payload);
      return { data: matched, error: null, count: null };
    }
    if (this.mode === "delete") {
      const matched = this.matched();
      const toDelete = new Set(matched);
      this.db[this.table] = this.rows().filter((r) => !toDelete.has(r));
      return { data: matched, error: null, count: null };
    }
    const matched = this.matched();
    return { data: matched, error: null, count: matched.length };
  }

  async maybeSingle() {
    const { data, error } = this.execute();
    return { data: data[0] ?? null, error };
  }
  async single() {
    const { data, error } = this.execute();
    if (error || !data[0]) return { data: null, error: error ?? { message: "no rows" } };
    return { data: data[0], error: null };
  }
  then<TResult1 = { data: unknown; error: unknown; count: number | null }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: unknown; count: number | null }) => TResult1 | PromiseLike<TResult1>)
      | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled as never);
  }
}

/** Test helper: force the next write (insert/update/delete) against `table`
 * to fail, until cleared. Simulates a transient DB error. */
export function forceNextError(table: string, message: string) {
  (FakeQuery as unknown as { forcedErrors: Map<string, string> }).forcedErrors.set(table, message);
}
export function clearForcedErrors() {
  (FakeQuery as unknown as { forcedErrors: Map<string, string> }).forcedErrors.clear();
}
