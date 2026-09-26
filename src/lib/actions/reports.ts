"use server";

import { randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { analyzeReport, AIUnavailableError } from "@/lib/ai";
import { findPossibleDuplicate } from "@/lib/duplicate-detection";
import { evaluateIncidentForReport } from "@/lib/incident-linking";
import { loadConfiguredDepartments, routeReport, type RouteReportResult } from "@/lib/actions/routing";
import { logStatusChange } from "@/lib/actions/status-history";
import { categoryToDb, categoryFromDb } from "@/lib/db-enums";
import { categoryLabels } from "@/lib/categories";
import { isValidReporterName, isValidIndianMobile, formatIndianMobile } from "@/lib/validators";
import { validateImageFile, validateImageBuffer } from "@/lib/upload-limits";
import { checkRateLimit, retryAfterMessage } from "@/lib/rate-limit";
import { beginIdempotentAction } from "@/lib/idempotency";
import { sanitizeCoordinates } from "@/lib/location/validation";
import { createNotification } from "@/lib/notifications/create";
import { findGovernmentUsersForJurisdiction } from "@/lib/notifications/targeting";
import { notifyGovernmentOfNewReport } from "@/lib/notifications/new-report";
import { resolveReportJurisdiction } from "@/lib/report-jurisdiction";
import type { ConfiguredDepartment, JurisdictionLike } from "@/lib/routing";
import type { CivicLocation, ProblemCategory } from "@/lib/types";

export type CreateReportState =
  | { status: "idle" }
  | { status: "error"; error: string }
  | { status: "duplicate"; duplicateReportId: string; duplicateTitle: string }
  | { status: "success"; reportId: string; aiFailed: boolean };

const DB_FAILURE_MESSAGE = "Unable to save the report. Please try again.";
const UPLOAD_FAILURE_MESSAGE = "Evidence upload failed. Please try again.";

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Up to 2 retries with short backoff for a transient AI failure. Never
 * retries validation errors — those come back from Gemini as a rejected
 * schema/JSON, which we treat as non-retryable here (see AIUnavailableError
 * usage in src/lib/ai.ts). */
async function analyzeWithRetry(input: Parameters<typeof analyzeReport>[0]) {
  const delays = [500, 1500];
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await analyzeReport(input);
    } catch (err) {
      lastError = err;
      if (attempt < delays.length) await sleep(delays[attempt]);
    }
  }
  throw lastError instanceof Error ? lastError : new AIUnavailableError("AI analysis failed.");
}

/** Shared shape for the `ai_analyses` insert used by both the initial
 * submission path and the manual retry path — keeps the flat legacy
 * columns and the Phase 6A `extended` JSONB blob (subcategory, split
 * severity/priority reasoning, evidence, action steps, complaint draft) in
 * exactly one place. */
function buildAiAnalysesRow(reportId: string, analysis: Awaited<ReturnType<typeof analyzeReport>>) {
  return {
    report_id: reportId,
    problem_summary: analysis.problem_summary,
    category: analysis.category,
    severity: analysis.severity,
    priority: analysis.priority,
    reasoning: analysis.reasoning,
    recommended_department: analysis.recommended_department,
    recommended_action: analysis.recommended_action,
    confidence: analysis.confidence,
    model: analysis.model,
    extended: {
      subcategory: analysis.subcategory,
      severity_reasoning: analysis.severity_reasoning,
      priority_reasoning: analysis.priority_reasoning,
      action_steps: analysis.action_steps,
      affected_infrastructure: analysis.affected_infrastructure,
      urgency_factors: analysis.urgency_factors,
      safety_risk: analysis.safety_risk,
      affected_population: analysis.affected_population,
      time_context: analysis.time_context,
      location_context: analysis.location_context,
      evidence: analysis.evidence,
      complaint_subject: analysis.complaint_subject,
      complaint_impact: analysis.complaint_impact,
      complaint_action: analysis.complaint_action,
    },
  };
}

