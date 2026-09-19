"use server";

import { randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { analyzeReport, AIUnavailableError } from "@/lib/ai";
import { findPossibleDuplicate } from "@/lib/duplicate-detection";
import { resolveAssignment } from "@/lib/actions/routing";
import { logStatusChange } from "@/lib/actions/status-history";
import { notifyNewAssignment } from "@/lib/actions/notifications";
import { categoryToDb, categoryFromDb } from "@/lib/db-enums";
import { categoryLabels } from "@/lib/categories";
import { isValidReporterName, isValidIndianMobile, formatIndianMobile } from "@/lib/validators";
import { validateImageFile } from "@/lib/upload-limits";
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

  const admin = createAdminClient();

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

  if (!confirmDuplicate) {
    try {
      const duplicate = await findPossibleDuplicate(admin, {
        category: categoryToDb[category],
        location,
        description,
      });
      if (duplicate && duplicate.score >= 0.55) {
        return {
          status: "duplicate",
          duplicateReportId: duplicate.reportId,
          duplicateTitle: duplicate.title,
        };
      }
    } catch {
      // Duplicate detection is a best-effort convenience — never block
      // submission if it fails.
    }
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

  const { error: locationError } = await admin.from("report_locations").insert({
    report_id: reportId,
    display_name: location.displayName,
    state: location.state ?? null,
    district: location.district ?? null,
    constituency: location.constituency ?? null,
    area: location.area ?? null,
    village: location.village ?? null,
    ward: location.ward ?? null,
    municipality: location.municipality ?? null,
    landmark: location.landmark ?? null,
    address: location.address ?? null,
    latitude: location.latitude ?? null,
    longitude: location.longitude ?? null,
    location_source: location.source ?? "manual",
  });

  if (locationError) {
    return { status: "error", error: DB_FAILURE_MESSAGE };
  }

  if (confirmDuplicate) {
    const duplicateOf = String(formData.get("duplicateOf") ?? "");
    if (duplicateOf) {
      await admin.from("report_duplicate_flags").insert({
        report_id: reportId,
        possible_duplicate_of: duplicateOf,
        similarity_score: 0.55,
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
      const ext = photo.name.split(".").pop() || "jpg";
      const path = `${user.id}/${reportId}/${randomUUID()}.${ext}`;

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

  let aiFailed = false;
  try {
    const analysis = await analyzeWithRetry({
      description,
      category,
      location,
      imageBase64,
      imageMimeType,
    });

    await admin.from("ai_analyses").insert({
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
    });

    await admin
      .from("reports")
      .update({
        severity: analysis.severity,
        priority: analysis.priority,
        status: "ai_analyzed",
      })
      .eq("id", reportId);
    await logStatusChange(admin, reportId, "reported", "ai_analyzed", null, "AI analysis complete");

    const assignment = await resolveAssignment(admin, category, location);
    if (assignment) {
      await admin.from("report_assignments").insert({
        report_id: reportId,
        department_id: assignment.departmentId,
        incharge_id: assignment.inchargeId,
        assignment_method: "auto",
      });
      await admin.from("reports").update({ status: "routed" }).eq("id", reportId);
      await logStatusChange(admin, reportId, "ai_analyzed", "routed", null, "Routed to configured department");
      await notifyNewAssignment(admin, reportId, assignment.inchargeId, title);
    }
  } catch (err) {
    aiFailed = true;
    console.error("AI analysis failed for report", reportId, err);
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

  try {
    const analysis = await analyzeWithRetry({
      description: report.description,
      category,
      location: {
        displayName: location.display_name,
        state: location.state,
        district: location.district,
        constituency: location.constituency,
        area: location.area,
        landmark: location.landmark,
        latitude: location.latitude,
        longitude: location.longitude,
        source: location.location_source,
      },
    });

    await admin.from("ai_analyses").insert({
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
    });

    await admin
      .from("reports")
      .update({ severity: analysis.severity, priority: analysis.priority, status: "ai_analyzed" })
      .eq("id", reportId);
    await logStatusChange(admin, reportId, "reported", "ai_analyzed", null, "AI analysis complete (retry)");

    const assignment = await resolveAssignment(admin, category, location);
    if (assignment) {
      await admin.from("report_assignments").insert({
        report_id: reportId,
        department_id: assignment.departmentId,
        incharge_id: assignment.inchargeId,
        assignment_method: "auto",
      });
      await admin.from("reports").update({ status: "routed" }).eq("id", reportId);
      await logStatusChange(admin, reportId, "ai_analyzed", "routed", null, "Routed to configured department");
      await notifyNewAssignment(admin, reportId, assignment.inchargeId, report.title);
    }

    return {};
  } catch {
    return { error: "AI analysis is temporarily unavailable." };
  }
}
