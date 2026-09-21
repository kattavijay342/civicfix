import "server-only";
import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";
import { AIUnavailableError } from "@/lib/ai";
import type { AreaOverview, AgingBuckets, ResolutionQuality, CategoryTrend, DepartmentWorkload } from "@/lib/data/government";

const MODEL = "gemini-3.6-flash";

/**
 * Phase 6E — AI-grounded government insights. Unlike src/lib/ai.ts's
 * per-report analysis, this NEVER receives raw report titles/descriptions
 * or any PII — only a small, flat object of already-computed real numbers
 * (§17/§18 of the spec: "Do not give AI uncontrolled raw sensitive data
 * unnecessarily"). Every insight the model returns is cross-validated
 * against that exact same object before being shown; anything that doesn't
 * match is dropped, never displayed ("prefer the database, suppress the AI
 * claim").
 */
/** Gemini's structured-output mode (a subset of OpenAPI schema) doesn't
 * reliably support an OBJECT with unknown/dynamic keys, so the model
 * returns supporting metrics as an array of {metric, value} pairs instead
 * of a free-form object — converted to a Record right after parsing,
 * before any validation happens. */
const metricPairSchema = z.object({ metric: z.string().min(1), value: z.number() });

export const insightSchema = z.object({
  insight_type: z.enum(["workload", "risk", "trend", "category", "geographic"]),
  title: z.string().min(1).max(100),
  summary: z.string().min(1).max(400),
  supporting_metrics: z.array(metricPairSchema).min(1).max(8),
  confidence: z.number().min(0).max(1),
});

const insightsResponseSchema = z.object({
  insights: z.array(insightSchema).max(6),
});

export type GovernmentAIInsight = z.infer<typeof insightSchema>;

/** The shape actually shown/consumed by the rest of the app — same as
 * GovernmentAIInsight but with supporting_metrics flattened to a Record,
 * which is what validateInsightsAgainstMetrics compares against the real
 * metrics object. */
export interface ValidatedGovernmentInsight {
  insightType: GovernmentAIInsight["insight_type"];
  title: string;
  summary: string;
  supportingMetrics: Record<string, number>;
  confidence: number;
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    insights: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          insight_type: { type: Type.STRING, enum: ["workload", "risk", "trend", "category", "geographic"] },
          title: { type: Type.STRING },
          summary: { type: Type.STRING },
          supporting_metrics: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                metric: { type: Type.STRING },
                value: { type: Type.NUMBER },
              },
              required: ["metric", "value"],
            },
          },
          confidence: { type: Type.NUMBER },
        },
        required: ["insight_type", "title", "summary", "supporting_metrics", "confidence"],
      },
    },
  },
  required: ["insights"],
} as const;

/**
 * Flattens the already-computed, already-real dashboard aggregates into a
 * single flat metrics map — the ONLY thing the AI ever sees. Pure and
 * exported so it's directly unit-testable without a live Gemini call.
 */
export function buildGovernmentMetricsSnapshot(input: {
  overview: AreaOverview;
  aging: AgingBuckets | null;
  quality: ResolutionQuality | null;
  categories: CategoryTrend[];
  workload: DepartmentWorkload[];
}): Record<string, number> {
  const metrics: Record<string, number> = {
    total_issues: input.overview.totalIssues,
    resolved: input.overview.resolved,
    pending: input.overview.pending,
    critical: input.overview.critical,
    resolution_rate: input.overview.resolutionRate,
  };

  if (input.aging) {
    metrics.aging_0_1_days = input.aging["0_1"];
    metrics.aging_2_3_days = input.aging["2_3"];
    metrics.aging_4_7_days = input.aging["4_7"];
    metrics.aging_8_14_days = input.aging["8_14"];
    metrics.aging_15_30_days = input.aging["15_30"];
    metrics.aging_30_plus_days = input.aging["30_plus"];
  }

  if (input.quality) {
    metrics.resolution_quality_resolved = input.quality.resolved;
    metrics.resolution_quality_citizen_confirmed = input.quality.citizenConfirmed;
    metrics.resolution_quality_confirmation_pending = input.quality.confirmationPending;
    metrics.resolution_quality_currently_reopened = input.quality.currentlyReopened;
    metrics.resolution_quality_reopened_percentage = input.quality.reopenedPercentage;
  }

  for (const c of input.categories) {
    metrics[`category_${c.category.toLowerCase()}`] = c.count;
  }

  for (const d of input.workload) {
    const key = d.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    metrics[`department_${key}_active`] = d.activeIssues;
    metrics[`department_${key}_reopened`] = d.currentlyReopened;
    metrics[`department_${key}_awaiting_acknowledgement`] = d.awaitingAcknowledgement;
  }

  return metrics;
}

