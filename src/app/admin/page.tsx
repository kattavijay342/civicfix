import type { Metadata } from "next";
import { requireRole } from "@/lib/supabase/server";
import { getAllDepartments, getAllProfiles } from "@/lib/data/admin";
import { CreateDepartmentForm } from "./CreateDepartmentForm";
import { CreateAuthorizedUserForm } from "./CreateAuthorizedUserForm";
import { UserRoleRow } from "./UserRoleRow";

export const metadata: Metadata = {
  title: "Admin — CivicFix",
};

const sections = [
  { id: "users", label: "Users & Access" },
  { id: "departments", label: "Departments" },
];

export default async function AdminPage() {
  const session = await requireRole(["admin"]);

  const [departments, profiles] = await Promise.all([getAllDepartments(), getAllProfiles()]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
      <span className="text-sm font-semibold text-civic-700">Admin</span>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">System Configuration</h1>
      <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
        Provision Authorized Government Users and Department In-charges, and manage departments. Public
        sign-up only ever creates citizen accounts — this is the only way other roles get assigned.
      </p>

      <nav aria-label="Admin sections" className="mt-6 flex flex-wrap gap-2">
        {sections.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="rounded-full border border-border bg-white px-3.5 py-1.5 text-xs font-medium text-foreground-muted hover:border-civic-300 hover:text-foreground"
          >
            {s.label}
          </a>
        ))}
      </nav>

      <section id="users" className="mt-8 scroll-mt-24 rounded-2xl border border-border bg-white p-6">
        <h2 className="text-sm font-semibold text-foreground">Users &amp; Access</h2>

        <div className="mt-4 rounded-xl border border-border bg-surface-muted/50 p-4">
          <h3 className="text-sm font-semibold text-foreground">Create Authorized User</h3>
          <p className="mt-1 mb-4 text-xs text-foreground-muted">
            For people you have verified yourself. CivicFix is not connected to any government identity
            system — this creates an authorized project account, not a verified official identity.
          </p>
          <CreateAuthorizedUserForm departments={departments} />
        </div>

        <h3 className="mt-8 text-sm font-semibold text-foreground">Existing users</h3>
        <p className="mt-1 text-xs text-foreground-muted">
          Government and department in-charge roles need a jurisdiction (and a department for in-charges);
          RLS scopes everything they can see to it — see supabase/migrations/0002_rls_policies.sql.
        </p>
        <div className="mt-4">
          {/* Keyed on updated_at too: UserRoleRow seeds its dropdowns from
              `profile` via useState once on mount, so without this the row
              would keep showing pre-save values until a full reload. */}
          {profiles.map((profile) => (
            <UserRoleRow
              key={`${profile.id}-${profile.updated_at}`}
              profile={profile}
              departments={departments}
              isSelf={profile.id === session.user.id}
            />
          ))}
        </div>
      </section>

      <section id="departments" className="mt-10 scroll-mt-24 rounded-2xl border border-border bg-white p-6">
        <h2 className="text-sm font-semibold text-foreground">Departments</h2>
        <ul className="mt-3 flex flex-wrap gap-2">
          {departments.map((d) => (
            <li key={d.id} className="rounded-full bg-civic-50 px-3 py-1 text-xs font-medium text-civic-800">
              {d.name}
            </li>
          ))}
        </ul>
        <div className="mt-4 border-t border-border pt-4">
          <CreateDepartmentForm />
        </div>
      </section>
    </div>
  );
}
