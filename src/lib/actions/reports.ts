"use server";

import { randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { analyzeReport, analyzeReportWithinBudget } from "@/lib/ai";
import { notifyAiAnalysisComplete, persistAnalysis } from "@/lib/ai-analysis-persistence";
import { enqueueAiJob } from "@/lib/ai-jobs";
import { findPossibleDuplicate } from "@/lib/duplicate-detection";
import { evaluateIncidentForReport } from "@/lib/incident-linking";
import { loadConfiguredDepartments, routeReport, type RouteReportResult } from "@/lib/actions/routing";
import { categoryToDb, categoryFromDb } from "@/lib/db-enums";
import { categoryLabels } from "@/lib/categories";
import { isValidReporterName, isValidIndianMobile, formatIndianMobile } from "@/lib/validators";
import { validateImageFile, validateImageBuffer } from "@/lib/upload-limits";
import { checkRateLimit, retryAfterMessage } from "@/lib/rate-limit";
import { beginIdempotentAction } from "@/lib/idempotency";
import { sanitizeCoordinates } from "@/lib/location/validation";
import { createNotification } from "@/lib/notifications/create";
import { notifyGovernmentOfNewReport } from "@/lib/notifications/new-report";
import { resolveReportJurisdiction } from "@/lib/report-jurisdiction";
import type { ConfiguredDepartment, JurisdictionLike } from "@/lib/routing";
import type { CivicLocation, ProblemCategory } from "@/lib/types";

export type CreateReportState =
  | { status: "idle" }
  | { status: "error"; error: string }
  | { status: "duplicate"; duplicateReportId: string; duplicateTitle: string }
  /** `aiQueued`: whether an AI analysis job was recorded for this report
   * (src/lib/ai-jobs.ts). Gemini never runs during submission; false means
   * the job could not be enqueued (the report itself is saved and routed). */
  | { status: "success"; reportId: string; aiQueued: boolean };

const DB_FAILURE_MESSAGE = "Unable to save the report. Please try again.";
const UPLOAD_FAILURE_MESSAGE = "Evidence upload failed. Please try again.";

/** One AI analysis inside a hard time budget — transient HTTP errors are
 * re-sent only by the SDK, network-level failures get one app retry, and
 * permanent errors none (see analyzeReportWithinBudget in src/lib/ai.ts for
 * the exact call/time limits). */
const analyzeWithRetry = analyzeReportWithinBudget;

/** Retry claims are scoped to a window longer than the page's maxDuration
 * (60s), so a claim left behind by a request the platform killed can never
 * block that report's retry for more than this window (idempotency_keys
 * rows are not swept automatically). */
const RETRY_CLAIM_WINDOW_MS = 120_000;

const AI_RETRY_IN_PROGRESS_MESSAGE = "AI analysis is already being retried for this report. Please wait a moment.";
const AI_UNAVAILABLE_MESSAGE = "AI analysis is temporarily unavailable.";

/** Deterministic category -> configured department -> authorized
 * in-charge routing for a saved report. Runs BEFORE (and independently of)
 * AI analysis, so a Gemini failure can never leave a report unrouted. A
 * routing problem never fails the already-saved report; the report stays
 * unrouted and retryAiAnalysis completes the routing on the next retry. */
async function routeSavedReport(
  admin: ReturnType<typeof createAdminClient>,
  input: {
    reportId: string;
    title: string;
    category: ProblemCategory;
    location: JurisdictionLike;
    departments?: ConfiguredDepartment[];
  }
): Promise<RouteReportResult | null> {
  try {
    return await routeReport(admin, {
      reportId: input.reportId,
      title: input.title,
      categoryLabel: categoryLabels[input.category],
      category: input.category,
      priority: null,
      location: input.location,
      departments: input.departments,
    });
  } catch (err) {
    console.error("Routing failed (non-fatal) for report", input.reportId, err);
    return null;
  }
}

function deriveTitle(description: string, category: ProblemCategory): string {
  const firstSentence = description.split(/[.!?\n]/)[0]?.trim();
  if (firstSentence && firstSentence.length >= 8) {
    return firstSentence.slice(0, 80);
  }
  return categoryLabels[category];
}

export async function createReport(
  _prevState: CreateReportState,
  formData: FormData
): Promise<CreateReportState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { status: "error", error: "You must be signed in to submit a report." };
  }

  const rateLimit = await checkRateLimit(`create_report:${user.id}`, 10, 60 * 60);
  if (!rateLimit.allowed) {
    return { status: "error", error: retryAfterMessage(rateLimit.retryAfterSeconds) };
  }

  const admin = createAdminClient();
  const clientKey = String(formData.get("idempotencyKey") ?? "").trim() || null;
  const idempotency = await beginIdempotentAction<CreateReportState>(admin, user.id, "create_report", clientKey);
  if (idempotency.kind === "replay") return idempotency.result;
  if (idempotency.kind === "in_progress") {
    return { status: "error", error: "This report is already being submitted. Please wait a moment." };
  }

  const result = await performCreateReport(user.id, supabase, admin, formData);
  // "duplicate" is a harmless read-only outcome (safe to replay); "error"
  // means nothing durable should be attributed to this key, so it's
  // released for a real retry instead of replaying a stale failure.
  if (result.status === "error") await idempotency.release();
  else await idempotency.commit(result);
  return result;
}

