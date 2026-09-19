/** Reporter-details validation. No live verification (SMS/OTP) is connected — format checks only. */

export function isValidReporterName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 2 && trimmed.length <= 60;
}

/** Strips spaces/dashes and an optional leading "+91"/"91" country code, leaving bare digits. */
export function mobileDigitsOnly(mobile: string): string {
  const stripped = mobile.replace(/[\s-]/g, "");
  return stripped.replace(/^\+?91/, "");
}

/** Indian mobile numbers: 10 digits, starting 6-9. */
export function isValidIndianMobile(mobile: string): boolean {
  return /^[6-9]\d{9}$/.test(mobileDigitsOnly(mobile));
}

export function formatIndianMobile(mobile: string): string {
  const digits = mobileDigitsOnly(mobile);
  return digits ? `+91${digits}` : "";
}
