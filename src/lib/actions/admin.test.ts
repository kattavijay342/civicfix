import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeClient, type FakeDb } from "../../../test/fake-supabase";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  retryAfterMessage: () => "Too many attempts.",
}));

// The caller's session (anon/RLS client): who is acting, and their stored role.
let caller: { id: string; role: string } | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: caller ? { id: caller.id } : null } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: caller ? { role: caller.role } : null }) }),
      }),
    }),
  })),
}));

// The service-role client: an in-memory DB plus Supabase's admin auth API.
let db: FakeDb;
const inviteUserByEmailMock = vi.fn();
const deleteUserMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    ...makeFakeClient(db),
    auth: { admin: { inviteUserByEmail: inviteUserByEmailMock, deleteUser: deleteUserMock } },
  }),
}));

const { provisionAuthorizedUser, updateUserRole } = await import("./admin");

const ADMIN = { id: "admin-1", role: "admin" };
const JURISDICTION = {
  govState: "Andhra Pradesh",
  govDistrict: "Palnadu",
  govConstituency: "Narasaraopet",
  govArea: "Narasaraopet Municipality",
};

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** Mirrors what the real invite does: an auth user plus the citizen profile
 * the handle_new_user trigger creates for it. */
function inviteCreatesUser(id: string) {
  inviteUserByEmailMock.mockImplementation(async () => {
    db.profiles.push({ id, role: "citizen", department_id: null });
    return { data: { user: { id } }, error: null };
  });
}

beforeEach(() => {
  caller = ADMIN;
  db = {
    profiles: [{ id: "admin-1", role: "admin" }],
    departments: [{ id: "dept-roads", name: "Roads & Infrastructure" }],
    department_incharges: [],
  };
  inviteUserByEmailMock.mockReset();
  deleteUserMock.mockReset();
});

