import { describe, it, expect } from "vitest";
import {
  validateImageFile,
  detectImageMimeType,
  validateImageBuffer,
  MAX_IMAGE_BYTES,
} from "@/lib/upload-limits";

function fakeFile(size: number, type: string): File {
  return { size, type } as File;
}

describe("validateImageFile (client-reported metadata)", () => {
  it("accepts a normal JPEG under the size limit", () => {
    expect(validateImageFile(fakeFile(1024 * 1024, "image/jpeg"))).toBeNull();
  });
  it("rejects a file over the 8MB limit", () => {
    expect(validateImageFile(fakeFile(MAX_IMAGE_BYTES + 1, "image/jpeg"))).toMatch(/too large/i);
  });
  it("rejects a disallowed mime type", () => {
    expect(validateImageFile(fakeFile(1024, "application/pdf"))).toMatch(/JPEG, PNG, WEBP/);
  });
  it("rejects an executable disguised with an image extension but a non-image reported type", () => {
    expect(validateImageFile(fakeFile(1024, "application/x-msdownload"))).not.toBeNull();
  });
});

describe("detectImageMimeType (magic-byte sniffing — MIME spoofing protection)", () => {
  it("detects a real JPEG from its signature", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectImageMimeType(jpeg)).toBe("image/jpeg");
  });
  it("detects a real PNG from its signature", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(detectImageMimeType(png)).toBe("image/png");
  });
  it("detects a real WEBP from its RIFF/WEBP signature", () => {
    const webp = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("WEBP", "ascii"),
    ]);
    expect(detectImageMimeType(webp)).toBe("image/webp");
  });
  it("returns null for a file whose content does not match any allowed image signature", () => {
    // A client could set file.type = "image/jpeg" while uploading anything —
    // e.g. an HTML/script payload — this must not be trusted.
    const fakeImage = Buffer.from("<script>alert(1)</script>", "ascii");
    expect(detectImageMimeType(fakeImage)).toBeNull();
  });
  it("returns null for an empty buffer", () => {
    expect(detectImageMimeType(Buffer.alloc(0))).toBeNull();
  });
  it("returns null for a PE/EXE header spoofed with a .jpg-like small buffer", () => {
    const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // "MZ" DOS header
    expect(detectImageMimeType(exe)).toBeNull();
  });
});

describe("validateImageBuffer", () => {
  it("accepts real JPEG bytes and returns the jpg extension", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const result = validateImageBuffer(jpeg);
    expect(result.error).toBeNull();
    expect(result.extension).toBe("jpg");
  });
  it("rejects bytes that merely claim to be an image (spoofed Content-Type case)", () => {
    const notAnImage = Buffer.from("this is not an image", "ascii");
    const result = validateImageBuffer(notAnImage);
    expect(result.error).not.toBeNull();
  });
});
