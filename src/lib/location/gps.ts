/**
 * Phase 6B — pure GPS/geolocation helpers, extracted out of
 * SmartLocationField so the error-message mapping and options are
 * independently testable. No provider/API involved — this only wraps the
 * browser's own `navigator.geolocation`.
 */

export type GeolocationFailureReason =
  | "unsupported"
  | "permission_denied"
  | "position_unavailable"
  | "timeout"
  | "unknown";

/** Distinguishes the standard `GeolocationPositionError` codes instead of
 * collapsing every failure into one generic message. */
export function classifyGeolocationError(error: GeolocationPositionError): GeolocationFailureReason {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return "permission_denied";
    case error.POSITION_UNAVAILABLE:
      return "position_unavailable";
    case error.TIMEOUT:
      return "timeout";
    default:
      return "unknown";
  }
}

export function describeGeolocationFailure(reason: GeolocationFailureReason): string {
  switch (reason) {
    case "unsupported":
      return "Location access isn't available in this browser. You can search or select the location manually.";
    case "permission_denied":
      return "Location permission was denied. You can search or select the location manually.";
    case "position_unavailable":
      return "We couldn't determine your position. Please select the location manually.";
    case "timeout":
      return "Location request timed out. You can try again, or select the location manually.";
    case "unknown":
      return "Location access was not available. You can select the location manually.";
  }
}

/** `enableHighAccuracy` asks the device for its best fix (GPS chip over
 * coarse network/IP positioning where available); `maximumAge: 0` refuses a
 * stale cached position — a citizen reporting a problem right now should get
 * their current position, not wherever the browser last knew about. */
export const GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 10_000,
  maximumAge: 0,
};