async function performCreateReport(
  userId: string,
  supabase: Awaited<ReturnType<typeof createClient>>,
  admin: ReturnType<typeof createAdminClient>,
  formData: FormData
): Promise<CreateReportState> {
  const user = { id: userId };
  const description = String(formData.get("description") ?? "").trim();
  const category = String(formData.get("category") ?? "") as ProblemCategory;
  const locationRaw = String(formData.get("location") ?? "");
  const reporterName = String(formData.get("reporterName") ?? "").trim();
  const reporterMobile = String(formData.get("reporterMobile") ?? "").trim();
  const confirmDuplicate = formData.get("confirmDuplicate") === "true";
  const photo = formData.get("photo");

  if (!description || description.length < 10) {
    return { status: "error", error: "Please describe the problem in at least 10 characters." };
  }
  if (description.length > 2000) {
    return { status: "error", error: "Description is too long (2000 characters max)." };
  }
  if (!categoryToDb[category]) {
    return { status: "error", error: "Please select a valid category." };
  }
  if (!isValidReporterName(reporterName)) {
    return { status: "error", error: "Enter your full name (2-60 characters)." };
  }
  if (!isValidIndianMobile(reporterMobile)) {
    return { status: "error", error: "Enter a valid 10-digit Indian mobile number." };
  }

  let location: CivicLocation;
  try {
    location = JSON.parse(locationRaw);
  } catch {
    return { status: "error", error: "Please select a location on the map." };
  }
  if (!location?.displayName) {
    return { status: "error", error: "Please select a location on the map." };
  }

  // Phase G2: the jurisdiction fields are what RLS (report_in_my_jurisdiction)
  // and government notification targeting match on, so they're resolved
  // against the configured hierarchy here instead of stored as the client
  // sent them. Everything downstream (duplicate detection, AI, routing,
  // incident linking) then sees the same canonical values that get stored.
  const resolvedJurisdiction = resolveReportJurisdiction(location);
  if (!resolvedJurisdiction.ok) {
    return { status: "error", error: resolvedJurisdiction.error };
  }
  const jurisdiction = resolvedJurisdiction.jurisdiction;
  location = { ...location, ...jurisdiction };

  // The optional photo is fully validated — size, declared type AND the
  // real file signature — BEFORE anything is written. An oversized or
  // spoofed file therefore leaves no report, location, notification,
  // assignment or storage object behind.
  const validatedPhoto = await readAndValidatePhoto(photo);
  if (validatedPhoto.status === "error") {
    return { status: "error", error: validatedPhoto.error };
  }

  // Keep the profile's own name/mobile in sync instead of duplicating it
  // per-report (Step "Reporter details").
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, mobile_number")
    .eq("id", user.id)
    .single();
  if (profile && (!profile.full_name || !profile.mobile_number)) {
    await admin
      .from("profiles")
      .update({
        full_name: profile.full_name ?? reporterName,
        mobile_number: profile.mobile_number ?? formatIndianMobile(reporterMobile),
      })
      .eq("id", user.id);
  }

  // Always computed (even when confirmDuplicate=true) so the "submit
  // anyway" path can still record accurate relation_type/reason metadata
  // below instead of a guessed default — this is a cheap deterministic DB
  // query, not an AI call, so it doesn't conflict with the cost-control
  // rule around unnecessary AI usage.
  let duplicateCandidate: Awaited<ReturnType<typeof findPossibleDuplicate>> = null;
  try {
    duplicateCandidate = await findPossibleDuplicate(admin, {
      category: categoryToDb[category],
      location,
      description,
    });
  } catch (err) {
    // Duplicate detection is a best-effort convenience — never block
    // submission if it fails, but still log so silent failures are visible.
    console.error("Duplicate detection failed", err);
  }

  if (!confirmDuplicate && duplicateCandidate && duplicateCandidate.score >= 0.55) {
    return {
      status: "duplicate",
      duplicateReportId: duplicateCandidate.reportId,
      duplicateTitle: duplicateCandidate.title,
    };
  }

  const title = deriveTitle(description, category);

  const { data: report, error: reportError } = await admin
    .from("reports")
    .insert({
      reporter_id: user.id,
      title,
      description,
      category: categoryToDb[category],
      status: "reported",
    })
    .select("id")
    .single();

  if (reportError || !report) {
    return { status: "error", error: DB_FAILURE_MESSAGE };
  }

  const reportId: string = report.id;

  // Phase 6B: never trust client-supplied coordinates as-is — the client
  // already validates (SmartLocationField), but this is the actual security
  // boundary. An invalid/out-of-range pair becomes null (never a fake
  // default like 0,0), and a claimed "gps" source without a valid pair is
  // downgraded to "manual" rather than asserting a GPS fix that isn't real.
  const sanitizedCoords = sanitizeCoordinates(location.latitude, location.longitude, location.accuracy);
  const { error: locationError } = await admin.from("report_locations").insert({
    report_id: reportId,
    display_name: location.displayName,
    state: jurisdiction.state,
    district: jurisdiction.district,
    constituency: jurisdiction.constituency,
    area: jurisdiction.area,
    village: location.village ?? null,
    ward: location.ward ?? null,
    municipality: location.municipality ?? null,
    landmark: location.landmark ?? null,
    address: location.address ?? null,
    latitude: sanitizedCoords?.latitude ?? null,
    longitude: sanitizedCoords?.longitude ?? null,
    location_source: sanitizedCoords ? (location.source ?? "manual") : "manual",
  });

  if (locationError) {
    await discardPartialReport(admin, reportId, null);
    return { status: "error", error: DB_FAILURE_MESSAGE };
  }

  // Best-effort only, deliberately a separate statement from the insert
  // above: accuracy_meters (migration 0010) is a real enhancement, not a
  // core field, so its write must never be able to block report creation —
  // including in the window before that migration has been applied to a
  // given environment, where this column doesn't exist yet.
  if (sanitizedCoords?.accuracy != null) {
    const { error: accuracyError } = await admin
      .from("report_locations")
      .update({ accuracy_meters: sanitizedCoords.accuracy })
      .eq("report_id", reportId);
    if (accuracyError) console.error("Failed to store GPS accuracy (non-fatal)", accuracyError);
  }

  if (confirmDuplicate) {
    const duplicateOf = String(formData.get("duplicateOf") ?? "");
    if (duplicateOf) {
      const matchesCandidate = duplicateCandidate?.reportId === duplicateOf;
      await admin.from("report_duplicate_flags").insert({
        report_id: reportId,
        possible_duplicate_of: duplicateOf,
        similarity_score: matchesCandidate ? duplicateCandidate!.score : 0.55,
        relation_type: matchesCandidate ? duplicateCandidate!.relationType : "related",
        reason: matchesCandidate ? duplicateCandidate!.reason : null,
      });
    }
  }

  if (validatedPhoto.status === "ok") {
    const { buffer, extension, mimeType } = validatedPhoto;
    const path = `${user.id}/${reportId}/${randomUUID()}.${extension}`;
    let uploaded = false;
    try {
      const { error: uploadError } = await admin.storage
        .from("report-media")
        .upload(path, buffer, { contentType: mimeType });
      if (uploadError) throw new Error(`storage upload failed: ${uploadError.message ?? "unknown"}`);
      uploaded = true;

      const { error: mediaError } = await admin.from("report_media").insert({
        report_id: reportId,
        uploaded_by: user.id,
        kind: "evidence",
        file_path: path,
        file_type: "image",
        mime_type: mimeType,
      });
      if (mediaError) throw new Error(`report_media insert failed: ${mediaError.code ?? "unknown"}`);
    } catch (err) {
      console.error("Photo upload failed; discarding the partially created report", reportId, err instanceof Error ? err.message : "unknown");
      await discardPartialReport(admin, reportId, uploaded ? path : null);
      return { status: "error", error: UPLOAD_FAILURE_MESSAGE };
    }
  }

  // Only now — the report, its location and its photo are all saved — is
  // the citizen told it was submitted. A failure above never notifies.
  await createNotification(admin, {
    recipientId: user.id,
    type: "report_created",
    title: "Report submitted",
    body: `"${title}" has been received.`,
    relatedReportId: reportId,
  });

  const departments = await loadConfiguredDepartments(admin);

  // Direct department routing — the report is fully saved, so route it now,
  // by its category, BEFORE the optional AI step. Gemini being down, rate
  // limited or slow can therefore never stop a report reaching its department.
  const routing = await routeSavedReport(admin, { reportId, title, category, location, departments });

  // AI enrichment is QUEUED, never run here: one ai_analysis_jobs row per
  // report (INSERT ... ON CONFLICT DO NOTHING), processed later by the AI
  // job worker (src/lib/ai-jobs.ts processAiJob). Gemini latency or outages
  // (currently ~60s 503s) can therefore never delay or fail the citizen's
  // submission, and AI never touches the department or lifecycle status set
  // above. An enqueue failure is reported as aiQueued=false — never claimed
  // as queued — and the owner's manual retry remains available.
  // Phase 1: no worker invokes processAiJob automatically yet (Phase 2).
  const aiQueue = await enqueueAiJob(admin, reportId);

  // Phase G2 — REPORT_CREATED for the government users whose jurisdiction
  // covers this report. AI runs later (queued above), so priority is not
  // known yet: null, never guessed.
  try {
    await notifyGovernmentOfNewReport(admin, {
      reportId,
      title,
      category: categoryToDb[category],
      categoryLabel: categoryLabels[category],
      jurisdiction,
      priority: null,
    });
  } catch (err) {
    console.error("Government new-report notification failed (non-fatal)", reportId, err);
  }

  // Civic Incident Intelligence — best-effort, non-fatal, exactly like
  // duplicate detection above. AI analysis is queued, so subcategory and
  // severity aren't known yet (null, exactly as when AI failed before); it
  // never affects the report that was already fully created above.
  try {
    await evaluateIncidentForReport(admin, {
      reportId,
      category,
      subcategory: null,
      description,
      location,
      createdAt: new Date().toISOString(),
      severity: null,
      departmentId: routing?.outcome === "routed" ? routing.departmentId : null,
      existingDuplicateCandidate: duplicateCandidate
        ? { reportId: duplicateCandidate.reportId, relationType: duplicateCandidate.relationType }
        : null,
    });
  } catch (err) {
    console.error("Incident linking failed for report", reportId, err);
  }

  return { status: "success", reportId, aiQueued: aiQueue !== "failed" };
}