/** Notifies the reporter that AI analysis finished, and — only when the AI
 * genuinely determined CRITICAL priority — alerts every government user
 * whose configured jurisdiction covers this report's location. Shared by
 * both the initial submission path and the manual retry path so the two
 * can't drift apart. */
async function notifyAiAnalysisComplete(
  admin: ReturnType<typeof createAdminClient>,
  input: {
    reportId: string;
    reporterId: string;
    title: string;
    analysis: Awaited<ReturnType<typeof analyzeReport>>;
    location: CivicLocation;
  }
) {
  await createNotification(admin, {
    recipientId: input.reporterId,
    type: "ai_analysis_completed",
    title: "AI analysis complete",
    body: `"${input.title}" has been analyzed and classified as ${input.analysis.priority} priority.`,
    relatedReportId: input.reportId,
  });

  if (input.analysis.priority === "critical") {
    const govUserIds = await findGovernmentUsersForJurisdiction(admin, input.location);
    for (const recipientId of govUserIds) {
      await createNotification(admin, {
        recipientId,
        type: "critical_issue",
        title: "Critical issue reported in your jurisdiction",
        body: `"${input.title}" — ${input.analysis.problem_summary}`,
        relatedReportId: input.reportId,
      });
    }
  }
}

/** Phase G3 — AI recommendation -> configured department -> authorized
 * in-charge, for a report whose AI analysis just succeeded. Runs outside
 * the AI try/catch so a routing problem is never mislabelled as an AI
 * failure, and never fails the already-saved report. */
