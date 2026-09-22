import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { mapReportsToIssues, ISSUE_LIST_SELECT } from "@/lib/data/report-mapping";
import { deriveIncidentDisplayStatus } from "@/lib/incident-status";
import { computeIncidentPriority, levelFromRank } from "@/lib/incident-priority";
import { categoryFromDb, priorityFromDb } from "@/lib/db-enums";
import type { CivicIncident, IncidentListFilters, IncidentReportLink, IssueStatus, ProblemCategory } from "@/lib/types";

/** Row shape returned by get_incident_list() (supabase/migrations/
 * 0014_incident_intelligence.sql). Declared here for the same reason as
 * every other RPC row type in this codebase (src/lib/data/government.ts) —
 * this project's Supabase clients aren't instantiated with a generated
 * `Database` type. */
interface IncidentListRow {
  id: string;
  incident_code: string;
  title: string;
  category: string;
  subcategory: string | null;
  severity: string;
  priority: string;
  status: string;
  department_id: string | null;
  department_name: string | null;
  latitude: number | null;
  longitude: number | null;
  confidence: number;
  detection_method: "rule_based" | "ai_confirmed";
  linked_report_count: number;
  affected_citizen_count: number;
  earliest_report_at: string;
  latest_report_at: string;
  any_reopened: boolean;
  any_unresolved: boolean;
  max_member_severity_rank: number | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

function ageInDays(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000)));
}

/**
 * Maps a raw RPC row into the UI-facing CivicIncident shape. Deliberately
 * recomputes `severity`/`priority` LIVE from the row's own real-time
 * aggregate columns (any_reopened, linked_report_count, earliest_report_at)
 * via the exact same deterministic formula used at link time
 * (src/lib/incident-priority.ts) instead of trusting the stored
 * civic_incidents.severity/priority snapshot directly — so a report that
 * got reopened, or a fourth report that just joined, is reflected the
 * instant this is read, never only at the next write (spec §8: "do not
 * store values that can easily become stale").
 */