type ValidatedPhoto =
  | { status: "none" }
  | { status: "error"; error: string }
  | { status: "ok"; buffer: Buffer; extension: string; mimeType: string };

/** Reads the optional photo and validates it completely — size, declared
 * type, and the actual file signature (magic bytes) — without writing
 * anything. A missing or empty file is simply "none". */
async function readAndValidatePhoto(photo: FormDataEntryValue | null): Promise<ValidatedPhoto> {
  if (!(photo instanceof File) || photo.size === 0) return { status: "none" };
  const validationError = validateImageFile(photo);
  if (validationError) return { status: "error", error: validationError };
  let buffer: Buffer;
  try {
    buffer = Buffer.from(await photo.arrayBuffer());
  } catch {
    return { status: "error", error: UPLOAD_FAILURE_MESSAGE };
  }
  const { error: bufferError, extension, mimeType } = validateImageBuffer(buffer);
  if (bufferError) return { status: "error", error: bufferError };
  return { status: "ok", buffer, extension, mimeType };
}

/** Compensating cleanup when report creation fails after the report row was
 * inserted: removes the uploaded storage object (if any), then every row
 * this action wrote, then the report itself (status_history from the insert
 * trigger cascades with it). Best-effort and logged — the caller still
 * returns the original error to the citizen. */
