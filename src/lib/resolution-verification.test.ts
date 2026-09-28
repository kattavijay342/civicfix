import { describe, it, expect } from "vitest";
import {
  evaluateFeedbackAccess,
  evaluateFeedbackDecision,
  isFeedbackForCurrentResolution,
  parseFeedbackInput,
  STALE_RESOLUTION_MESSAGE,
} from "./resolution-verification";

const RESOLVED_AT = "2026-09-20T10:00:00.000Z";

describe("evaluateFeedbackAccess — only the reporting citizen", () => {
  it("allows the reporting citizen", () => {
    expect(evaluateFeedbackAccess({ userId: "c1", role: "citizen", reporterId: "c1" })).toEqual({ ok: true });
  });
  it.each([
    ["signed out", { userId: null, role: null, reporterId: "c1" }, "signed_out"],
    ["unknown report", { userId: "c1", role: "citizen", reporterId: null }, "not_found"],
    ["another citizen", { userId: "c2", role: "citizen", reporterId: "c1" }, "not_owner"],
    ["government", { userId: "g1", role: "government", reporterId: "c1" }, "not_citizen"],
    ["department in-charge", { userId: "i1", role: "department_incharge", reporterId: "c1" }, "not_citizen"],
    ["admin", { userId: "a1", role: "admin", reporterId: "c1" }, "not_citizen"],
    ["a non-citizen who filed the report themselves", { userId: "g1", role: "government", reporterId: "g1" }, "not_citizen"],
  ])("denies %s", (_name, input, reason) => {
    expect(evaluateFeedbackAccess(input)).toEqual({ ok: false, reason });
  });
});

describe("isFeedbackForCurrentResolution", () => {
  it("is false without feedback", () => {
    expect(isFeedbackForCurrentResolution(null, RESOLVED_AT)).toBe(false);
  });
  it("is true for feedback given after (or at) the current resolution", () => {
    expect(isFeedbackForCurrentResolution("2026-09-20T10:00:00.000Z", RESOLVED_AT)).toBe(true);
    expect(isFeedbackForCurrentResolution("2026-09-21T00:00:00Z", RESOLVED_AT)).toBe(true);
  });
  it("is false for feedback from an earlier resolution cycle", () => {
    expect(isFeedbackForCurrentResolution("2026-09-19T00:00:00Z", RESOLVED_AT)).toBe(false);
  });
  it("treats any feedback as current when there is no evidence row", () => {
    expect(isFeedbackForCurrentResolution("2026-09-19T00:00:00Z", null)).toBe(true);
  });
  it("compares instants, not strings (DB offset format vs ISO Z)", () => {
    expect(isFeedbackForCurrentResolution("2026-09-20T10:00:00.5+00:00", RESOLVED_AT)).toBe(true);
  });
});

describe("parseFeedbackInput", () => {
  it("accepts a verification without a comment", () => {
    expect(parseFeedbackInput("yes", "")).toEqual({ confirmed: true, comment: null });
  });
  it("requires a meaningful reason to reject", () => {
    expect(parseFeedbackInput("no", "")).toHaveProperty("error");
    expect(parseFeedbackInput("no", "   short   ")).toHaveProperty("error");
    expect(parseFeedbackInput("no", "Water still collects in the pothole.")).toEqual({
      confirmed: false,
      comment: "Water still collects in the pothole.",
    });
  });
  it("rejects anything but yes/no and over-long comments", () => {
    expect(parseFeedbackInput("maybe", "")).toHaveProperty("error");
    expect(parseFeedbackInput(null, "")).toHaveProperty("error");
    expect(parseFeedbackInput("yes", "x".repeat(1001))).toHaveProperty("error");
  });
});

describe("evaluateFeedbackDecision", () => {
  const base = { status: "RESOLVED" as const, resolvedAt: RESOLVED_AT, feedback: null, submittedResolvedAt: RESOLVED_AT };

  it("claims when resolved, no decision yet, and the page shows the current resolution", () => {
    expect(evaluateFeedbackDecision({ ...base, confirmed: true })).toEqual({ kind: "claim" });
    expect(evaluateFeedbackDecision({ ...base, confirmed: false })).toEqual({ kind: "claim" });
  });

  it("replays the same decision idempotently", () => {
    const verified = { confirmed: true, updatedAt: "2026-09-21T00:00:00Z" };
    expect(evaluateFeedbackDecision({ ...base, feedback: verified, confirmed: true })).toEqual({
      kind: "replay",
      reopened: false,
    });
    const rejected = { confirmed: false, updatedAt: "2026-09-21T00:00:00Z" };
    expect(evaluateFeedbackDecision({ ...base, status: "REOPENED", feedback: rejected, confirmed: false })).toEqual({
      kind: "replay",
      reopened: true,
    });
  });

  it("never lets an old page overwrite a newer decision", () => {
    const verified = { confirmed: true, updatedAt: "2026-09-21T00:00:00Z" };
    expect(evaluateFeedbackDecision({ ...base, feedback: verified, confirmed: false })).toMatchObject({ kind: "error" });
    const rejected = { confirmed: false, updatedAt: "2026-09-21T00:00:00Z" };
    expect(
      evaluateFeedbackDecision({ ...base, status: "REOPENED", feedback: rejected, confirmed: true })
    ).toMatchObject({ kind: "error" });
  });

  it("refuses any status other than resolved", () => {
    for (const status of ["REPORTED", "ROUTED", "ACKNOWLEDGED", "IN_PROGRESS", "REOPENED"] as const) {
      expect(evaluateFeedbackDecision({ ...base, status, confirmed: true })).toMatchObject({ kind: "error" });
    }
  });

  it("refuses a page that was showing a different (older) resolution", () => {
    expect(
      evaluateFeedbackDecision({ ...base, submittedResolvedAt: "2026-09-01T00:00:00Z", confirmed: true })
    ).toEqual({ kind: "error", message: STALE_RESOLUTION_MESSAGE });
    expect(evaluateFeedbackDecision({ ...base, submittedResolvedAt: null, confirmed: true })).toEqual({
      kind: "error",
      message: STALE_RESOLUTION_MESSAGE,
    });
  });

  it("allows a fresh decision when the only feedback is from an earlier cycle", () => {
    const old = { confirmed: false, updatedAt: "2026-09-10T00:00:00Z" };
    expect(evaluateFeedbackDecision({ ...base, feedback: old, confirmed: true })).toEqual({ kind: "claim" });
  });
});
