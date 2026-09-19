import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/supabase/server";
import { getAllDepartments, getAllProfiles } from "@/lib/data/admin";
import { CreateDepartmentForm } from "./CreateDepartmentForm";
import { UserRoleRow } from "./UserRoleRow";

export const metadata: Metadata = {
  title: "Admin — CivicFix",
};

export default async function AdminPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/sign-in");
  if (session.profile.role !== "admin") redirect("/dashboard");

  const [departments, profiles] = await Promise.all([getAllDepartments(), getAllProfiles()]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
      <span className="text-sm font-semibold text-civic-700">Admin</span>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">System Configuration</h1>
      <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
        Manage departments and provision government / department in-charge / admin accounts. Public
        sign-up only ever creates citizen accounts — this is the only way those roles get assigned.
      </p>

      <section className="mt-10 rounded-2xl border border-border bg-white p-6">
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

      <section className="mt-10 rounded-2xl border border-border bg-white p-6">
        <h2 className="text-sm font-semibold text-foreground">Users &amp; Roles</h2>
        <p className="mt-1 text-xs text-foreground-muted">
          Government and department in-charge roles need a jurisdiction (or department + jurisdiction)
          to see any reports — see supabase/migrations/0002_rls_policies.sql.
        </p>
        <div className="mt-4">
          {/* Keyed on updated_at too: UserRoleRow seeds its dropdowns from
              `profile` via useState once on mount, so without this the row
              would keep showing pre-save values until a full reload. */}
          {profiles.map((profile) => (
            <UserRoleRow key={`${profile.id}-${profile.updated_at}`} profile={profile} departments={departments} />
          ))}
        </div>
      </section>
    </div>
  );
}
