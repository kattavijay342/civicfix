import "server-only";
import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";
import type { CivicLocation, ProblemCategory } from "./types";
import { categoryLabels } from "./categories";
import { dbCategoryValues, dbPriorityValues, dbSeverityValues } from "./db-enums";
import { locationOneLine } from "./location-format";

/** Thrown for any AI failure — missing key, network/API error, or a
 * response that fails schema/enum validation. Callers show the fixed
 * message from Step 20 ("AI analysis is temporarily unavailable.") and a
 * manual retry action, never a raw stack trace. */
export class AIUnavailableError extends Error {}

/**
 * Phase 6A — structured image evidence. Only meaningful when a photo was
 * actually attached (see buildPrompt): the model must return `null` when
 * there is no image, never fabricate observations from text alone. Every
 * field distinguishes what is OBSERVED in the photo from what the citizen
 * CLAIMED in their description — see the "evidence vs. claim" prompt rule.
 */
const evidenceSchema = z
  .object({
    evidence_detected: z.boolean(),
    observations: z.array(z.string().min(1).max(200)).max(8),
    apparent_problem: z.string().max(300).nullable(),
    evidence_confidence: z.number().min(0).max(1).nullable(),
    contradiction_note: z.string().max(300).nullable(),
  })
  .nullable();

const analysisSchema = z.object({
  problem_summary: z.string().min(1).max(500),
  category: z.enum(dbCategoryValues),
  subcategory: z.string().max(100).nullable(),
  severity: z.enum(dbSeverityValues),
  priority: z.enum(dbPriorityValues),
  reasoning: z.string().min(1).max(1000),
  severity_reasoning: z.string().min(1).max(500),
  priority_reasoning: z.string().min(1).max(500),
  recommended_department: z.string().min(1).max(200),
  recommended_action: z.string().min(1).max(500),
  action_steps: z.array(z.string().min(1).max(200)).min(1).max(6),
  confidence: z.number().min(0).max(1),
  affected_infrastructure: z.array(z.string().min(1).max(100)).max(10).nullable(),
  urgency_factors: z.array(z.string().min(1).max(150)).max(10).nullable(),
  safety_risk: z.string().max(300).nullable(),
  affected_population: z.string().max(200).nullable(),
  time_context: z.string().max(200).nullable(),
  location_context: z.string().max(200).nullable(),
  evidence: evidenceSchema,
  complaint_subject: z.string().min(1).max(150),
  complaint_impact: z.string().min(1).max(400),
  complaint_action: z.string().min(1).max(400),
});

export type AIAnalysisResult = z.infer<typeof analysisSchema> & { model: string };

/** The Phase 6A "extras" subset stored in `ai_analyses.extended` (the flat
 * legacy columns — severity/priority/reasoning/recommended_department/
 * recommended_action/confidence — are unaffected and read separately).
 * Exported so the read path (src/lib/data/report-detail.ts) re-validates
 * the JSONB blob with the same rules instead of trusting it blindly. */
export const aiAnalysisExtendedSchema = analysisSchema.pick({
  subcategory: true,
  severity_reasoning: true,
  priority_reasoning: true,
  action_steps: true,
  affected_infrastructure: true,
  urgency_factors: true,
  safety_risk: true,
  affected_population: true,
  time_context: true,
  location_context: true,
  evidence: true,
  complaint_subject: true,
  complaint_impact: true,
  complaint_action: true,
});

export type AIAnalysisExtended = z.infer<typeof aiAnalysisExtendedSchema>;

const MODEL = "gemini-3.6-flash";

/** Gemini structured-output schema mirroring `analysisSchema` above. Fields
 * that are `.nullable()` in the Zod schema get `nullable: true` here so the
 * model is explicitly allowed to return `null` instead of being forced to
 * invent a value (Step 6: prefer nullable over fabricated). */
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    problem_summary: { type: Type.STRING },
    category: { type: Type.STRING, enum: dbCategoryValues },
    subcategory: { type: Type.STRING, nullable: true },
    severity: { type: Type.STRING, enum: dbSeverityValues },
    priority: { type: Type.STRING, enum: dbPriorityValues },
    reasoning: { type: Type.STRING },
    severity_reasoning: { type: Type.STRING },
    priority_reasoning: { type: Type.STRING },
    recommended_department: { type: Type.STRING },
    recommended_action: { type: Type.STRING },
    action_steps: { type: Type.ARRAY, items: { type: Type.STRING } },
    confidence: { type: Type.NUMBER },
    affected_infrastructure: { type: Type.ARRAY, items: { type: Type.STRING }, nullable: true },
    urgency_factors: { type: Type.ARRAY, items: { type: Type.STRING }, nullable: true },
    safety_risk: { type: Type.STRING, nullable: true },
    affected_population: { type: Type.STRING, nullable: true },
    time_context: { type: Type.STRING, nullable: true },
    location_context: { type: Type.STRING, nullable: true },
    evidence: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        evidence_detected: { type: Type.BOOLEAN },
        observations: { type: Type.ARRAY, items: { type: Type.STRING } },
        apparent_problem: { type: Type.STRING, nullable: true },
        evidence_confidence: { type: Type.NUMBER, nullable: true },
        contradiction_note: { type: Type.STRING, nullable: true },
      },
      required: ["evidence_detected", "observations", "apparent_problem", "evidence_confidence", "contradiction_note"],
    },
    complaint_subject: { type: Type.STRING },
    complaint_impact: { type: Type.STRING },
    complaint_action: { type: Type.STRING },
  },
  required: [
    "problem_summary",
    "category",
    "subcategory",
    "severity",
    "priority",
    "reasoning",
    "severity_reasoning",
    "priority_reasoning",
    "recommended_department",
    "recommended_action",
    "action_steps",
    "confidence",
    "affected_infrastructure",
    "urgency_factors",
    "safety_risk",
    "affected_population",
    "time_context",
    "location_context",
    "evidence",
    "complaint_subject",
    "complaint_impact",
    "complaint_action",
  ],
} as const;

