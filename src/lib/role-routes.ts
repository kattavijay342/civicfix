import type { UserRole } from "@/lib/types";

/** The only application roles CivicFix recognizes (mirrors the
 * profiles.role check constraint in 0001_init_schema.sql). */
export const APP_ROLES: readonly UserRole[] = ["citizen", "government", "department_incharge", "admin"];

/** Roles an admin may provision through "Create Authorized User". Admin
 * itself is deliberately absent. */
export const PROVISIONABLE_ROLES = ["government", "department_incharge"] as const;
export type ProvisionableRole = (typeof PROVISIONABLE_ROLES)[number];

export function isAppRole(value: unknown): value is UserRole {
  return typeof value === "string" && (APP_ROLES as readonly string[]).includes(value);
}

/** Where each role lands after sign-in. Single source of truth so auth
 * actions and any nav/redirect logic never drift apart. */
export function roleHomePath(role: UserRole): string {
  switch (role) {
    case "government":
      return "/government";
    case "department_incharge":
      return "/department";
    case "admin":
      return "/admin";
    case "citizen":
    default:
      return "/dashboard";
  }
}

/** Like roleHomePath, but for a role read from the database: anything that
 * isn't a recognized role yields null so callers refuse access instead of
 * guessing "citizen". */
export function resolveRoleHome(role: unknown): string | null {
  return isAppRole(role) ? roleHomePath(role) : null;
}
