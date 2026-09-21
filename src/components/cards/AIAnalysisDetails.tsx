import { AlertTriangle } from "lucide-react";
import type { ReportAiAnalysis } from "@/lib/data/report-detail";

/**
 * Shared "extras" block for an AI-analyzed report — the Phase 6A fields
 * that live in `ai_analyses.extended` (see src/lib/ai.ts). Used by both
 * /report/analysis (right after submission) and /reports/[id] (persistent
 * detail view) so the two views can't drift apart. Renders nothing extra
 * for a pre-Phase-6A report (`extended` is null) beyond the low-confidence
 * banner, which is derived from the always-present `confidence` field.
 */
export function AIAnalysisDetails({ aiAnalysis }: { aiAnalysis: ReportAiAnalysis }) {
  const ext = aiAnalysis.extended;
  const lowConfidence = aiAnalysis.confidence < 0.5;

  return (
    <>
      {lowConfidence && (
        <div className="flex items-start gap-2 rounded-xl border border-priority-medium/30 bg-priority-medium-bg px-3.5 py-2.5 text-xs text-priority-medium">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            AI is not fully confident about this classification — treat it as a starting point for review, not a
            final answer.
          </span>
        </div>
      )}

      {ext?.subcategory && (
        <p className="text-xs text-foreground-muted">
          <span className="font-medium text-foreground">Subcategory:</span> {ext.subcategory}
        </p>
      )}

      <div className="border-t border-border pt-4">
        <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">Why this severity?</span>
        <p className="mt-1.5 text-sm leading-relaxed text-foreground-muted">
          {ext?.severity_reasoning ?? aiAnalysis.reasoning}
        </p>
      </div>

      <div className="border-t border-border pt-4">
        <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">Why this priority?</span>
        <p className="mt-1.5 text-sm leading-relaxed text-foreground-muted">
          {ext?.priority_reasoning ?? aiAnalysis.reasoning}
        </p>
      </div>

      {ext?.evidence?.evidence_detected && (
        <div className="border-t border-border pt-4">
          <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
            Evidence Observed in Photo
          </span>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-sm text-foreground-muted">
            {ext.evidence.observations.map((observation) => (
              <li key={observation}>{observation}</li>
            ))}
          </ul>
          {ext.evidence.contradiction_note && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-priority-medium">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {ext.evidence.contradiction_note}
            </p>
          )}
        </div>
      )}

      {ext?.action_steps && ext.action_steps.length > 0 && (
        <div className="border-t border-border pt-4">
          <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
            Recommended Next Steps
          </span>
          <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-sm text-foreground-muted">
            {ext.action_steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}
