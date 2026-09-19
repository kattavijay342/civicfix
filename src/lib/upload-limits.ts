export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB
export const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

export function validateImageFile(file: File): string | null {
  if (file.size > MAX_IMAGE_BYTES) return "Photo is too large (8MB max).";
  if (file.type && !ALLOWED_IMAGE_TYPES.has(file.type)) return "Please upload a JPEG, PNG, WEBP, or HEIC photo.";
  return null;
}