async function discardPartialReport(
  admin: ReturnType<typeof createAdminClient>,
  reportId: string,
  uploadedPath: string | null
): Promise<void> {
  if (uploadedPath) {
    const { error } = await admin.storage.from("report-media").remove([uploadedPath]);
    if (error) console.error("Cleanup: failed to remove uploaded photo", reportId);
  }
  for (const table of ["report_media", "report_duplicate_flags", "report_locations"] as const) {
    const { error } = await admin.from(table).delete().eq("report_id", reportId);
    if (error) console.error(`Cleanup: failed to delete ${table} rows`, reportId);
  }
  const { error } = await admin.from("reports").delete().eq("id", reportId);
  if (error) console.error("Cleanup: failed to delete the partially created report", reportId);
}

/** Statuses in which a missing AI analysis is still worth retrying: before
 * the department has acknowledged the report. AI is enrichment only, so a
 * report that has moved further along simply goes without it. */
const AI_RETRYABLE_STATUSES = new Set(["reported", "routed"]);

/** Manual retry when AI analysis failed at submission time (Step 21: no
 * indefinite auto-retry — this is the explicit user-triggered retry). It
 * first completes the report's routing if that never happened (idempotent —
 * an already-routed report is untouched), then only enriches the report
 * with AI; it never changes the department or the lifecycle status. */
