/**
 * Sample data for Phase 1 UI preview purposes only.
 * No backend, database, or AI service is connected yet — these fixtures
 * exist so the dashboard/map/issue-card components have realistic shapes
 * to render. Replace with live data once the API layer exists.
 */
import type {
  AIInsight,
  CivicIssue,
  DepartmentPerformance,
  DuplicateGroup,
  PendingByPriority,
  ProblemCategory,
} from "./types";

export const categoryImages: Record<ProblemCategory, string> = {
  ROAD: "/images/issue-pothole.jpg",
  GARBAGE: "/images/issue-garbage.jpg",
  DRAINAGE: "/images/issue-drainage.jpg",
  WATER_LEAKAGE: "/images/issue-water-leak.jpg",
  STREETLIGHT: "/images/issue-streetlight.jpg",
  SEWAGE: "/images/issue-sewage.jpg",
  DUMPING: "/images/issue-dumping.jpg",
  INFRASTRUCTURE: "/images/issue-infrastructure.jpg",
  OTHER: "/images/issue-infrastructure.jpg",
};

export const sampleIssues: CivicIssue[] = [
  {
    id: "CF-1042",
    title: "Large pothole blocking left lane",
    category: "ROAD",
    location: {
      displayName: "Sattenapalli Road, near RTC Bus Stand",
      state: "Andhra Pradesh",
      district: "Palnadu",
      constituency: "Narasaraopet",
      area: "Ward 12",
      landmark: "Sattenapalli Road, near RTC Bus Stand",
      latitude: null,
      longitude: null,
      source: "demo",
    },
    priority: "CRITICAL",
    status: "IN_PROGRESS",
    reportedDate: "2026-09-11",
    department: "Roads",
    imageUrl: categoryImages.ROAD,
    daysPending: 8,
    followUps: 2,
    lastFollowUp: "Called concerned in-charge — repair crew assigned",
    nextFollowUp: "Tomorrow, 10:00 AM",
  },
  {
    id: "CF-1039",
    title: "Overflowing garbage bin near market",
    category: "GARBAGE",
    location: {
      displayName: "Nehru Market, Block C",
      state: "Andhra Pradesh",
      district: "Guntur",
      constituency: "Guntur West",
      area: "Arundelpet",
      landmark: "Nehru Market, Block C",
      latitude: null,
      longitude: null,
      source: "demo",
    },
    priority: "HIGH",
    status: "ACKNOWLEDGED",
    reportedDate: "2026-09-14",
    department: "Sanitation",
    imageUrl: categoryImages.GARBAGE,
    daysPending: 5,
    followUps: 1,
    lastFollowUp: "Emailed Sanitation duty officer",
    nextFollowUp: "In 2 days",
  },
  {
    id: "CF-1035",
    title: "Streetlight not working for a week",
    category: "STREETLIGHT",
    location: {
      displayName: "Park Avenue, Lane 2",
      state: "Andhra Pradesh",
      district: "Palnadu",
      constituency: "Gurazala",
      area: "Gurazala Mandal",
      landmark: "Park Avenue, Lane 2",
      latitude: null,
      longitude: null,
      source: "demo",
    },
    priority: "MEDIUM",
    status: "REPORTED",
    reportedDate: "2026-09-16",
    department: "Electrical",
    imageUrl: categoryImages.STREETLIGHT,
    daysPending: 3,
    followUps: 0,
  },
  {
    id: "CF-1021",
    title: "Drainage water stagnating outside school",
    category: "DRAINAGE",
    location: {
      displayName: "Gandhi Nagar, Zone 2",
      state: "Andhra Pradesh",
      district: "Guntur",
      constituency: "Tenali",
      area: "Tenali Municipality",
      landmark: "Gandhi Nagar, Zone 2",
      latitude: null,
      longitude: null,
      source: "demo",
    },
    priority: "CRITICAL",
    status: "ACKNOWLEDGED",
    reportedDate: "2026-09-12",
    department: "Drainage",
    imageUrl: categoryImages.DRAINAGE,
    daysPending: 7,
    followUps: 3,
    lastFollowUp: "Site visit confirmed by ward officer",
    nextFollowUp: "Today, 4:00 PM",
  },
  {
    id: "CF-1018",
    title: "Water pipeline leakage flooding footpath",
    category: "WATER_LEAKAGE",
    location: {
      displayName: "Lake View Road",
      state: "Telangana",
      district: "Hyderabad",
      constituency: "Secunderabad",
      area: "Ward 1",
      landmark: "Lake View Road",
      latitude: null,
      longitude: null,
      source: "demo",
    },
    priority: "HIGH",
    status: "IN_PROGRESS",
    reportedDate: "2026-09-13",
    department: "Water Supply",
    imageUrl: categoryImages.WATER_LEAKAGE,
    daysPending: 6,
    followUps: 1,
  },
  {
    id: "CF-1005",
    title: "Illegal debris dumping on residential street",
    category: "DUMPING",
    location: {
      displayName: "Ferndale Colony",
      state: "Andhra Pradesh",
      district: "Palnadu",
      constituency: "Narasaraopet",
      area: "Ward 12",
      landmark: "Ferndale Colony",
      latitude: null,
      longitude: null,
      source: "demo",
    },
    priority: "MEDIUM",
    status: "ACKNOWLEDGED",
    reportedDate: "2026-09-08",
    department: "Sanitation",
    imageUrl: categoryImages.DUMPING,
    daysPending: 11,
    followUps: 2,
  },
  {
    id: "CF-0998",
    title: "Cracked footpath tiles near bus stop",
    category: "INFRASTRUCTURE",
    location: {
      displayName: "Station Road",
      state: "Telangana",
      district: "Hyderabad",
      constituency: "Khairatabad",
      area: "Ward 6",
      landmark: "Station Road",
      latitude: null,
      longitude: null,
      source: "demo",
    },
    priority: "LOW",
    status: "RESOLVED",
    reportedDate: "2026-08-29",
    department: "Public Works",
    imageUrl: categoryImages.INFRASTRUCTURE,
    daysPending: 0,
    followUps: 1,
  },
];

