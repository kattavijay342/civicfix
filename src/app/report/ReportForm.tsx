"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Sparkles, AlertTriangle } from "lucide-react";
import { PhotoUploader } from "@/components/ui/PhotoUploader";
import { SmartLocationField } from "@/components/report/SmartLocationField";
import { ReporterDetailsField } from "@/components/report/ReporterDetailsField";
import { ReportReview } from "@/components/report/ReportReview";
import { ReportProgress } from "@/components/report/ReportProgress";
import { categoryLabels, categoryIcons, categoryOrder } from "@/lib/categories";
import { createReport } from "@/lib/actions/reports";
import { isValidReporterName, isValidIndianMobile, formatIndianMobile } from "@/lib/validators";
import { cn } from "@/lib/utils";
import type { CivicLocation, ProblemCategory, Profile } from "@/lib/types";

interface FieldErrors {
  location?: string;
  description?: string;
  category?: string;
  reporterName?: string;
  reporterMobile?: string;
}

export function ReportForm({ profile }: { profile: Profile }) {
  const router = useRouter();

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<ProblemCategory | null>(null);
  const [location, setLocation] = useState<CivicLocation | null>(null);
  const [reporterName, setReporterName] = useState(profile.full_name ?? "");
  const [reporterMobile, setReporterMobile] = useState(profile.mobile_number ?? "");

  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ id: string; title: string } | null>(null);
  const [step, setStep] = useState<"form" | "review">("form");

  function handleSelectPhoto(f: File) {
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
  }

  function handleRemovePhoto() {
    setFile(null);
    setPreviewUrl(null);
  }

  function handleLocationChange(loc: CivicLocation | null) {
    setLocation(loc);
    if (loc) setErrors((prev) => ({ ...prev, location: undefined }));
  }

  function handleReporterNameChange(next: string) {
    setReporterName(next);
    setErrors((prev) => ({ ...prev, reporterName: undefined }));
  }

  function handleReporterMobileChange(next: string) {
    setReporterMobile(next);
    setErrors((prev) => ({ ...prev, reporterMobile: undefined }));
  }

  function handleContinueToReview(e: React.FormEvent) {
    e.preventDefault();

    const nextErrors: FieldErrors = {};
    if (!description.trim()) nextErrors.description = "Please describe the problem.";
    if (!category) nextErrors.category = "Please select a problem category.";
    if (!location) nextErrors.location = "Please select a location so AI can route this report.";
    if (!isValidReporterName(reporterName)) nextErrors.reporterName = "Please enter your name.";
    if (!isValidIndianMobile(reporterMobile))
      nextErrors.reporterMobile = "Please enter a valid 10-digit mobile number.";

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    setStep("review");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleEditReport() {
    setStep("form");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submitReport(options: { confirmDuplicate?: boolean; duplicateOf?: string } = {}) {
    setSubmitting(true);
    setSubmitError(null);

    const fd = new FormData();
    fd.set("description", description.trim());
    fd.set("category", category as ProblemCategory);
    fd.set("location", JSON.stringify(location));
    fd.set("reporterName", reporterName.trim());
    fd.set("reporterMobile", formatIndianMobile(reporterMobile));
    if (file) fd.set("photo", file);
    if (options.confirmDuplicate) {
      fd.set("confirmDuplicate", "true");
      if (options.duplicateOf) fd.set("duplicateOf", options.duplicateOf);
    }

    const result = await createReport({ status: "idle" }, fd);

    if (result.status === "error") {
      setSubmitting(false);
      setSubmitError(result.error);
      return;
    }
    if (result.status === "duplicate") {
      setSubmitting(false);
      setDuplicate({ id: result.duplicateReportId, title: result.duplicateTitle });
      return;
    }
    if (result.status !== "success") return;
    router.push(`/report/analysis?reportId=${result.reportId}`);
  }

  async function handleConfirmAnalyze() {
    await submitReport();
  }

  return (
    <div className="bg-surface-muted">
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to home
        </Link>

        <div className="mt-6">
          <span className="text-sm font-semibold text-civic-700">Report a Problem</span>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
            {step === "review" ? "Review your report" : "What's the issue?"}
          </h1>
          <p className="mt-1 text-sm text-foreground-muted">
            {step === "review"
              ? "Check everything looks right before AI analyzes it."
              : "Add a photo and a few details — AI will analyze it and route it to the right department."}
          </p>
          <div className="mt-4">
            <ReportProgress current={step === "review" ? 1 : 0} />
          </div>
        </div>

        {step === "review" && location ? (
          <div className="mt-8">
            {duplicate && (
              <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-priority-medium/30 bg-priority-medium-bg p-5">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-priority-medium" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-semibold text-foreground">Possible duplicate issue</p>
                    <p className="mt-1 text-sm text-foreground-muted">
                      A similar report already exists nearby: <strong>&ldquo;{duplicate.title}&rdquo;</strong>. You
                      can view it, or submit this as a new report anyway.
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/reports/${duplicate.id}`}
                    className="rounded-full border border-border bg-white px-4 py-2 text-xs font-medium text-foreground hover:border-civic-300"
                  >
                    View existing report
                  </Link>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => submitReport({ confirmDuplicate: true, duplicateOf: duplicate.id })}
                    className="rounded-full bg-civic-600 px-4 py-2 text-xs font-medium text-white hover:bg-civic-700 disabled:opacity-60"
                  >
                    Submit anyway
                  </button>
                  <button
                    type="button"
                    onClick={() => setDuplicate(null)}
                    className="rounded-full px-4 py-2 text-xs font-medium text-foreground-muted hover:bg-white"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {submitError && (
              <p className="mb-4 rounded-xl bg-priority-critical-bg px-4 py-2.5 text-sm text-priority-critical">
                {submitError}
              </p>
            )}
            <ReportReview
              previewUrl={previewUrl}
              description={description.trim()}
              category={category as ProblemCategory}
              location={location}
              reporterName={reporterName.trim()}
              reporterMobile={formatIndianMobile(reporterMobile)}
              onEdit={handleEditReport}
              onConfirm={handleConfirmAnalyze}
              submitting={submitting}
            />
          </div>
        ) : (
          <form onSubmit={handleContinueToReview} className="mt-8 flex flex-col gap-8">
            <section className="rounded-2xl border border-border bg-white p-6">
              <h2 className="text-sm font-semibold text-foreground">Photo</h2>
              <p className="mt-1 text-xs text-foreground-muted">
                A clear photo helps AI assess the issue accurately. Optional, but recommended.
              </p>
              <div className="mt-4">
                <PhotoUploader previewUrl={previewUrl} onSelect={handleSelectPhoto} onRemove={handleRemovePhoto} />
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-white p-6">
              <h2 className="text-sm font-semibold text-foreground">Problem Description</h2>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                placeholder="Describe the civic problem... e.g. There's a large pothole in the middle of the road that's been growing after the rain."
                className="mt-3 w-full rounded-xl border border-border bg-surface-muted/40 px-4 py-3 text-sm leading-relaxed text-foreground placeholder:text-foreground-muted/70 focus-visible:border-civic-400"
              />
              {errors.description && <p className="mt-1.5 text-xs font-medium text-priority-critical">{errors.description}</p>}
            </section>

            <section className="rounded-2xl border border-border bg-white p-6">
              <h2 className="text-sm font-semibold text-foreground">Problem Category</h2>
              <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {categoryOrder.map((cat) => {
                  const Icon = categoryIcons[cat];
                  const selected = category === cat;
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setCategory(cat)}
                      className={cn(
                        "flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-xs font-medium transition",
                        selected
                          ? "border-civic-400 bg-civic-50 text-civic-700"
                          : "border-border bg-surface-muted/40 text-foreground hover:border-civic-200",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {categoryLabels[cat]}
                    </button>
                  );
                })}
              </div>
              {errors.category && <p className="mt-2 text-xs font-medium text-priority-critical">{errors.category}</p>}
            </section>

            <SmartLocationField value={location} onChange={handleLocationChange} error={errors.location} />

            <ReporterDetailsField
              name={reporterName}
              mobile={reporterMobile}
              onNameChange={handleReporterNameChange}
              onMobileChange={handleReporterMobileChange}
              nameError={errors.reporterName}
              mobileError={errors.reporterMobile}
            />

            <section className="flex items-start gap-3 rounded-2xl border border-civic-200 bg-civic-50 p-5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-civic-600 text-white">
                <Sparkles className="h-4.5 w-4.5" aria-hidden="true" />
              </span>
              <div>
                <p className="text-sm font-semibold text-civic-800">Priority will be assessed by AI</p>
                <p className="mt-1 text-xs text-civic-700">
                  You don&apos;t need to set a priority — AI reads the photo and description to score
                  severity automatically.
                </p>
              </div>
            </section>

            <button
              type="submit"
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-civic-600 px-6 py-3.5 text-base font-medium text-white shadow-sm transition-all hover:bg-civic-700 sm:w-auto sm:self-center sm:px-10"
            >
              Continue to Review
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
