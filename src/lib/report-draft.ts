import type { CivicLocation, ProblemCategory } from "./types";

export interface ReportDraft {
  imageDataUrl?: string;
  imageIsDemo?: boolean;
  description: string;
  location: CivicLocation;
  category: ProblemCategory;
  reporterName: string;
  reporterMobile: string;
  submittedAt: string;
}

const KEY = "civicfix:report-draft";

export const DEFAULT_DRAFT: ReportDraft = {
  imageDataUrl: "/images/hero-pothole.jpg",
  imageIsDemo: true,
  description: "Large pothole on the main road, roughly 2 feet wide, forming a hazard for two-wheelers at night.",
  location: {
    displayName: "RTC Bus Stand, Ward 12",
    state: "Andhra Pradesh",
    district: "Palnadu",
    constituency: "Narasaraopet",
    area: "Ward 12",
    landmark: "RTC Bus Stand",
    latitude: null,
    longitude: null,
    source: "manual",
  },
  category: "ROAD",
  reporterName: "Ravi Kumar",
  reporterMobile: "+919876543210",
  submittedAt: new Date().toISOString(),
};

export function saveReportDraft(draft: ReportDraft) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // sessionStorage can be unavailable (private browsing, quota) — non-fatal.
  }
}

export function loadReportDraft(): ReportDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ReportDraft) : null;
  } catch {
    return null;
  }
}

export function clearReportDraft() {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
