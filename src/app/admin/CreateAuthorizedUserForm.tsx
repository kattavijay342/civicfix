"use client";

import { useActionState, useState } from "react";
import { Loader2, AlertCircle, CheckCircle2, UserPlus } from "lucide-react";
import { provisionAuthorizedUser, type AdminActionState } from "@/lib/actions/admin";
import { stateNames, getDistricts, getConstituencies, getAreas } from "@/lib/jurisdiction";
import type { ProvisionableRole } from "@/lib/role-routes";

const initialState: AdminActionState = {};

const fieldClass =
  "w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground outline-none focus:border-civic-400 disabled:bg-surface-muted";

/**
 * Admin-only provisioning of a NEW Authorized Government User or
 * Department In-charge. Offers exactly those two roles (never admin) and
 * has no password field — the person sets their own via the emailed
 * invitation. The server action re-validates every field.
 */
export function CreateAuthorizedUserForm({ departments }: { departments: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState(provisionAuthorizedUser, initialState);
  const [role, setRole] = useState<ProvisionableRole>("government");
  const [govState, setGovState] = useState("");
  const [district, setDistrict] = useState("");
  const [constituency, setConstituency] = useState("");

  return (
    <form action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Labeled label="Full name">
        <input name="fullName" required minLength={2} maxLength={60} autoComplete="off" className={fieldClass} />
      </Labeled>
      <Labeled label="Email">
        <input name="email" type="email" required autoComplete="off" className={fieldClass} />
      </Labeled>

      <Labeled label="Role">
        <select name="role" value={role} onChange={(e) => setRole(e.target.value as ProvisionableRole)} className={fieldClass}>
          <option value="government">Authorized Government User</option>
          <option value="department_incharge">Department In-charge</option>
        </select>
      </Labeled>

      {role === "department_incharge" ? (
        <Labeled label="Department">
          <select name="departmentId" defaultValue="" required className={fieldClass}>
            <option value="" disabled>
              Select department
            </option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Labeled>
      ) : (
        <div className="hidden sm:block" />
      )}

      <fieldset className="col-span-full grid grid-cols-1 gap-2 sm:grid-cols-4">
        <legend className="mb-1 text-xs font-medium text-foreground-muted">
          Jurisdiction — at least a state; narrower levels restrict what this user can see
        </legend>
        <select
          name="govState"
          value={govState}
          required
          aria-label="State"
          onChange={(e) => {
            setGovState(e.target.value);
            setDistrict("");
            setConstituency("");
          }}
          className={fieldClass}
        >
          <option value="">State</option>
          {stateNames.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          name="govDistrict"
          value={district}
          disabled={!govState}
          aria-label="District"
          onChange={(e) => {
            setDistrict(e.target.value);
            setConstituency("");
          }}
          className={fieldClass}
        >
          <option value="">Any district</option>
          {getDistricts(govState).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select
          name="govConstituency"
          value={constituency}
          disabled={!district}
          aria-label="Constituency"
          onChange={(e) => setConstituency(e.target.value)}
          className={fieldClass}
        >
          <option value="">Any constituency</option>
          {getConstituencies(govState, district).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select key={constituency} name="govArea" defaultValue="" disabled={!constituency} aria-label="Area" className={fieldClass}>
          <option value="">Any area</option>
          {getAreas(govState, district, constituency).map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </fieldset>

      <div className="col-span-full flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-full bg-civic-600 px-4 py-2 text-sm font-semibold text-white hover:bg-civic-700 disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <UserPlus className="h-4 w-4" aria-hidden="true" />}
          Create &amp; send invitation
        </button>
        <p className="text-xs text-foreground-muted">
          No password is set here — the person receives an email and chooses their own.
        </p>
      </div>

      {state.error && (
        <p role="alert" className="col-span-full flex items-center gap-1.5 text-sm font-medium text-priority-critical">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {state.error}
        </p>
      )}
      {state.success && state.message && (
        <p role="status" className="col-span-full flex items-center gap-1.5 text-sm font-medium text-civic-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          {state.message}
        </p>
      )}
    </form>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-foreground-muted">{label}</span>
      {children}
    </label>
  );
}
