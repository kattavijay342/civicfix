import { describe, it, expect } from "vitest";
import { isValidLatitude, isValidLongitude, isValidAccuracyMeters, sanitizeCoordinates } from "./validation";

describe("isValidLatitude", () => {
  it("accepts values within -90..90", () => {
    expect(isValidLatitude(0)).toBe(true);
    expect(isValidLatitude(90)).toBe(true);
    expect(isValidLatitude(-90)).toBe(true);
    expect(isValidLatitude(16.2333)).toBe(true);
  });

  it("rejects out-of-range, non-finite, and non-number values", () => {
    expect(isValidLatitude(90.0001)).toBe(false);
    expect(isValidLatitude(-90.0001)).toBe(false);
    expect(isValidLatitude(NaN)).toBe(false);
    expect(isValidLatitude(Infinity)).toBe(false);
    expect(isValidLatitude(-Infinity)).toBe(false);
    expect(isValidLatitude("16.2")).toBe(false);
    expect(isValidLatitude(null)).toBe(false);
    expect(isValidLatitude(undefined)).toBe(false);
  });
});

describe("isValidLongitude", () => {
  it("accepts values within -180..180", () => {
    expect(isValidLongitude(0)).toBe(true);
    expect(isValidLongitude(180)).toBe(true);
    expect(isValidLongitude(-180)).toBe(true);
    expect(isValidLongitude(80.0499)).toBe(true);
  });

  it("rejects out-of-range, non-finite, and non-number values", () => {
    expect(isValidLongitude(180.0001)).toBe(false);
    expect(isValidLongitude(-180.0001)).toBe(false);
    expect(isValidLongitude(NaN)).toBe(false);
    expect(isValidLongitude(Infinity)).toBe(false);
    expect(isValidLongitude("80.0")).toBe(false);
  });
});

describe("isValidAccuracyMeters", () => {
  it("accepts zero and positive finite numbers", () => {
    expect(isValidAccuracyMeters(0)).toBe(true);
    expect(isValidAccuracyMeters(12.5)).toBe(true);
  });

  it("rejects negative, non-finite, and non-number values", () => {
    expect(isValidAccuracyMeters(-1)).toBe(false);
    expect(isValidAccuracyMeters(NaN)).toBe(false);
    expect(isValidAccuracyMeters(Infinity)).toBe(false);
    expect(isValidAccuracyMeters(null)).toBe(false);
  });
});

describe("sanitizeCoordinates", () => {
  it("returns a sanitized pair for valid input", () => {
    const result = sanitizeCoordinates(16.2333, 80.0499, 12);
    expect(result).toEqual({ latitude: 16.2333, longitude: 80.0499, accuracy: 12 });
  });

  it("returns null (never a fake 0,0 default) when latitude is invalid", () => {
    expect(sanitizeCoordinates(NaN, 80.0499)).toBeNull();
    expect(sanitizeCoordinates(91, 80.0499)).toBeNull();
  });

  it("returns null when longitude is invalid", () => {
    expect(sanitizeCoordinates(16.2333, Infinity)).toBeNull();
    expect(sanitizeCoordinates(16.2333, 181)).toBeNull();
  });

  it("drops an invalid accuracy without invalidating otherwise-good coordinates", () => {
    const result = sanitizeCoordinates(16.2333, 80.0499, -5);
    expect(result).toEqual({ latitude: 16.2333, longitude: 80.0499, accuracy: null });
  });

  it("never returns (0, 0) as a fallback for missing/invalid input", () => {
    expect(sanitizeCoordinates(null, null)).toBeNull();
    expect(sanitizeCoordinates(undefined, undefined)).toBeNull();
    expect(sanitizeCoordinates("0", "0")).toBeNull();
  });
});
