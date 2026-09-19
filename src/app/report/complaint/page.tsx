"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, LayoutDashboard } from "lucide-react";
import { ComplaintDocument, type ComplaintFields } from "@/components/cards/ComplaintDocument";
import { CTAButton } from "@/components/ui/CTAButton";
import { ReportProgress } from "@/components/report/ReportProgress";
import { loadReportDraft, DEFAULT_DRAFT, type ReportDraft } from "@/lib/report-draft";
import { categoryAIPresets } from "@/lib/ai-presets";
import { locationComplaintSummary, locationDocumentLines } from "@/lib/location-format";

export default function ComplaintPage() {
  const [draft, setDraft] = useState<ReportDraft | null>(null);

  useEffect(() => {
    // sessionStorage is only available client-side; reading it here (rather
    // than during render) avoids an SSR/hydration content mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(loadReportDraft() ?? DEFAULT_DRAFT);
  }, []);

  if (!draft) return null;

  const preset = categoryAIPresets[draft.category];
  const locationLabel = locationComplaintSummary(draft.location).join("\n");
  const locationFullDetails = locationDocumentLines(draft.location).join("\n");
  const usedCustomDescription = draft.description.trim() !== DEFAULT_DRAFT.description.trim();

  const contentEn: ComplaintFields = {
    subject: preset.complaintEn.subject,
    description: draft.description.trim() || preset.complaintEn.description,
    location: locationLabel,
    impact: preset.complaintEn.impact,
    action: preset.complaintEn.action,
  };

  const contentTe: ComplaintFields = {
    subject: preset.complaintTe.subject,
    description: usedCustomDescription ? draft.description.trim() : preset.complaintTe.description,
    location: locationLabel,
    impact: preset.complaintTe.impact,
    action: preset.complaintTe.action,
  };

  return (
    <div className="bg-surface-muted">
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
        <Link
          href="/report/analysis"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to analysis
        </Link>

        <div className="mt-6 text-center">
          <span className="text-sm font-semibold text-civic-700">Complaint Generator</span>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
            Your complaint is ready.
          </h1>
          <p className="mt-2 text-sm text-foreground-muted">
            Review, edit if needed, then take it to your dashboard to track progress.
          </p>
          <div className="mt-4 flex justify-center">
            <ReportProgress current={3} />
          </div>
        </div>

        <div className="mt-8">
          <ComplaintDocument
            issueId="CF-DEMO"
            contentEn={contentEn}
            contentTe={contentTe}
            locationFullDetails={locationFullDetails}
            imageSrc={draft.imageDataUrl ?? "/images/hero-pothole.jpg"}
            imageAlt="Photo evidence attached to your complaint"
            footerNote="Demo complaint document — subject, impact, and requested action are pre-written templates. Generation and translation are not connected to a live AI/translation service in Phase 1A."
            descriptionNote={
              usedCustomDescription
                ? "Shown in the language you typed it — live translation isn't connected yet."
                : undefined
            }
            afterActions={
              <CTAButton href="/dashboard" size="md" className="mt-1 w-full justify-center">
                <LayoutDashboard className="mr-1.5 h-4 w-4" />
                Go to Dashboard
              </CTAButton>
            }
          />
        </div>
      </div>
    </div>
  );
}
