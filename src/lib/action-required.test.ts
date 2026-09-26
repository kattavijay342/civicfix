import { describe, it, expect } from "vitest";
import {
  classifyCandidate,
  compareActionItems,
  countActionQueues,
  isActionQueue,
  isInchargeEffective,
  istToday,
  queuesFor,
  reasonLabel,
  type ActionCandidate,
} from "@/lib/action-required";

// 2026-09-26 12:00 IST
const NOW = Date.parse("2026-09-26T06:30:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

const NRT = { gov_state: "Andhra Pradesh", gov_district: "Palnadu", gov_constituency: "Narasaraopet", gov_area: "Narasaraopet Municipality" };
const NRT_LOC = { state: "Andhra Pradesh", district: "Palnadu", constituency: "Narasaraopet", area: "Narasaraopet Municipality" };

function candidate(overrides: Partial<ActionCandidate> = {}): ActionCandidate {
  return {
    status: "acknowledged",
    priority: "low",
    severity: "low",
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    assignment: { departmentId: "dept-roads", inchargeId: "incharge-a", assignedAt: daysAgo(1) },
    inchargeEffective: true,
    reminders: [],
    followUps: [],
    ...overrides,
  };
}

const reasons = (c: Partial<ActionCandidate>) => classifyCandidate(candidate(c), NOW).reasons;

describe("G5 action-required classification", () => {
  it("a fresh, low-priority, effectively-assigned report needs no action (empty state)", () => {
    expect(reasons({})).toEqual([]);
  });

  it("never classifies a resolved report, whatever else is true", () => {
    expect(reasons({ status: "resolved", priority: "critical", createdAt: daysAgo(40), assignment: null })).toEqual([]);
  });

  describe("critical", () => {
    it("critical priority", () => expect(reasons({ priority: "critical" })).toContain("critical"));
    it("critical severity with lower priority", () => {
      const r = reasons({ severity: "critical", priority: "medium" });
      expect(r).toContain("critical");
      expect(r).not.toContain("high_priority");
    });
    it("high priority alone is high_priority, not critical", () => {
      expect(reasons({ priority: "high" })).toEqual(["high_priority"]);
    });
    it("unassessed (null) priority/severity is never treated as critical", () => {
      expect(reasons({ priority: null, severity: null })).toEqual([]);
    });
  });

  describe("pending > 7 days", () => {
    it("7 whole days is NOT over 7", () => expect(reasons({ createdAt: daysAgo(7.9) })).not.toContain("pending_over_7_days"));
    it("8 whole days is over 7, and the label states the real age", () => {
      const c = classifyCandidate(candidate({ createdAt: daysAgo(9.2) }), NOW);
      expect(c.reasons).toContain("pending_over_7_days");
      expect(c.ageDays).toBe(9);
      expect(reasonLabel("pending_over_7_days", { ageDays: c.ageDays, status: "routed", followUpState: c.followUpState })).toBe(
        "Pending for 9 days"
      );
    });
  });

  describe("follow-up due", () => {
    const reminder = (scheduledAt: string, status = "scheduled") => ({ status, scheduledAt, sentAt: null, createdAt: daysAgo(3) });

    it("scheduled reminder later today (IST) is due today", () => {
      const c = classifyCandidate(candidate({ reminders: [reminder("2026-09-26T15:00:00.000Z")] }), NOW); // 20:30 IST
      expect(c.reasons).toContain("follow_up_due");
      expect(c.followUpState).toMatchObject({ kind: "reminder_due", overdue: false });
    });
    it("scheduled reminder in the past (cron not yet run) is overdue", () => {
      const c = classifyCandidate(candidate({ reminders: [reminder(daysAgo(1))] }), NOW);
      expect(c.followUpState).toMatchObject({ kind: "reminder_due", overdue: true });
      expect(reasonLabel("follow_up_due", { ageDays: 1, status: "routed", followUpState: c.followUpState })).toBe("Follow-up overdue");
    });
    it("reminder tomorrow (IST) is scheduled, not due", () => {
      const c = classifyCandidate(candidate({ reminders: [reminder("2026-09-26T19:00:00.000Z")] }), NOW); // 00:30 IST on the 27th
      expect(c.reasons).not.toContain("follow_up_due");
      expect(c.followUpState.kind).toBe("reminder_scheduled");
    });
    it("sent / cancelled / failed reminders are never due", () => {
      for (const status of ["sent", "cancelled", "failed"]) {
        expect(reasons({ reminders: [reminder(daysAgo(1), status)] })).not.toContain("follow_up_due");
      }
    });
    it("latest follow-up's next date today is due; an older row's date is superseded", () => {
      expect(
        reasons({ followUps: [{ followUpDate: daysAgo(3), nextFollowUpDate: "2026-09-26", status: "pending" }] })
      ).toContain("follow_up_due");
      expect(
        reasons({
          followUps: [
            { followUpDate: daysAgo(5), nextFollowUpDate: "2026-09-20", status: "pending" },
            { followUpDate: daysAgo(1), nextFollowUpDate: "2026-10-05", status: "pending" },
          ],
        })
      ).not.toContain("follow_up_due");
    });
    it("uses IST, not UTC, for 'today'", () => {
      // 2026-09-26 20:00 UTC is already the 27th in IST.
      const late = Date.parse("2026-09-26T20:00:00.000Z");
      expect(istToday(late).date).toBe("2026-09-27");
      const c = classifyCandidate(
        candidate({ followUps: [{ followUpDate: daysAgo(3), nextFollowUpDate: "2026-09-27", status: "pending" }] }),
        late
      );
      expect(c.reasons).toContain("follow_up_due");
    });
  });

  it("reopened", () => {
    expect(reasons({ status: "reopened" })).toContain("reopened");
  });

  describe("routing pending / in-charge unavailable", () => {
    it("no assignment → routing pending, labelled by the real stored state", () => {
      const r = reasons({ status: "reported", assignment: null });
      expect(r).toEqual(["routing_pending"]);
      const fu = { kind: "none" } as const;
      expect(reasonLabel("routing_pending", { ageDays: 1, status: "reported", followUpState: fu })).toMatch(/awaiting AI analysis/);
      expect(reasonLabel("routing_pending", { ageDays: 1, status: "ai_analyzed", followUpState: fu })).toMatch(/no department matched/);
    });
    it("assignment without an in-charge → routing pending", () => {
      expect(reasons({ assignment: { departmentId: "d", inchargeId: null, assignedAt: daysAgo(1) } })).toEqual(["routing_pending"]);
    });
    it("stale in-charge → in-charge unavailable, counted in the routing queue", () => {
      const r = reasons({ inchargeEffective: false });
      expect(r).toEqual(["incharge_unavailable"]);
      expect(queuesFor(r)).toEqual(["routing_pending"]);
    });
  });

  it("a report matching several rules carries every reason", () => {
    expect(reasons({ priority: "critical", status: "reopened", createdAt: daysAgo(10), assignment: null })).toEqual([
      "critical",
      "reopened",
      "pending_over_7_days",
      "routing_pending",
    ]);
  });

  it("last activity is the newest stored timestamp", () => {
    const c = classifyCandidate(
      candidate({
        createdAt: daysAgo(10),
        updatedAt: daysAgo(6),
        assignment: { departmentId: "dept-roads", inchargeId: "incharge-a", assignedAt: daysAgo(9) },
        followUps: [{ followUpDate: daysAgo(2), nextFollowUpDate: null, status: "pending" }],
      }),
      NOW
    );
    expect(c.lastActivityAt).toBe(daysAgo(2));
  });
});

describe("G5 in-charge effectiveness (reuses G4 evaluateInchargeAccess)", () => {
  const base = {
    assignment: { incharge_id: "incharge-a", department_id: "dept-roads" },
    profile: { role: "department_incharge", department_id: "dept-roads" },
    inchargeRows: [{ department_id: "dept-roads", is_active: true, ...NRT }],
    location: NRT_LOC,
  };
  it("active, same department, covering scope → effective", () => expect(isInchargeEffective(base)).toBe(true));
  it("deactivated → not effective", () =>
    expect(isInchargeEffective({ ...base, inchargeRows: [{ ...base.inchargeRows[0], is_active: false }] })).toBe(false));
  it("moved to another department → not effective", () =>
    expect(isInchargeEffective({ ...base, profile: { role: "department_incharge", department_id: "dept-water" } })).toBe(false));
  it("demoted to citizen → not effective", () =>
    expect(isInchargeEffective({ ...base, profile: { role: "citizen", department_id: "dept-roads" } })).toBe(false));
  it("re-scoped to another jurisdiction → not effective", () =>
    expect(
      isInchargeEffective({ ...base, inchargeRows: [{ ...base.inchargeRows[0], gov_district: "Guntur", gov_constituency: "Tenali", gov_area: null }] })
    ).toBe(false));
  it("profile gone / no in-charge / no location → not effective (fail closed)", () => {
    expect(isInchargeEffective({ ...base, profile: null })).toBe(false);
    expect(isInchargeEffective({ ...base, assignment: { incharge_id: null, department_id: "dept-roads" } })).toBe(false);
    expect(isInchargeEffective({ ...base, location: null })).toBe(false);
  });
});

describe("G5 ordering", () => {
  const item = (reportId: string, rs: string[], createdAt: string) => ({ reportId, reasons: rs as never, createdAt });

  it("critical → high → follow-up due → reopened → oldest → id", () => {
    const items = [
      item("old-plain", ["pending_over_7_days"], daysAgo(30)),
      item("reopened", ["reopened"], daysAgo(2)),
      item("followup", ["follow_up_due"], daysAgo(2)),
      item("high", ["high_priority"], daysAgo(2)),
      item("critical-new", ["critical"], daysAgo(1)),
      item("critical-old", ["critical"], daysAgo(9)),
      item("newer-plain", ["routing_pending"], daysAgo(3)),
      item("b-tie", ["routing_pending"], daysAgo(3)),
    ];
    expect([...items].sort(compareActionItems).map((i) => i.reportId)).toEqual([
      "critical-old",
      "critical-new",
      "high",
      "followup",
      "reopened",
      "old-plain",
      "b-tie",
      "newer-plain",
    ]);
  });

  it("is deterministic regardless of input order", () => {
    const items = [item("a", ["critical"], daysAgo(1)), item("b", ["critical"], daysAgo(1)), item("c", ["reopened"], daysAgo(5))];
    const once = [...items].sort(compareActionItems).map((i) => i.reportId);
    const reversed = [...items].reverse().sort(compareActionItems).map((i) => i.reportId);
    expect(reversed).toEqual(once);
  });
});

describe("G5 queue counts", () => {
  it("counts honestly, including zeros, and each report once in the total", () => {
    const counts = countActionQueues([
      { reasons: ["critical", "reopened"], status: "reopened" },
      { reasons: ["incharge_unavailable"], status: "routed" },
      { reasons: ["routing_pending"], status: "reported" },
      { reasons: ["high_priority"], status: "routed" },
      { reasons: [], status: "acknowledged" },
    ]);
    expect(counts).toEqual({
      actionRequired: 4,
      critical: 1,
      pendingOver7Days: 0,
      followUpsDue: 0,
      reopened: 1,
      routingPending: 2,
      highPriority: 1,
      awaitingAcknowledgement: 2,
    });
  });

  it("empty input → all zeros", () => {
    expect(Object.values(countActionQueues([])).every((v) => v === 0)).toBe(true);
  });

  it("queue filter only accepts known queue names", () => {
    expect(isActionQueue("critical")).toBe(true);
    expect(isActionQueue("routing_pending")).toBe(true);
    expect(isActionQueue("all_jurisdictions")).toBe(false);
    expect(isActionQueue(undefined)).toBe(false);
  });
});