/**
 * Rejects any insight whose supporting_metrics don't exactly match the real
 * metrics object — same key, same value — or that cites no real metric at
 * all. This is the actual enforcement of "if the AI contradicts the
 * database, prefer the database and suppress the AI claim" (spec §18):
 * the model can only ever restate numbers it was given, never invent or
 * misquote one. Also flattens the {metric,value}[] pairs into the Record
 * the rest of the app consumes.
 */
export function validateInsightsAgainstMetrics(
  insights: GovernmentAIInsight[],
  realMetrics: Record<string, number>
): ValidatedGovernmentInsight[] {
  const validated: ValidatedGovernmentInsight[] = [];
  for (const insight of insights) {
    if (insight.supporting_metrics.length === 0) continue;
    const allMatch = insight.supporting_metrics.every((pair) => realMetrics[pair.metric] === pair.value);
    if (!allMatch) continue;
    validated.push({
      insightType: insight.insight_type,
      title: insight.title,
      summary: insight.summary,
      supportingMetrics: Object.fromEntries(insight.supporting_metrics.map((p) => [p.metric, p.value])),
      confidence: insight.confidence,
    });
  }
  return validated;
}

function buildPrompt(metrics: Record<string, number>): string {
  return [
    "You are summarizing REAL, already-computed operational metrics for a government civic-issue dashboard.",
    "You will receive a JSON object of metric names to numbers. That object is the ONLY source of truth.",
    "",
    "Metrics:",
    JSON.stringify(metrics, null, 2),
    "",
    "Rules (violating any of these makes your response unusable):",
    "- Every insight's \"supporting_metrics\" must be a list of one or more {metric, value} pairs COPIED EXACTLY from the metrics above — same key spelling, same numeric value. Never alter, round, combine, or invent a metric.",
    "- Never reference a metric key that isn't in the object above.",
    "- Never invent government officials, departments not implied by a \"department_*\" key, deadlines, policy decisions, causes, or political conclusions.",
    "- Never rank departments as \"best\" or \"worst\" or make any political/partisan judgment.",
    "- \"confidence\" must reflect how strongly the cited numbers actually support the claim — a single data point deserves a lower confidence than a clear, large gap.",
    "- If nothing in the metrics is notable enough to summarize, return an empty \"insights\" array — never fabricate a filler insight.",
    "- Return at most 6 insights.",
  ].join("\n");
}

/**
 * Calls Gemini with ONLY the structured metrics snapshot, validates the
 * response shape with Zod, then cross-validates every insight's numbers
 * against the real metrics object. Throws AIUnavailableError (same class
 * src/lib/ai.ts uses) on any failure — missing key, network error, invalid
 * JSON, or a response that fails schema validation — so callers can catch
 * it and fall back to the existing deterministic insights exactly as they
 * already do for AI analysis failures elsewhere in this app.
 */
export async function generateGovernmentAIInsights(metrics: Record<string, number>): Promise<ValidatedGovernmentInsight[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AIUnavailableError("GEMINI_API_KEY is not configured.");
  }

  const ai = new GoogleGenAI({ apiKey });

  let text: string | undefined;
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: buildPrompt(metrics) }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });
    text = response.text;
  } catch (err) {
    throw new AIUnavailableError(err instanceof Error ? err.message : "Gemini request failed.");
  }

  if (!text) {
    throw new AIUnavailableError("AI returned an empty response.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AIUnavailableError("AI returned a non-JSON response.");
  }

  const result = insightsResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new AIUnavailableError(`AI response failed validation: ${result.error.issues.map((i) => i.message).join("; ")}`);
  }

  return validateInsightsAgainstMetrics(result.data.insights, metrics);
}
