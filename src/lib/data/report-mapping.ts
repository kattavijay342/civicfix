import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { categoryFromDb, priorityFromDb, statusFromDb, categoryToDb, priorityToDb, statusToDb } from "@/lib/db-enums";
import type { CivicIssue, IssueListFilters, PagedIssues } from "@/lib/types";

export const ISSUE_LIST_SELECT = "id, title, category, status, priority, created_at, description";

/** Strips characters meaningful to PostgREST's `.or()` filter grammar
 * (`,()%*`) out of free-text search input before it's interpolated into a
 * filter string — not a SQL injection risk (PostgREST parses this against
 * known columns/operators, never as raw SQL), but an unescaped comma or
 * paren would break the filter's own syntax and 400 the request. */
function sanitizeSearchTerm(term: string): string {
  return term.replace(/[,()%*]/g, "").trim();
}

/**
 * Applies the shared status/priority/category/search filters (Phase 4 Step
 * 7) to a reports query. Kept generic over the builder type so it works
 * whether or not `.select(..., { count: "exact" })` was already chained.
 */
interface FilterableQuery<Q> {
  eq(column: string, value: unknown): Q;
  or(filters: string): Q;
  gte(column: string, value: unknown): Q;
  lt(column: string, value: unknown): Q;
}

/** "YYYY-MM-DD" only — anything else is silently ignored rather than
 * passed through to `.gte()`/`.lt()` as an invalid Postgres date literal. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function applyIssueFilters<Q extends FilterableQuery<Q>>(query: Q, filters?: IssueListFilters): Q {
  let q = query;
  if (filters?.status) q = q.eq("status", statusToDb[filters.status]);
  if (filters?.priority) q = q.eq("priority", priorityToDb[filters.priority]);
  if (filters?.category) q = q.eq("category", categoryToDb[filters.category]);
  if (filters?.search) {
    const term = sanitizeSearchTerm(filters.search);
    if (term) q = q.or(`title.ilike.%${term}%,description.ilike.%${term}%`);
  }
  if (filters?.dateFrom && DATE_ONLY_RE.test(filters.dateFrom)) {
    q = q.gte("created_at", `${filters.dateFrom}T00:00:00.000Z`);
  }
  if (filters?.dateTo && DATE_ONLY_RE.test(filters.dateTo)) {
    // Inclusive of the whole end day: strictly-less-than the day AFTER dateTo.
    const nextDay = new Date(`${filters.dateTo}T00:00:00.000Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    q = q.lt("created_at", nextDay.toISOString());
  }
  return q;
}

export function clampPage(page: number | undefined): number {
  return Number.isFinite(page) && (page as number) >= 1 ? Math.floor(page as number) : 1;
}

export const ISSUE_LIST_PAGE_SIZE = 20;

export async function toPagedIssues(
  readClient: SupabaseClient,
  admin: SupabaseClient,
  rows: Array<{
    id: string;
    title: string;
    category: string;
    status: string;
    priority: string | null;
    created_at: string;
    description: string;
  }>,
  totalCount: number,
  page: number,
  pageSize: number
): Promise<PagedIssues> {
  return {
    items: await mapReportsToIssues(readClient, admin, rows),
    page,
    pageSize,
    totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
  };
}

function daysBetween(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24)));
}

/**
 * Batch-loads locations/assignments/departments/media/follow-ups for a set
 * of report rows and maps them into the existing CivicIssue shape, so
 * Phase 1 components (IssueCard, JurisdictionExplorer, SortablePendingIssues,
 * MapPreview, ...) render real data unchanged.
 *
 * `readClient` is used for ordinary table reads (RLS applies — callers pass
 * whatever set of reports RLS already scoped for them). `admin` is used
 * only to sign private Storage URLs for media belonging to those same
 * already-authorized reports.
 */
