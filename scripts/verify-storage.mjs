// One-off connectivity check for the "report-media" bucket, mirroring the
// exact upload call used by createReport / submitResolution.
// Usage: node --env-file=.env.local scripts/verify-storage.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const path = `_verify/${Date.now()}.txt`;
const body = Buffer.from("storage connectivity check");

const { error: uploadError } = await admin.storage.from("report-media").upload(path, body, {
  contentType: "text/plain",
});
if (uploadError) {
  console.error("UPLOAD FAILED:", uploadError.message);
  process.exit(1);
}
console.log("Upload OK:", path);

const { data: signed, error: signError } = await admin.storage.from("report-media").createSignedUrl(path, 60);
if (signError) {
  console.error("SIGNED URL FAILED:", signError.message);
  process.exit(1);
}
console.log("Signed URL OK:", signed.signedUrl.slice(0, 80) + "...");

const { error: removeError } = await admin.storage.from("report-media").remove([path]);
if (removeError) {
  console.error("CLEANUP FAILED:", removeError.message);
  process.exit(1);
}
console.log("Cleanup OK. Storage bucket is fully functional.");
