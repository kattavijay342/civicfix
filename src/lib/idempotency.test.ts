import { describe, it, expect, afterEach } from "vitest";
import { beginIdempotentAction } from "@/lib/idempotency";
import {
  makeFakeClient as realMakeFakeClient,
  forceNextError,
  clearForcedErrors,
  type FakeDb,
} from "../../test/fake-supabase";

function db(): FakeDb {
  return { idempotency_keys: [] };
}

const UNIQUE = { idempotency_keys: ["user_id", "action", "client_key"] };

function makeFakeClient(store: FakeDb) {
  return realMakeFakeClient(store, UNIQUE);
}

describe("beginIdempotentAction", () => {
  it("runs normally and commits a result when no prior attempt exists", async () => {
    const client = makeFakeClient(db());
    const outcome = await beginIdempotentAction(client as never, "user-1", "create_report", "key-1");

    expect(outcome.kind).toBe("run");
    if (outcome.kind !== "run") throw new Error("expected run");
    await outcome.commit({ status: "success", reportId: "r-1" });
  });

  it("replays the committed result for a repeated (user, action, key)", async () => {
    const store = db();
    const client = makeFakeClient(store);

    const first = await beginIdempotentAction(client as never, "user-1", "create_report", "key-1");
    if (first.kind !== "run") throw new Error("expected run");
    await first.commit({ status: "success", reportId: "r-1" });

    const second = await beginIdempotentAction(client as never, "user-1", "create_report", "key-1");
    expect(second.kind).toBe("replay");
    if (second.kind !== "replay") throw new Error("expected replay");
    expect(second.result).toEqual({ status: "success", reportId: "r-1" });
  });

  it("reports in_progress for a concurrent request whose first attempt hasn't finished", async () => {
    const store = db();
    const client = makeFakeClient(store);

    const first = await beginIdempotentAction(client as never, "user-1", "create_report", "key-1");
    expect(first.kind).toBe("run");
    // Simulate the first request still being in-flight — no commit/release yet.

    const concurrent = await beginIdempotentAction(client as never, "user-1", "create_report", "key-1");
    expect(concurrent.kind).toBe("in_progress");
  });

  it("allows a real retry after release — a failed attempt does not permanently block the key", async () => {
    const store = db();
    const client = makeFakeClient(store);

    const first = await beginIdempotentAction(client as never, "user-1", "create_report", "key-1");
    if (first.kind !== "run") throw new Error("expected run");
    await first.release();

    const retry = await beginIdempotentAction(client as never, "user-1", "create_report", "key-1");
    expect(retry.kind).toBe("run");
  });

  it("scopes keys per user — the same client key from a different user is a different claim", async () => {
    const store = db();
    const client = makeFakeClient(store);

    const userA = await beginIdempotentAction(client as never, "user-a", "create_report", "shared-key");
    if (userA.kind !== "run") throw new Error("expected run");
    await userA.commit({ status: "success", reportId: "r-a" });

    const userB = await beginIdempotentAction(client as never, "user-b", "create_report", "shared-key");
    expect(userB.kind).toBe("run");
  });

  it("scopes keys per action — the same client key for a different action is a different claim", async () => {
    const store = db();
    const client = makeFakeClient(store);

    const createReport = await beginIdempotentAction(client as never, "user-1", "create_report", "shared-key");
    if (createReport.kind !== "run") throw new Error("expected run");
    await createReport.commit({ status: "success" });

    const createReminder = await beginIdempotentAction(client as never, "user-1", "create_reminder", "shared-key");
    expect(createReminder.kind).toBe("run");
  });

  it("runs normally with no dedupe when no client key is supplied", async () => {
    const client = makeFakeClient(db());
    const outcome = await beginIdempotentAction(client as never, "user-1", "create_report", null);
    expect(outcome.kind).toBe("run");
  });

  describe("fails open on infrastructure errors (never blocks writes as a false 'in_progress')", () => {
    afterEach(() => clearForcedErrors());

    // Regression test: found via the Phase 4 Step 10 E2E suite. Before this
    // fix, ANY insert error (e.g. the idempotency_keys table/migration not
    // having been applied yet) was treated as "another attempt already
    // claimed this key", and the fallback lookup query then ALSO failed,
    // landing on `in_progress` — which permanently blocked report creation
    // with "This report is already being submitted" for every single
    // request, never just a real duplicate.
    it("runs normally when the insert fails for a reason other than a unique-constraint conflict", async () => {
      const client = makeFakeClient(db());
      forceNextError("idempotency_keys", "relation \"idempotency_keys\" does not exist");

      const outcome = await beginIdempotentAction(client as never, "user-1", "create_report", "key-1");
      expect(outcome.kind).toBe("run");
    });
  });
});
