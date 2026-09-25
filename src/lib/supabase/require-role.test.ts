import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

class RedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));

let sessionUser: { id: string } | null = null;
let storedRole: string | null = null;
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: sessionUser } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: storedRole ? { id: sessionUser?.id, role: storedRole } : null }) }),
      }),
    }),
  }),
}));

const { requireRole } = await import("./server");

async function attempt(allowed: Parameters<typeof requireRole>[0]): Promise<string> {
  try {
    await requireRole(allowed);
    return "allowed";
  } catch (e) {
    if (e instanceof RedirectSignal) return e.to;
    throw e;
  }
}

function signedInAs(role: string | null) {
  sessionUser = { id: "u-1" };
  storedRole = role;
}

beforeEach(() => {
  sessionUser = null;
  storedRole = null;
});

/** The allow-lists the protected pages actually pass (pinned below). */
const GOVERNMENT = ["government", "admin"] as const;
const DEPARTMENT = ["department_incharge", "admin"] as const;
const ADMIN = ["admin"] as const;

describe("requireRole", () => {
  it("sends unauthenticated users to sign-in", async () => {
    expect(await attempt(GOVERNMENT)).toBe("/sign-in");
    expect(await attempt(ADMIN)).toBe("/sign-in");
  });

  it.each([
    ["citizen", GOVERNMENT, "/dashboard"],
    ["citizen", ADMIN, "/dashboard"],
    ["citizen", DEPARTMENT, "/dashboard"],
    ["government", ADMIN, "/government"],
    ["government", DEPARTMENT, "/government"],
    ["department_incharge", ADMIN, "/department"],
    ["department_incharge", GOVERNMENT, "/department"],
  ] as const)("denies %s on a %j route (sent to own home %s)", async (role, allowed, home) => {
    signedInAs(role);
    expect(await attempt(allowed)).toBe(home);
  });

  it.each([
    ["government", GOVERNMENT],
    ["department_incharge", DEPARTMENT],
    ["admin", ADMIN],
    ["admin", GOVERNMENT],
    ["admin", DEPARTMENT],
  ] as const)("allows %s on a %j route", async (role, allowed) => {
    signedInAs(role);
    expect(await attempt(allowed)).toBe("allowed");
  });

  it("refuses a signed-in user whose profile row is missing", async () => {
    signedInAs(null);
    expect(await attempt(GOVERNMENT)).toBe("/sign-in");
  });

  it("refuses an unrecognized stored role with a safe error, never a dashboard", async () => {
    signedInAs("superuser");
    expect(await attempt(GOVERNMENT)).toBe("/sign-in?error=account_not_configured");
  });
});

describe("protected route allow-lists", () => {
  const root = path.resolve(__dirname, "../../app");
  const expected: Record<string, string> = {
    "government/page.tsx": `requireRole(["government", "admin"])`,
    "government/issues/page.tsx": `requireRole(["government", "admin"])`,
    "government/incidents/page.tsx": `requireRole(["government", "department_incharge", "admin"])`,
    "government/incidents/[id]/page.tsx": `requireRole(["government", "department_incharge", "admin"])`,
    "department/page.tsx": `requireRole(["department_incharge", "admin"])`,
    "admin/page.tsx": `requireRole(["admin"])`,
  };

  it.each(Object.entries(expected))("%s is guarded server-side with %s", (file, guard) => {
    const source = readFileSync(path.join(root, file), "utf8");
    expect(source).toContain(guard);
  });
});
