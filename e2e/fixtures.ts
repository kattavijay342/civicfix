/** A real, valid, minimal 1x1 white-pixel JPEG — small enough to commit
 * inline as base64 rather than checking in a binary fixture file. Used to
 * exercise the actual upload code path (magic-byte sniffing, Storage
 * upload, report_media row) with genuine JPEG bytes. */
const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";

export function tinyJpegBuffer(): Buffer {
  return Buffer.from(TINY_JPEG_BASE64, "base64");
}

/** Same MIME-spoofing shape as scripts/security-audit.mjs style live
 * checks: a client can claim any Content-Type it likes, so the server must
 * never trust it. Plain text bytes, deliberately reported as image/jpeg. */
export function spoofedNotAnImageBuffer(): Buffer {
  return Buffer.from("This is definitely not a JPEG — just plain text pretending to be one.", "utf-8");
}

/** One byte over the 8MB server-side limit (src/lib/upload-limits.ts). */
export function oversizedJpegBuffer(): Buffer {
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1024, 0);
  // Real JPEG signature up front so this fails on SIZE specifically, not
  // also on content — isolates what's actually being tested.
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  return buffer;
}

export const TEST_CITIZEN = {
  email: "citizen1@test.civicfix.local",
  password: "CivicFixTest2026!",
};

export const TEST_GOVERNMENT = {
  email: "gov1@test.civicfix.local",
  password: "CivicFixTest2026!",
};

export const TEST_DEPARTMENT_INCHARGE = {
  email: "incharge1@test.civicfix.local",
  password: "CivicFixTest2026!",
};
