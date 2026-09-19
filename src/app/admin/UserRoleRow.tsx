"use client";

import { useActionState, useState } from "react";
import { Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { updateUserRole, type AdminActionState } from "@/lib/actions/admin";
import { stateNames, getDistricts, getConstituencies, getAreas } from "@/lib/jurisdiction";
import type { UserRole } from "@/lib/types";

const initialState: AdminActionState = {};

const fieldClass =
  "rounded-lg border border-border bg-white px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-civic-400";

interface Row {
  id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  department_id: string | null;
  gov_state: string | null;
  gov_district: string | null;
  gov_constituency: string | null;
  gov_area: string | null;
}

export function UserRoleRow({ profile, departments }: { profile: Row; departments: { id: string; name: string }[] }) {
  const action = updateUserRole.bind(null, profile.id);
  const [state, formAction, pending] = useActionState(action, initialState);
  const [role, setRole] = useState<UserRole>(profile.role);
  const [state_, setState_] = useState(profile.gov_state ?? "");
  const [district, setDistrict] = useState(profile.gov_district ?? "");
  const [constituency, setConstituency] = useState(profile.gov_constituency ?? "");

  const needsJurisdiction = role === "government" || role === "department_incharge";

  return (
    <form action={formAction} className="grid grid-cols-1 gap-2 border-b border-border py-4 last:border-b-0 lg:grid-cols-[1.5fr_1fr_2fr_auto] lg:items-start lg:gap-3">
      <div>
        <p className="text-sm font-semibold text-foreground">{profile.full_name || "—"}</p>
        <p className="text-xs text-foreground-muted">{profile.email}</p>
      </div>

      <select
        name="role"
        value={role}
        onChange={(e) => setRole(e.target.value as UserRole)}
        className={fieldClass}
      >
        <option value="citizen">Citizen</option>
        <option value="government">Authorized Government User</option>
        <option value="department_incharge">Department In-charge</option>
        <option value="admin">Admin</option>
      </select>

      {needsJurisdiction ? (
        <div className="flex flex-wrap gap-1.5">
          {role === "department_incharge" && (
            <select name="departmentId" defaultValue={profile.department_id ?? ""} className={fieldClass} required>
              <option value="" disabled>
                Department
              </option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
          <select
            name="govState"
            value={state_}
            onChange={(e) => {
              setState_(e.target.value);
              setDistrict("");
              setConstituency("");
            }}
            className={fieldClass}
          >
            <option value="">Any state</option>
            {stateNames.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            name="govDistrict"
            value={district}
            disabled={!state_}
            onChange={(e) => {
              setDistrict(e.target.value);
              setConstituency("");
            }}
            className={fieldClass}
          >
            <option value="">Any district</option>
            {getDistricts(state_).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <select
            name="govConstituency"
            value={constituency}
            disabled={!district}
            onChange={(e) => setConstituency(e.target.value)}
            className={fieldClass}
          >
            <option value="">Any constituency</option>
            {getConstituencies(state_, district).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select name="govArea" defaultValue={profile.gov_area ?? ""} disabled={!constituency} className={fieldClass}>
            <option value="">Any area</option>
            {getAreas(state_, district, constituency).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <span className="text-xs text-foreground-muted">—</span>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-full bg-civic-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-civic-700 disabled:opacity-60"
        >
          {pending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
          Save
        </button>
        {state.error && <AlertCircle className="h-4 w-4 shrink-0 text-priority-critical" aria-label={state.error} />}
        {state.success && <CheckCircle2 className="h-4 w-4 shrink-0 text-civic-600" aria-hidden="true" />}
      </div>
      {state.error && <p className="col-span-full text-xs font-medium text-priority-critical">{state.error}</p>}
    </form>
  );
}