/** Shared "do not invent" ground rules, centralized so they appear exactly
 * once instead of being copy-pasted across prompt sections (Step "AI
 * prompt quality"). */
const INTEGRITY_RULES = [
  "- Do not invent any government official's name, title, badge number, or contact information anywhere in your response.",
  "- \"recommended_department\" is an informational suggestion only (e.g. \"Roads & Infrastructure\") — it is NEVER used to actually route the report, so do not invent a specific office, address, or phone number.",
  "- Never invent dates, measurements, incident history, or legal claims that were not provided to you.",
  "- Use ONLY the description, category, location, and image (if attached) given below — do not assume facts about the location or citizen that weren't stated.",
  "- If a field cannot be reliably determined from what was provided, return null for it rather than guessing.",
  "- If you are not confident in your classification, say so honestly with a lower \"confidence\" value rather than presenting a guess as certain.",
].join("\n");

function buildPrompt(input: {
  description: string;
  category: ProblemCategory;
  location: CivicLocation;
  hasImage: boolean;
}) {
  return [
    "You are a civic-issue triage assistant for CivicFix, a citizen issue-reporting platform in India.",
    "A citizen submitted the report below. Analyze it and return ONLY the requested JSON.",
    "",
    `Citizen-selected category: ${categoryLabels[input.category]}`,
    `Location: ${locationOneLine(input.location)}`,
    `Description: ${input.description}`,
    input.hasImage
      ? "An evidence photo is attached — analyze it for the \"evidence\" field."
      : "No photo was attached — set \"evidence\" to null entirely; do not fabricate visual observations.",
    "",
    "Classification rules:",
    '- "category" must be one of: ' + dbCategoryValues.join(", ") + " (map the citizen's category/description to the closest one; if none genuinely fits, use \"other\" with a lower confidence).",
    '- "subcategory" is an optional, more specific free-text label within that category (e.g. "streetlight" -> "pole not lighting" vs "flickering"), or null if not clearly determinable.',
    '- "severity" and "priority" must each be one of: ' + dbSeverityValues.join(", ") + ".",
    "- \"severity\" measures how serious/dangerous the underlying problem itself is. \"priority\" measures how urgently CivicFix should act — these are NOT the same thing (e.g. a cosmetic issue is low severity even if reported urgently; a dangerous pothole on a quiet lane may be high severity but only medium priority). Explain each separately in \"severity_reasoning\" and \"priority_reasoning\".",
    "- Base severity/priority on genuine public-safety and impact factors, not on alarmist language in the description.",
    '- "confidence" is a number between 0 and 1 reflecting how certain you are about the classification as a whole.',
    "",
    "Evidence rules (only relevant when a photo is attached):",
    "- Distinguish what is OBSERVED in the image from what the citizen CLAIMED in the description. Never state that the image \"proves\" or \"confirms\" something it only appears to show.",
    "- If the description and the image seem to conflict or the image cannot verify the claim, say so plainly in \"contradiction_note\" (e.g. \"the description reports a non-functioning streetlight; the image does not provide sufficient evidence to verify current operating status\"). Otherwise set it to null.",
    "- \"observations\" should be short, concrete, hedged phrases (e.g. \"appears to show a large road-surface depression\"), not certainties.",
    "",
    "Recommendations:",
    "- \"recommended_action\" is a single concise sentence.",
    "- \"action_steps\" is an ordered list of 2-4 short, practical next steps a department would take (inspect, temporary mitigation, repair, verify/close-out with evidence) — recommendations only, never phrased as already completed.",
    "",
    "Complaint letter fields (for a formal complaint document the citizen can submit):",
    "- \"complaint_subject\": a short, professional one-line subject.",
    "- \"complaint_impact\": 1-2 factual sentences on the impact of the problem, based only on the description/category/image — no invented statistics or incident counts.",
    "- \"complaint_action\": 1-2 factual sentences requesting the appropriate department take action — do not name a specific official or promise a timeline.",
    "",
    "Ground rules:",
    INTEGRITY_RULES,
  ].join("\n");
}

export async function analyzeReport(input: {
  description: string;
  category: ProblemCategory;
  location: CivicLocation;
  imageBase64?: string;
  imageMimeType?: string;
}): Promise<AIAnalysisResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AIUnavailableError("GEMINI_API_KEY is not configured.");
  }

  const ai = new GoogleGenAI({ apiKey });

  const parts: Array<Record<string, unknown>> = [
    { text: buildPrompt({ ...input, hasImage: Boolean(input.imageBase64) }) },
  ];
  if (input.imageBase64 && input.imageMimeType) {
    parts.push({ inlineData: { mimeType: input.imageMimeType, data: input.imageBase64 } });
  }

  let text: string | undefined;
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts }],
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });
    text = response.text;
  } catch (err) {
    throw new AIUnavailableError(
      err instanceof Error ? err.message : "Gemini request failed."
    );
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

  const result = analysisSchema.safeParse(parsed);
  if (!result.success) {
    throw new AIUnavailableError(
      `AI response failed validation: ${result.error.issues.map((i) => i.message).join("; ")}`
    );
  }

  return { ...result.data, model: MODEL };
}
