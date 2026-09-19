import {
  Construction,
  Droplet,
  Lightbulb,
  PackageX,
  ShieldAlert,
  Trash2,
  Waves,
  Building,
  CircleEllipsis,
  type LucideIcon,
} from "lucide-react";
import type { ProblemCategory } from "./types";

export const categoryLabels: Record<ProblemCategory, string> = {
  ROAD: "Road / Pothole",
  GARBAGE: "Garbage",
  DRAINAGE: "Drainage",
  WATER_LEAKAGE: "Water Leakage",
  STREETLIGHT: "Streetlight",
  SEWAGE: "Sewage",
  DUMPING: "Illegal Dumping",
  INFRASTRUCTURE: "Public Infrastructure",
  OTHER: "Other",
};

export const categoryIcons: Record<ProblemCategory, LucideIcon> = {
  ROAD: Construction,
  GARBAGE: Trash2,
  DRAINAGE: Waves,
  WATER_LEAKAGE: Droplet,
  STREETLIGHT: Lightbulb,
  SEWAGE: ShieldAlert,
  DUMPING: PackageX,
  INFRASTRUCTURE: Building,
  OTHER: CircleEllipsis,
};

export const categoryOrder: ProblemCategory[] = [
  "ROAD",
  "GARBAGE",
  "DRAINAGE",
  "STREETLIGHT",
  "WATER_LEAKAGE",
  "SEWAGE",
  "DUMPING",
  "INFRASTRUCTURE",
  "OTHER",
];
