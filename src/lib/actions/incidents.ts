"use server";

import { revalidatePath } from "next/cache";
import { createClient, getSessionProfile } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type IncidentActionState = { error?: string; success?: boolean };

/**
 * Confirms the caller is authorized to act on this incident: authenticated,
 * NOT a citizen (citizens only ever get the safe aggregate note — spec
 * §13/§14), and able to see the incident at all — which the ordinary
 * session client already enforces via RLS (civic_incidents_select, see
 * supabase/migrations/0014_incident_intelligence.sql), the exact same
 * jurisdiction/assignment boundary as every other incident read. Never
 * trusts a client-supplied role/department id — role comes from the
 * caller's own profile row, visibility from their own RLS-scoped query.
 */
async function assertCanActOnIncident(incidentId: string): Promise<{ error?: string }> {
  const session = await getSessionProfile();
  if (!session) return { error: "You must be signed in." };
  if (session.profile.role === "citizen") return { error: "Not authorized to manage incidents." };

  const supabase = await createClient();
  const { data } = await supabase.from("civic_incidents").select("id").eq("id", incidentId).maybeSingle();
  if (!data) return { error: "Incident not found." };
  return {};
}

/**
 * Marks an incident as actively being worked on. Deliberately does NOT
 * touch any linked report's own status — the per-report workflow
 * (src/lib/status-transitions.ts, DepartmentActionsPanel) is untouched and
 * remains the actual source of truth for each report's own history (spec
 * §16).
 */
export async function markIncidentInProgress(
  incidentId: string,
  _prevState: IncidentActionState,
  _formData: FormData
): Promise<IncidentActionState> {
  void _prevState;
  void _formData;
  const auth = await assertCanActOnIncident(incidentId);
  if (auth.error) return auth;

  const admin = createAdminClient();
  const { error } = await admin
    .from("civic_incidents")
    .update({ status: "in_progress" })
    .eq("id", incidentId)
    .eq("status", "open");
  if (error) return { error: "Unable to update the incident. Please try again." };

  revalidatePath(`/government/incidents/${incidentId}`);
  revalidatePath("/government/incidents");
  return {};
}

/**
 * Marks the incident's underlying PHYSICAL problem as resolved by the
 * department — a separate, incident-level operational action. This is
 * intentionally the ONLY thing it does: it never cascades a "resolved"
 * status onto any linked report (spec §16 — "DO NOT blindly mark every
 * linked report as resolved... respect status history, citizen feedback,
 * reopened reports, resolution evidence"). Each report keeps going through
 * its own existing resolution workflow (submitResolution + citizen
 * feedback) untouched. If any linked report is later reopened, the
 * incident's DISPLAYED status automatically reflects that live
 * (src/lib/incident-status.ts) without this stored value needing to
 * change — no destructive/cascading write is ever required to "undo" this.
 */
export async function resolveIncident(
  incidentId: string,
  _prevState: IncidentActionState,
  _formData: FormData
): Promise<IncidentActionState> {
  void _prevState;
  void _formData;
  const auth = await assertCanActOnIncident(incidentId);
  if (auth.error) return auth;

  const admin = createAdminClient();
  const { error } = await admin
    .from("civic_incidents")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("id", incidentId);
  if (error) return { error: "Unable to resolve the incident. Please try again." };

  revalidatePath(`/government/incidents/${incidentId}`);
  revalidatePath("/government/incidents");
  return {};
}
