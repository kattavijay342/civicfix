import Image from "next/image";
import { ArrowRight, Pencil, ImageOff, Loader2, MapPin, User, Phone, ClipboardList } from "lucide-react";
import { categoryIcons, categoryLabels } from "@/lib/categories";
import { locationBreakdown } from "@/lib/location-format";
import type { CivicLocation, ProblemCategory } from "@/lib/types";

interface ReportReviewProps {
  previewUrl: string | null;
  description: string;
  category: ProblemCategory;
  location: CivicLocation;
  reporterName: string;
  reporterMobile: string;
  onEdit: () => void;
  onConfirm: () => void;
  submitting: boolean;
}

export function ReportReview({
  previewUrl,
  description,
  category,
  location,
  reporterName,
  reporterMobile,
  onEdit,
  onConfirm,
  submitting,
}: ReportReviewProps) {
  const CategoryIcon = categoryIcons[category];
  const detailRows = locationBreakdown(location);
  const hasPin = location.latitude != null && location.longitude != null;

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-border bg-white p-6">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-civic-700" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-foreground">Problem</h2>
        </div>
        <div className="mt-4 flex flex-col gap-4 sm:flex-row">
          <div className="relative h-32 w-full shrink-0 overflow-hidden rounded-xl border border-border bg-surface-muted sm:w-40">
            {previewUrl ? (
              <Image src={previewUrl} alt="Uploaded photo of the reported problem" fill sizes="160px" className="object-cover" />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-foreground-muted">
                <ImageOff className="h-5 w-5" aria-hidden="true" />
                <span className="text-[11px]">No photo attached</span>
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-civic-200 bg-civic-50 px-2.5 py-1 text-xs font-medium text-civic-700">
              <CategoryIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {categoryLabels[category]}
            </span>
            <p className="mt-2.5 text-sm leading-relaxed text-foreground-muted">{description}</p>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-white p-6">
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-civic-700" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-foreground">Location</h2>
        </div>
        <p className="mt-3 text-sm font-semibold text-foreground">{location.displayName}</p>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
          {detailRows.map((row) => (
            <div key={row.label}>
              <dt className="text-foreground-muted">{row.label}</dt>
              <dd className="mt-0.5 font-semibold text-foreground">{row.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 border-t border-border pt-3 text-xs text-foreground-muted">
          {hasPin
            ? `Map pin set — ${location.latitude!.toFixed(5)}, ${location.longitude!.toFixed(5)}`
            : "Map pin not set (optional) — jurisdiction fields above are still used for routing."}
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-white p-6">
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 text-civic-700" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-foreground">Reporter</h2>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-xs text-foreground-muted">Name</span>
            <p className="mt-0.5 font-semibold text-foreground">{reporterName}</p>
          </div>
          <div>
            <span className="flex items-center gap-1 text-xs text-foreground-muted">
              <Phone className="h-3 w-3" aria-hidden="true" />
              Mobile
            </span>
            <p className="mt-0.5 font-semibold text-foreground">{reporterMobile}</p>
          </div>
        </div>
      </div>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-center">
        <button
          type="button"
          onClick={onEdit}
          disabled={submitting}
          className="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-white px-6 py-3.5 text-sm font-medium text-foreground transition hover:border-civic-300 hover:bg-civic-50 disabled:cursor-not-allowed disabled:opacity-60 sm:px-8"
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
          Edit Report
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={submitting}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-civic-600 px-6 py-3.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-civic-700 disabled:cursor-not-allowed disabled:opacity-70 sm:px-8"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Analyzing…
            </>
          ) : (
            <>
              Analyze with AI
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </>
          )}
        </button>
      </div>
    </div>
  );
}