describe("provisionAuthorizedUser", () => {
  it("provisions an Authorized Government User with role + jurisdiction, via an emailed invitation and no password", async () => {
    inviteCreatesUser("gov-new");

    const result = await provisionAuthorizedUser(
      {},
      form({ fullName: "Ramesh Kumar", email: "Ramesh@Example.com", role: "government", ...JURISDICTION })
    );

    expect(result.success).toBe(true);
    const [email, options] = inviteUserByEmailMock.mock.calls[0];
    expect(email).toBe("ramesh@example.com");
    expect(options.redirectTo).toMatch(/\/auth\/accept-invite$/);
    // No password anywhere, and no role in the (client-visible) metadata.
    expect(JSON.stringify(options)).not.toMatch(/password|"role"/i);
    expect(db.profiles.find((p) => p.id === "gov-new")).toMatchObject({
      role: "government",
      gov_state: "Andhra Pradesh",
      gov_area: "Narasaraopet Municipality",
      department_id: null,
    });
  });

  it("provisions a Department In-charge with department + jurisdiction and activates routing", async () => {
    inviteCreatesUser("incharge-new");

    const result = await provisionAuthorizedUser(
      {},
      form({
        fullName: "Suresh Kumar",
        email: "suresh@example.com",
        role: "department_incharge",
        departmentId: "dept-roads",
        ...JURISDICTION,
      })
    );

    expect(result.success).toBe(true);
    expect(db.profiles.find((p) => p.id === "incharge-new")).toMatchObject({
      role: "department_incharge",
      department_id: "dept-roads",
      gov_constituency: "Narasaraopet",
    });
    expect(db.department_incharges).toEqual([
      expect.objectContaining({ profile_id: "incharge-new", department_id: "dept-roads", is_active: true }),
    ]);
  });

  it.each(["admin", "citizen", ""])("refuses to provision role %j", async (role) => {
    const result = await provisionAuthorizedUser({}, form({ fullName: "X Person", email: "x@example.com", role, ...JURISDICTION }));

    expect(result.error).toBeDefined();
    expect(inviteUserByEmailMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a citizen", { id: "c-1", role: "citizen" }],
    ["a government user", { id: "g-1", role: "government" }],
    ["a department in-charge", { id: "d-1", role: "department_incharge" }],
    ["an anonymous caller", null],
  ])("is refused for %s", async (_label, who) => {
    caller = who;

    const result = await provisionAuthorizedUser(
      {},
      form({ fullName: "Ramesh Kumar", email: "ramesh@example.com", role: "government", ...JURISDICTION })
    );

    expect(result.error).toMatch(/Admin access required|signed in/);
    expect(inviteUserByEmailMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown department id without inviting anyone", async () => {
    const result = await provisionAuthorizedUser(
      {},
      form({ fullName: "Suresh Kumar", email: "s@example.com", role: "department_incharge", departmentId: "nope", ...JURISDICTION })
    );

    expect(result.error).toBe("Select a valid department.");
    expect(inviteUserByEmailMock).not.toHaveBeenCalled();
  });

  it("requires a jurisdiction", async () => {
    const result = await provisionAuthorizedUser({}, form({ fullName: "Ramesh Kumar", email: "r@example.com", role: "government" }));

    expect(result.error).toMatch(/jurisdiction/i);
    expect(inviteUserByEmailMock).not.toHaveBeenCalled();
  });

  it("points an existing account at the role editor instead of re-inviting it", async () => {
    inviteUserByEmailMock.mockResolvedValue({
      data: { user: null },
      error: { code: "email_exists", status: 422, message: "A user with this email address has already been registered" },
    });

    const result = await provisionAuthorizedUser(
      {},
      form({ fullName: "Ramesh Kumar", email: "ramesh@example.com", role: "government", ...JURISDICTION })
    );

    expect(result.error).toMatch(/already exists/);
  });

  it("withdraws the invitation if the role can't be saved, never leaving a half-provisioned account", async () => {
    // Invite "succeeds" but no profile row exists to scope.
    inviteUserByEmailMock.mockResolvedValue({ data: { user: { id: "ghost" } }, error: null });

    const result = await provisionAuthorizedUser(
      {},
      form({ fullName: "Ramesh Kumar", email: "ramesh@example.com", role: "government", ...JURISDICTION })
    );

    expect(result.error).toMatch(/withdrawn/);
    expect(deleteUserMock).toHaveBeenCalledWith("ghost");
  });
});

describe("updateUserRole", () => {
  beforeEach(() => {
    db.profiles.push({ id: "citizen-1", role: "citizen", department_id: null });
  });

  it("lets an admin scope an existing user as a government user", async () => {
    const result = await updateUserRole("citizen-1", {}, form({ role: "government", ...JURISDICTION }));

    expect(result.success).toBe(true);
    expect(db.profiles.find((p) => p.id === "citizen-1")).toMatchObject({ role: "government", gov_district: "Palnadu" });
  });

  it("is refused for non-admins", async () => {
    caller = { id: "citizen-1", role: "citizen" };

    const result = await updateUserRole("citizen-1", {}, form({ role: "admin" }));

    expect(result.error).toBe("Admin access required.");
    expect(db.profiles.find((p) => p.id === "citizen-1")?.role).toBe("citizen");
  });

  it("won't let an admin change their own role (no accidental lock-out)", async () => {
    const result = await updateUserRole("admin-1", {}, form({ role: "citizen" }));

    expect(result.error).toMatch(/your own role/);
    expect(db.profiles.find((p) => p.id === "admin-1")?.role).toBe("admin");
  });

  it("deactivates department routing when an in-charge is moved to another role", async () => {
    db.department_incharges.push({ id: "di-1", profile_id: "citizen-1", department_id: "dept-roads", is_active: true });

    await updateUserRole("citizen-1", {}, form({ role: "government", ...JURISDICTION }));

    expect(db.department_incharges[0].is_active).toBe(false);
  });
});