function mapIncidentRow(row: IncidentListRow): CivicIncident {
  const { priority: livePriorityDb } = computeIncidentPriority({
    memberSeverities: [levelFromRank(row.max_member_severity_rank ?? 0)],
    affectedReportCount: row.linked_report_count,
    anyReopened: row.any_reopened,
    oldestReportAgeDays: ageInDays(row.earliest_report_at),
    stillUnresolved: row.any_unresolved,
  });

  const status: IssueStatus = deriveIncidentDisplayStatus(row.status as "open" | "in_progress" | "resolved", row.any_reopened);

  return {
    id: row.id,
    incidentCode: row.incident_code,
    title: row.title,
    category: categoryFromDb[row.category] ?? (row.category as ProblemCategory),
    subcategory: row.subcategory,
    severity: priorityFromDb[levelFromRank(row.max_member_severity_rank ?? 0)],
    priority: priorityFromDb[livePriorityDb],
    status,
    department: row.department_name,
    location: {
      displayName: row.title,
      latitude: row.latitude,
      longitude: row.longitude,
      source: "manual",
    },
    confidence: Number(row.confidence),
    detectionMethod: row.detection_method,
    linkedReportCount: Number(row.linked_report_count),
    affectedCitizenCount: Number(row.affected_citizen_count),
    earliestReportAt: row.earliest_report_at,
    latestReportAt: row.latest_report_at,
    anyUnresolved: row.any_unresolved,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function applyFilters(incidents: CivicIncident[], filters?: IncidentListFilters): CivicIncident[] {
  if (!filters) return incidents;
  return incidents.filter((incident) => {
    if (filters.status && incident.status !== filters.status) return false;
    if (filters.priority && incident.priority !== filters.priority) return false;
    if (filters.category && incident.category !== filters.category) return false;
    if (filters.department && incident.department !== filters.department) return false;
    if (filters.dateFrom && new Date(incident.createdAt) < new Date(`${filters.dateFrom}T00:00:00.000Z`)) return false;
    if (filters.dateTo && new Date(incident.createdAt) > new Date(`${filters.dateTo}T23:59:59.999Z`)) return false;
    return true;
  });
}

/**
 * Every incident visible to the caller — RLS (civic_incidents_select, see
 * the migration above) already restricts this to incidents with at least
 * one linked report the caller is authorized to see, so there is no
 * application-level jurisdiction/role filtering happening here beyond the
 * optional cosmetic filters (status/priority/category/department/date).
 *
 * Filtering runs in JS over this already-RLS-bounded, already-small result
 * set (a civic-scale deployment has dozens to low hundreds of incidents,
 * not millions) — see docs/ADVANCED_INCIDENT_INTELLIGENCE_REPORT.md's Known
 * Limitations for why this is an accepted tradeoff rather than pushing
 * every filter into the RPC's SQL.
 */
export async function getIncidentList(filters?: IncidentListFilters): Promise<CivicIncident[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_incident_list");
  if (error) {
    console.error("get_incident_list failed", error);
    return [];
  }
  const rows = (data ?? []) as unknown as IncidentListRow[];
  return applyFilters(rows.map(mapIncidentRow), filters).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export interface IncidentDetail {
  incident: CivicIncident;
  links: IncidentReportLink[];
}

/** A single incident plus its linked reports (rendered like ordinary
 * CivicIssue cards via the existing mapReportsToIssues, so incident detail
 * reuses IssueCard/StatusBadge/PriorityBadge unchanged). Returns null when
 * the incident doesn't exist OR the caller can't see any of its reports —
 * RLS makes those two cases indistinguishable, which is the correct,
 * conservative behavior (never leak "an incident with that id exists" to
 * an unauthorized caller). */
export async function getIncidentDetail(incidentId: string): Promise<IncidentDetail | null> {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data, error } = await supabase.rpc("get_incident_list", { p_incident_id: incidentId }).maybeSingle();
  if (error || !data) return null;

  const incident = mapIncidentRow(data as unknown as IncidentListRow);

  // Two plain queries + an in-memory join, same pattern as
  // mapReportsToIssues's own batch-loading below — avoids depending on
  // PostgREST's embedded-resource FK-name inference for a relationship
  // this codebase otherwise always resolves explicitly (see
  // src/lib/data/report-mapping.ts).
  const { data: linkRows } = await supabase
    .from("incident_reports")
    .select("report_id, relationship_type, confidence")
    .eq("incident_id", incidentId);
  if (!linkRows || linkRows.length === 0) return { incident, links: [] };

  const { data: reportRows } = await supabase
    .from("reports")
    .select(ISSUE_LIST_SELECT)
    .in("id", linkRows.map((l) => l.report_id));

  const issues = await mapReportsToIssues(supabase, admin, reportRows ?? []);
  const issueByReportId = new Map(issues.map((issue) => [issue.id, issue]));

  const links: IncidentReportLink[] = linkRows
    .map((l) => {
      const report = issueByReportId.get(l.report_id);
      if (!report) return null;
      return {
        report,
        relationshipType: l.relationship_type as IncidentReportLink["relationshipType"],
        confidence: Number(l.confidence),
      };
    })
    .filter((l): l is IncidentReportLink => !!l)
    .sort((a, b) => new Date(a.report.reportedDate).getTime() - new Date(b.report.reportedDate).getTime());

  return { incident, links };
}

export async function getIncidentDepartments(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("departments").select("id, name").order("name", { ascending: true });
  return data ?? [];
}

export interface CitizenIncidentNote {
  otherReportCount: number;
  category: ProblemCategory;
}

/**
 * The ONLY incident-related read a citizen-facing page needs (spec §13:
 * safe aggregate only). Backed by get_citizen_incident_note(), which
 * itself verifies server-side that the caller owns the report before
 * returning anything — this function never receives or exposes any other
 * citizen's identity. Returns null when the report isn't linked to any
 * incident (the common case) or the caller doesn't own it.
 */
export async function getCitizenIncidentNote(reportId: string): Promise<CitizenIncidentNote | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_citizen_incident_note", { p_report_id: reportId }).maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as { other_report_count: number; category: string };
  if (Number(row.other_report_count) <= 0) return null;
  return {
    otherReportCount: Number(row.other_report_count),
    category: categoryFromDb[row.category] ?? (row.category as ProblemCategory),
  };
}

