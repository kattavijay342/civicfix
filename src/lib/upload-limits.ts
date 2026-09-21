export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB
export const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

/** Safe, fixed extension per allowed type — never derived from a
 * client-supplied filename (which could inject path segments). */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

export function validateImageFile(file: File): string | null {
  if (file.size > MAX_IMAGE_BYTES) return "Photo is too large (8MB max).";
  if (file.type && !ALLOWED_IMAGE_TYPES.has(file.type)) return "Please upload a JPEG, PNG, WEBP, or HEIC photo.";
  return null;
}

/** Sniffs the real file signature (magic bytes) instead of trusting the
 * browser-reported `file.type`, which is client-controlled and easily
 * spoofed (e.g. an empty/forged Content-Type on the multipart part). Called
 * server-side after reading the file into a buffer, before it's uploaded to
 * Storage. Returns the detected MIME type, or null if it doesn't match any
 * allowed image format. */
export function detectImageMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii").trim().toLowerCase();
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return brand.startsWith("mif1") || brand.startsWith("msf1") ? "image/heif" : "image/heic";
    }
  }
  return null;
}

/** Validates the actual bytes of an uploaded image against the allowed
 * formats and returns a safe extension for the storage path. Returns an
 * error string if the content doesn't match a real, allowed image format —
 * regardless of what the client claimed the type/filename were. */
export function validateImageBuffer(buffer: Buffer): { error: string | null; extension: string } {
  const detected = detectImageMimeType(buffer);
  if (!detected) {
    return { error: "Please upload a JPEG, PNG, WEBP, or HEIC photo.", extension: "jpg" };
  }
  return { error: null, extension: EXTENSION_BY_MIME[detected] };
}
