"use client";

import { useMemo, useState, type ReactNode } from "react";
import Image from "next/image";
import { Copy, Pencil, RefreshCw, Check, FileText, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

type Lang = "en" | "te";

export interface ComplaintFields {
  subject: string;
  description: string;
  location: string;
  impact: string;
  action: string;
}

const fieldLabels: Record<Lang, Record<keyof ComplaintFields, string>> = {
  en: {
    subject: "Subject",
    description: "Problem Description",
    location: "Location",
    impact: "Public Impact",
    action: "Requested Action",
  },
  te: {
    subject: "విషయం",
    description: "సమస్య వివరణ",
    location: "ప్రదేశం",
    impact: "ప్రజా ప్రభావం",
    action: "కోరిన చర్య",
  },
};

interface ComplaintDocumentProps {
  issueId: string;
  contentEn: ComplaintFields;
  contentTe: ComplaintFields;
  /** Full multi-line jurisdiction breakdown, shown behind a collapsible toggle under Location. */
  locationFullDetails?: string;
  imageSrc: string;
  imageAlt: string;
  footerNote?: string;
  descriptionNote?: string;
  afterActions?: ReactNode;
}

export function ComplaintDocument({
  issueId,
  contentEn,
  contentTe,
  locationFullDetails,
  imageSrc,
  imageAlt,
  footerNote = "Illustrative preview of the AI-generated complaint document — text is editable below, but generation itself is not yet connected to a live model.",
  descriptionNote,
  afterActions,
}: ComplaintDocumentProps) {
  const [lang, setLang] = useState<Lang>("en");
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState(contentEn);
  const [locationExpanded, setLocationExpanded] = useState(false);

  const active = lang === "en" ? contentEn : contentTe;
  const current = editing ? draft : active;

  const plainText = useMemo(() => {
    const labels = fieldLabels[lang];
    return [
      `${labels.subject}: ${current.subject}`,
      `${labels.description}: ${current.description}`,
      `${labels.location}: ${current.location}`,
      `${labels.impact}: ${current.impact}`,
      `${labels.action}: ${current.action}`,
    ].join("\n\n");
  }, [current, lang]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be blocked by the browser; fail silently.
    }
  }

  function handleLangSwitch(next: Lang) {
    setLang(next);
    setEditing(false);
    setDraft(next === "en" ? contentEn : contentTe);
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_18rem]">
      <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-[0_20px_50px_-28px_rgba(20,64,47,0.3)]">
        <div className="flex items-center gap-2 border-b border-border px-6 py-4">
          <FileText className="h-4 w-4 text-civic-700" aria-hidden="true" />
          <span className="text-sm font-semibold text-foreground">Official Complaint</span>
          <span className="ml-auto rounded-full bg-civic-50 px-2.5 py-1 text-[11px] font-semibold text-civic-700">
            {issueId}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-6 p-6 sm:grid-cols-[1fr_9rem]">
          <div className="space-y-5">
            {(Object.keys(fieldLabels.en) as (keyof ComplaintFields)[]).map((key) => (
              <div key={key}>
                <span className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
                  {fieldLabels[lang][key]}
                </span>
                {editing ? (
                  <textarea
                    value={draft[key]}
                    onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                    rows={key === "description" ? 3 : key === "location" ? 4 : 2}
                    className="mt-1.5 w-full rounded-lg border border-border bg-surface-muted/50 px-3 py-2 text-sm leading-relaxed text-foreground focus-visible:border-civic-400"
                    lang={lang}
                  />
                ) : (
                  <p
                    className={cn(
                      "mt-1.5 text-sm leading-relaxed text-foreground",
                      key === "location" && "whitespace-pre-line",
                    )}
                    lang={lang}
                  >
                    {current[key]}
                  </p>
                )}
                {key === "description" && descriptionNote && (
                  <p className="mt-1 text-[11px] italic text-foreground-muted">{descriptionNote}</p>
                )}
                {key === "location" && locationFullDetails && !editing && (
                  <div className="mt-1.5">
                    <button
                      type="button"
                      onClick={() => setLocationExpanded((v) => !v)}
                      className="flex items-center gap-1 text-xs font-medium text-civic-700 hover:underline"
                    >
                      {locationExpanded ? (
                        <ChevronUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="h-3 w-3" aria-hidden="true" />
                      )}
                      {locationExpanded ? "Hide full jurisdiction details" : "Show full jurisdiction details"}
                    </button>
                    {locationExpanded && (
                      <p className="mt-1.5 whitespace-pre-line text-xs leading-relaxed text-foreground-muted">
                        {locationFullDetails}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="relative h-28 overflow-hidden rounded-xl border border-border sm:h-full">
            <Image src={imageSrc} alt={imageAlt} fill sizes="144px" className="object-cover" />
            <span className="absolute bottom-1.5 left-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white">
              Evidence
            </span>
          </div>
        </div>

        <div className="border-t border-border bg-surface-muted/60 px-6 py-3">
          <p className="text-[11px] leading-relaxed text-foreground-muted">{footerNote}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-row gap-2 lg:flex-col">
          <button
            type="button"
            onClick={handleCopy}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-white px-4 py-2.5 text-sm font-medium text-foreground transition hover:border-civic-300 hover:bg-civic-50 lg:justify-start"
          >
            {copied ? (
              <Check className="h-4 w-4 text-civic-600" aria-hidden="true" />
            ) : (
              <Copy className="h-4 w-4" aria-hidden="true" />
            )}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition lg:justify-start",
              editing
                ? "border-civic-300 bg-civic-50 text-civic-700"
                : "border-border bg-white text-foreground hover:border-civic-300 hover:bg-civic-50",
            )}
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
            {editing ? "Done Editing" : "Edit"}
          </button>
          <button
            type="button"
            disabled
            title="Regeneration will connect to a live AI model in a later phase"
            className="flex flex-1 cursor-not-allowed items-center justify-center gap-2 rounded-xl border border-border bg-white px-4 py-2.5 text-sm font-medium text-foreground-muted opacity-60 lg:justify-start"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Regenerate
          </button>
        </div>

        <div className="mt-1 flex items-center gap-1 rounded-xl border border-border bg-white p-1 text-xs font-medium">
          <button
            type="button"
            onClick={() => handleLangSwitch("en")}
            className={cn(
              "flex-1 rounded-lg px-2 py-1.5 transition",
              lang === "en" ? "bg-civic-600 text-white" : "text-foreground-muted hover:bg-surface-muted",
            )}
          >
            English
          </button>
          <button
            type="button"
            onClick={() => handleLangSwitch("te")}
            className={cn(
              "flex-1 rounded-lg px-2 py-1.5 transition",
              lang === "te" ? "bg-civic-600 text-white" : "text-foreground-muted hover:bg-surface-muted",
            )}
          >
            తెలుగు
          </button>
        </div>

        {afterActions}
      </div>
    </div>
  );
}
