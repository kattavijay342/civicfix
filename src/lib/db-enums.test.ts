import { describe, it, expect } from "vitest";
import {
  categoryToDb,
  categoryFromDb,
  priorityToDb,
  priorityFromDb,
  statusToDb,
  statusFromDb,
  dbCategoryValues,
  dbPriorityValues,
  dbStatusValues,
} from "@/lib/db-enums";
import type { ProblemCategory, Priority, IssueStatus } from "@/lib/types";

describe("category <-> db mapping", () => {
  it("round-trips every ProblemCategory through the db and back", () => {
    for (const category of Object.keys(categoryToDb) as ProblemCategory[]) {
      const dbValue = categoryToDb[category];
      expect(dbCategoryValues).toContain(dbValue);
      expect(categoryFromDb[dbValue]).toBe(category);
    }
  });
});

describe("priority <-> db mapping", () => {
  it("round-trips every Priority through the db and back", () => {
    for (const priority of Object.keys(priorityToDb) as Priority[]) {
      const dbValue = priorityToDb[priority];
      expect(dbPriorityValues).toContain(dbValue);
      expect(priorityFromDb[dbValue]).toBe(priority);
    }
  });
});

describe("status <-> db mapping", () => {
  it("round-trips every IssueStatus through the db and back", () => {
    for (const status of Object.keys(statusToDb) as IssueStatus[]) {
      const dbValue = statusToDb[status];
      expect(dbStatusValues).toContain(dbValue);
      expect(statusFromDb[dbValue]).toBe(status);
    }
  });

  it("matches the exact lifecycle order used by the DB CHECK constraint", () => {
    // supabase/migrations/0001_init_schema.sql's `reports.status` CHECK
    // constraint order, widened by 0012_phase6d_citizen_trust.sql to also
    // accept 'reopened' — a drift here would mean the app and the DB
    // constraint have silently diverged on which values are valid.
    expect(dbStatusValues).toEqual([
      "reported",
      "ai_analyzed",
      "routed",
      "acknowledged",
      "in_progress",
      "resolved",
      "reopened",
    ]);
  });
});
