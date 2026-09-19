// Completes the resolution step for the E2E test report, performing the
// exact same DB/Storage writes as src/lib/actions/department.ts
// submitResolution(). Needed because the browser-automation pane used for
// interactive testing cannot drive a native file-picker input, so the
// "upload a photo" UI step can't be exercised there. The authorization
// logic (assertInchargeOrAdmin) is identical to updateReportStatus, which
// WAS verified through the real UI as incharge1.
// Usage: node --env-file=.env.local scripts/complete-resolution-test.mjs <reportId>
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const reportId = process.argv[2];
if (!reportId) {
  console.error("Usage: node scripts/complete-resolution-test.mjs <reportId>");
  process.exit(1);
}

const { data: report } = await admin.from("reports").select("*").eq("id", reportId).single();
if (!report) throw new Error("Report not found");

const { data: incharge } = await admin
  .from("profiles")
  .select("id")
  .eq("id", "078b774f-ed7e-47e4-93f7-546e8a02aa5b")
  .single();
if (!incharge) throw new Error("Test incharge not found");

const buffer = readFileSync("public/images/hero-pothole.jpg");
const path = `resolution/${reportId}/${randomUUID()}.jpg`;
const { error: uploadError } = await admin.storage.from("report-media").upload(path, buffer, { contentType: "image/jpeg" });
if (uploadError) throw new Error("upload failed: " + uploadError.message);

const { data: mediaRow, error: mediaError } = await admin
  .from("report_media")
  .insert({ report_id: reportId, uploaded_by: incharge.id, kind: "after", file_path: path, file_type: "image", mime_type: "image/jpeg" })
  .select("id")
  .single();
if (mediaError) throw new Error("media insert failed: " + mediaError.message);

const { data: beforeMedia } = await admin
  .from("report_media")
  .select("id")
  .eq("report_id", reportId)
  .eq("kind", "evidence")
  .order("created_at", { ascending: true })
  .limit(1)
  .maybeSingle();

const { error: resolutionError } = await admin.from("resolution_evidence").insert({
  report_id: reportId,
  before_media_id: beforeMedia?.id ?? null,
  after_media_id: mediaRow.id,
  resolution_notes: "Repair crew filled and resurfaced the pothole. Road surface is now smooth and safe.",
  resolved_by: incharge.id,
});
if (resolutionError) throw new Error("resolution_evidence insert failed: " + resolutionError.message);

await admin.from("reports").update({ status: "resolved" }).eq("id", reportId);

await admin.from("status_history").insert({
  report_id: reportId,
  old_status: report.status,
  new_status: "resolved",
  changed_by: incharge.id,
  notes: "Repair crew filled and resurfaced the pothole. Road surface is now smooth and safe.",
});

await admin.from("notifications").insert({
  recipient_id: report.reporter_id,
  type: "report_resolved",
  title: "Your report was resolved",
  body: `"${report.title}" has been marked resolved.`,
  related_report_id: reportId,
});

console.log("Resolution recorded for report", reportId);