export const departmentPerformance: DepartmentPerformance[] = [
  { name: "Roads", resolutionRate: 85, totalIssues: 40, resolvedIssues: 34, pendingIssues: 6, onTimeRate: 78, avgResolutionDays: 6.2, trend: 3 },
  { name: "Sanitation", resolutionRate: 92, totalIssues: 28, resolvedIssues: 26, pendingIssues: 2, onTimeRate: 88, avgResolutionDays: 2.8, trend: 4 },
  { name: "Water Supply", resolutionRate: 81, totalIssues: 22, resolvedIssues: 18, pendingIssues: 4, onTimeRate: 70, avgResolutionDays: 5.1, trend: -2 },
  { name: "Drainage", resolutionRate: 87, totalIssues: 18, resolvedIssues: 16, pendingIssues: 2, onTimeRate: 80, avgResolutionDays: 4.4, trend: 1 },
  { name: "Electrical", resolutionRate: 90, totalIssues: 20, resolvedIssues: 18, pendingIssues: 2, onTimeRate: 85, avgResolutionDays: 3.0, trend: 5 },
];

export const pendingByPriority: PendingByPriority[] = [
  { priority: "CRITICAL", count: 3 },
  { priority: "HIGH", count: 7 },
  { priority: "MEDIUM", count: 6 },
  { priority: "LOW", count: 2 },
];

export const areaOverview = {
  totalIssues: 128,
  resolved: 113,
  pending: 15,
  critical: 3,
  resolutionRate: 88,
};

export const aiInsights: AIInsight[] = [
  { id: "ai-1", text: "Drainage issues increased 18% this month", tone: "down" },
  { id: "ai-2", text: "Ward 12 has the highest number of pending issues", tone: "neutral" },
  { id: "ai-3", text: "Road-related complaints are the largest issue category", tone: "neutral" },
  { id: "ai-4", text: "Sanitation resolution time improved by 1.2 days on average", tone: "up" },
];

export const duplicateGroups: DuplicateGroup[] = [
  {
    primary: {
      id: sampleIssues[0].id,
      title: sampleIssues[0].title,
      location: sampleIssues[0].location,
      category: sampleIssues[0].category,
      status: sampleIssues[0].status,
    },
    similarCount: 3,
  },
];

export const citizenOverview = {
  totalReports: 14,
  highPriority: 3,
  inProgress: 3,
  resolved: 9,
  pending: 5,
};

export const reportsByCategory: { category: ProblemCategory; label: string; count: number }[] = [
  { category: "ROAD", label: "Road / Pothole", count: 5 },
  { category: "GARBAGE", label: "Garbage", count: 3 },
  { category: "DRAINAGE", label: "Drainage", count: 2 },
  { category: "WATER_LEAKAGE", label: "Water Leakage", count: 2 },
  { category: "STREETLIGHT", label: "Streetlight", count: 1 },
  { category: "DUMPING", label: "Illegal Dumping", count: 1 },
];
