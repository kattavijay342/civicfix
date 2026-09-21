import { describe, it, expect } from "vitest";
import { classifyGeolocationError, describeGeolocationFailure, GEOLOCATION_OPTIONS } from "./gps";

function makeError(code: 1 | 2 | 3): GeolocationPositionError {
  return {
    code,
    message: "test",
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  } as GeolocationPositionError;
}

describe("classifyGeolocationError", () => {
  it("maps PERMISSION_DENIED (code 1)", () => {
    expect(classifyGeolocationError(makeError(1))).toBe("permission_denied");
  });

  it("maps POSITION_UNAVAILABLE (code 2)", () => {
    expect(classifyGeolocationError(makeError(2))).toBe("position_unavailable");
  });

  it("maps TIMEOUT (code 3)", () => {
    expect(classifyGeolocationError(makeError(3))).toBe("timeout");
  });
});

describe("describeGeolocationFailure", () => {
  it("gives a distinct, correct message for every reason — never one generic message", () => {
    const messages = new Set([
      describeGeolocationFailure("unsupported"),
      describeGeolocationFailure("permission_denied"),
      describeGeolocationFailure("position_unavailable"),
      describeGeolocationFailure("timeout"),
      describeGeolocationFailure("unknown"),
    ]);
    expect(messages.size).toBe(5);
  });

  it("every message offers a manual fallback", () => {
    for (const reason of ["unsupported", "permission_denied", "position_unavailable", "timeout", "unknown"] as const) {
      expect(describeGeolocationFailure(reason).toLowerCase()).toMatch(/manual/);
    }
  });
});

describe("GEOLOCATION_OPTIONS", () => {
  it("never uses a stale cached position", () => {
    expect(GEOLOCATION_OPTIONS.maximumAge).toBe(0);
  });

  it("requests the device's best available accuracy", () => {
    expect(GEOLOCATION_OPTIONS.enableHighAccuracy).toBe(true);
  });
});