export async function mapReportsToIssues(
  readClient: SupabaseClient,
  admin: SupabaseClient,
  reports: Array<{
    id: string;
    title: string;
    category: string;
    status: string;
    priority: string | null;
    created_at: string;
    description: string;
  }>
): Promise<CivicIssue[]> {
  if (reports.length === 0) return [];
  const ids = reports.map((r) => r.id);

  const [{ data: locations }, { data: assignments }, { data: departments }, { data: media }, { data: followUps }] =
    await Promise.all([
      readClient.from("report_locations").select("*").in("report_id", ids),
      readClient.from("report_assignments").select("report_id, department_id").in("report_id", ids),
      readClient.from("departments").select("id, name"),
      readClient.from("report_media").select("report_id, id, file_path").eq("kind", "evidence").in("report_id", ids),
      readClient
        .from("follow_ups")
        .select("report_id, follow_up_date, next_follow_up_date")
        .in("report_id", ids)
        .order("follow_up_date", { ascending: false }),
    ]);

  const locationByReport = new Map((locations ?? []).map((l) => [l.report_id, l]));
  const departmentNameById = new Map((departments ?? []).map((d) => [d.id, d.name]));
  const departmentByReport = new Map(
    (assignments ?? []).map((a) => [a.report_id, departmentNameById.get(a.department_id) ?? "Unassigned"])
  );

  const followUpCountByReport = new Map<string, number>();
  const lastFollowUpByReport = new Map<string, string>();
  const nextFollowUpByReport = new Map<string, string>();
  for (const f of followUps ?? []) {
    followUpCountByReport.set(f.report_id, (followUpCountByReport.get(f.report_id) ?? 0) + 1);
    if (!lastFollowUpByReport.has(f.report_id)) {
      lastFollowUpByReport.set(f.report_id, new Date(f.follow_up_date).toLocaleDateString());
    }
    if (f.next_follow_up_date && !nextFollowUpByReport.has(f.report_id)) {
      nextFollowUpByReport.set(f.report_id, new Date(f.next_follow_up_date).toLocaleDateString());
    }
  }

  const firstMediaByReport = new Map<string, string>();
  for (const m of media ?? []) {
    if (!firstMediaByReport.has(m.report_id)) firstMediaByReport.set(m.report_id, m.file_path);
  }
  const imageUrlByReport = new Map<string, string>();
  await Promise.all(
    [...firstMediaByReport.entries()].map(async ([reportId, path]) => {
      const { data } = await admin.storage.from("report-media").createSignedUrl(path, 900);
      if (data?.signedUrl) imageUrlByReport.set(reportId, data.signedUrl);
    })
  );

  return reports.map((r) => {
    const loc = locationByReport.get(r.id);
    return {
      id: r.id,
      title: r.title,
      category: categoryFromDb[r.category],
      location: loc
        ? {
            displayName: loc.display_name,
            state: loc.state ?? undefined,
            district: loc.district ?? undefined,
            constituency: loc.constituency ?? undefined,
            area: loc.area ?? loc.ward ?? undefined,
            landmark: loc.landmark ?? undefined,
            latitude: loc.latitude,
            longitude: loc.longitude,
            accuracy: loc.accuracy_meters ?? null,
            source: loc.location_source,
          }
        : { displayName: "Location not recorded", source: "manual" },
      priority: r.priority ? priorityFromDb[r.priority] : "LOW",
      status: statusFromDb[r.status],
      reportedDate: r.created_at,
      department: departmentByReport.get(r.id) ?? "Not yet routed",
      imageUrl: imageUrlByReport.get(r.id),
      // agingLabel() treats 0 as "Resolved", so an unresolved same-day
      // report must never compute to 0 — floor it at 1.
      daysPending: r.status === "resolved" ? 0 : Math.max(1, daysBetween(r.created_at)),
      followUps: followUpCountByReport.get(r.id) ?? 0,
      lastFollowUp: lastFollowUpByReport.get(r.id),
      nextFollowUp: nextFollowUpByReport.get(r.id),
      description: r.description,
    };
  });
}