export async function retryAiAnalysis(reportId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const rateLimit = await checkRateLimit(`retry_ai_analysis:${user.id}`, 5, 60 * 60);
  if (!rateLimit.allowed) return { error: retryAfterMessage(rateLimit.retryAfterSeconds) };

  const admin = createAdminClient();

  const { data: report } = await admin
    .from("reports")
    .select("id, reporter_id, title, description, category, status")
    .eq("id", reportId)
    .single();

  if (!report || report.reporter_id !== user.id) {
    return { error: "Report not found." };
  }

  const { data: location } = await admin
    .from("report_locations")
    .select("*")
    .eq("report_id", reportId)
    .single();

  if (!location) return { error: DB_FAILURE_MESSAGE };

  const category = categoryFromDb[report.category];

  const retryLocation: CivicLocation = {
    displayName: location.display_name,
    state: location.state,
    district: location.district,
    constituency: location.constituency,
    area: location.area,
    landmark: location.landmark,
    latitude: location.latitude,
    longitude: location.longitude,
    source: location.location_source,
  };

  // Recovery for a report whose routing never completed (a transient
  // routing write failure, or one submitted before routing stopped waiting
  // for AI). UNIQUE(report_assignments.report_id) makes this a no-op for an
  // already-routed report, so it never duplicates an assignment or
  // notification — and it does not depend on Gemini being up.
  if (report.status === "reported" || report.status === "ai_analyzed") {
    await routeSavedReport(admin, { reportId, title: report.title, category, location: retryLocation });
  }

  const { data: existingAnalysis } = await admin
    .from("ai_analyses")
    .select("report_id")
    .eq("report_id", reportId)
    .maybeSingle();
  if (existingAnalysis || !AI_RETRYABLE_STATUSES.has(report.status)) {
    return {};
  }

  // Claim this report's retry BEFORE calling Gemini, with the same
  // idempotency mechanism createReport uses: a double click or a second tab
  // gets "in progress" (or the finished result) and never makes its own
  // Gemini call. The key is per report, per RETRY_CLAIM_WINDOW_MS window.
  const claimKey = `${reportId}:${Math.floor(Date.now() / RETRY_CLAIM_WINDOW_MS)}`;
  const claim = await beginIdempotentAction<{ error?: string }>(admin, user.id, "retry_ai_analysis", claimKey);
  if (claim.kind === "replay") return claim.result;
  if (claim.kind === "in_progress") return { error: AI_RETRY_IN_PROGRESS_MESSAGE };

  let analysis: Awaited<ReturnType<typeof analyzeReport>>;
  try {
    const departments = await loadConfiguredDepartments(admin);
    analysis = await analyzeWithRetry({
      description: report.description,
      category,
      location: retryLocation,
      departmentNames: departments.map((d) => d.name),
    });
  } catch {
    await claim.release(); // nothing was written — a later retry may try again
    return { error: AI_UNAVAILABLE_MESSAGE };
  }

  const persisted = await persistAnalysis(admin, reportId, analysis);
  if (persisted === "already") {
    // Database backstop: another request (e.g. one that straddled a claim
    // window) saved this report's analysis first and owns its
    // notifications — this one sends none.
    await claim.commit({});
    return {};
  }
  if (persisted === "failed") {
    await claim.release(); // still no analysis — retryable
    return { error: AI_UNAVAILABLE_MESSAGE };
  }

  // Only the request that persisted the analysis gets here.
  try {
    await notifyAiAnalysisComplete(admin, {
      reportId,
      reporterId: report.reporter_id,
      title: report.title,
      analysis,
      location: retryLocation,
    });
  } catch (err) {
    console.error("Post-analysis notification failed (non-fatal)", reportId, err);
  }

  await claim.commit({});
  return {};
}