async function routeAnalyzedReport(
  admin: ReturnType<typeof createAdminClient>,
  input: {
    reportId: string;
    title: string;
    citizenCategory: ProblemCategory;
    analysis: Awaited<ReturnType<typeof analyzeReport>>;
    location: JurisdictionLike;
    departments: ConfiguredDepartment[];
  }
): Promise<RouteReportResult | null> {
  try {
    return await routeReport(admin, {
      reportId: input.reportId,
      title: input.title,
      categoryLabel: categoryLabels[input.citizenCategory],
      citizenCategory: input.citizenCategory,
      aiCategory: categoryFromDb[input.analysis.category] ?? null,
      aiRecommendation: input.analysis.recommended_department,
      priority: input.analysis.priority,
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

  await createNotification(admin, {
    recipientId: user.id,
    type: "report_created",
    title: "Report submitted",
    body: `"${title}" has been received and is being analyzed.`,
    relatedReportId: reportId,
  });

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

  let imageBase64: string | undefined;
  let imageMimeType: string | undefined;

  if (photo instanceof File && photo.size > 0) {
    const validationError = validateImageFile(photo);
    if (validationError) {
      return { status: "error", error: validationError };
    }
    try {
      const buffer = Buffer.from(await photo.arrayBuffer());
      const { error: bufferError, extension } = validateImageBuffer(buffer);
      if (bufferError) {
        return { status: "error", error: bufferError };
      }
      const path = `${user.id}/${reportId}/${randomUUID()}.${extension}`;

      const { error: uploadError } = await admin.storage
        .from("report-media")
        .upload(path, buffer, { contentType: photo.type || "image/jpeg" });

      if (uploadError) {
        return { status: "error", error: UPLOAD_FAILURE_MESSAGE };
      }

      await admin.from("report_media").insert({
        report_id: reportId,
        uploaded_by: user.id,
        kind: "evidence",
        file_path: path,
        file_type: "image",
        mime_type: photo.type || "image/jpeg",
      });

      imageBase64 = buffer.toString("base64");
      imageMimeType = photo.type || "image/jpeg";
    } catch {
      return { status: "error", error: UPLOAD_FAILURE_MESSAGE };
    }
  }

  const departments = await loadConfiguredDepartments(admin);

  let aiFailed = false;
  let completedAnalysis: Awaited<ReturnType<typeof analyzeReport>> | null = null;
  try {
    const analysis = await analyzeWithRetry({
      description,
      category,
      location,
      imageBase64,
      imageMimeType,
      departmentNames: departments.map((d) => d.name),
    });
    completedAnalysis = analysis;

    await admin.from("ai_analyses").insert(buildAiAnalysesRow(reportId, analysis));

    await admin
      .from("reports")
      .update({
        severity: analysis.severity,
        priority: analysis.priority,
        status: "ai_analyzed",
      })
      .eq("id", reportId);
    await logStatusChange(admin, reportId, "reported", "ai_analyzed", null, "AI analysis complete");
    await notifyAiAnalysisComplete(admin, { reportId, reporterId: user.id, title, analysis, location });
  } catch (err) {
    aiFailed = true;
    console.error("AI analysis failed for report", reportId, err);
  }

  // No AI analysis -> no routing: the report stays "reported" (Routing
  // pending) and is routed by retryAiAnalysis once analysis succeeds. A
  // department is never guessed for an unanalyzed report.
  const routing = completedAnalysis
    ? await routeAnalyzedReport(admin, {
        reportId,
        title,
        citizenCategory: category,
        analysis: completedAnalysis,
        location,
        departments,
      })
    : null;

  // Phase G2 — REPORT_CREATED for the government users whose jurisdiction
  // covers this report. Sent after AI analysis so the payload carries the
  // real priority when there is one (null, never guessed, when AI failed).
  try {
    await notifyGovernmentOfNewReport(admin, {
      reportId,
      title,
      category: categoryToDb[category],
      categoryLabel: categoryLabels[category],
      jurisdiction,
      priority: completedAnalysis?.priority ?? null,
    });
  } catch (err) {
    console.error("Government new-report notification failed (non-fatal)", reportId, err);
  }

  // Civic Incident Intelligence — best-effort, non-fatal, exactly like
  // duplicate detection above: runs whether or not AI analysis succeeded
  // (subcategory/severity are used only when available), and never affects
  // the report that was already fully created above.
  try {
    await evaluateIncidentForReport(admin, {
      reportId,
      category,
      subcategory: completedAnalysis?.subcategory ?? null,
      description,
      location,
      createdAt: new Date().toISOString(),
      severity: completedAnalysis?.severity ?? null,
      departmentId: routing?.outcome === "routed" ? routing.departmentId : null,
      existingDuplicateCandidate: duplicateCandidate
        ? { reportId: duplicateCandidate.reportId, relationType: duplicateCandidate.relationType }
        : null,
    });
  } catch (err) {
    console.error("Incident linking failed for report", reportId, err);
  }

  return { status: "success", reportId, aiFailed };
}

/** Manual retry when AI analysis failed at submission time (Step 21: no
 * indefinite auto-retry — this is the explicit user-triggered retry). */
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
  if (report.status !== "reported") {
    return {};
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

  try {
    const departments = await loadConfiguredDepartments(admin);
    const analysis = await analyzeWithRetry({
      description: report.description,
      category,
      location: retryLocation,
      departmentNames: departments.map((d) => d.name),
    });

    await admin.from("ai_analyses").insert(buildAiAnalysesRow(reportId, analysis));

    await admin
      .from("reports")
      .update({ severity: analysis.severity, priority: analysis.priority, status: "ai_analyzed" })
      .eq("id", reportId);
    await logStatusChange(admin, reportId, "reported", "ai_analyzed", null, "AI analysis complete (retry)");
    await notifyAiAnalysisComplete(admin, {
      reportId,
      reporterId: report.reporter_id,
      title: report.title,
      analysis,
      location: retryLocation,
    });

    await routeAnalyzedReport(admin, {
      reportId,
      title: report.title,
      citizenCategory: category,
      analysis,
      location: retryLocation,
      departments,
    });

    return {};
  } catch {
    return { error: "AI analysis is temporarily unavailable." };
  }
}
