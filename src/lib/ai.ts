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

const analysisSchema = z.object({
  problem_summary: z.string().min(1).max(500),
  category: z.enum(dbCategoryValues),
  severity: z.enum(dbSeverityValues),
  priority: z.enum(dbPriorityValues),
  reasoning: z.string().min(1).max(1000),
  recommended_department: z.string().min(1).max(200),
  recommended_action: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
});

export type AIAnalysisResult = z.infer<typeof analysisSchema> & { model: string };

const MODEL = "gemini-3.6-flash";

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    problem_summary: { type: Type.STRING },
    category: { type: Type.STRING, enum: dbCategoryValues },
    severity: { type: Type.STRING, enum: dbSeverityValues },
    priority: { type: Type.STRING, enum: dbPriorityValues },
    reasoning: { type: Type.STRING },
    recommended_department: { type: Type.STRING },
    recommended_action: { type: Type.STRING },
    confidence: { type: Type.NUMBER },
  },
  required: [
    "problem_summary",
    "category",
    "severity",
    "priority",
    "reasoning",
    "recommended_department",
    "recommended_action",
    "confidence",
  ],
} as const;

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
      ? "An evidence photo is attached — factor in what it visually shows."
      : "No photo was attached.",
    "",
    "Rules:",
    '- "category" must be one of: ' + dbCategoryValues.join(", ") + " (map the citizen's category/description to the closest one).",
    '- "severity" and "priority" must each be one of: ' + dbSeverityValues.join(", ") + ".",
    "- \"recommended_department\" is an informational suggestion only (e.g. \"Roads & Infrastructure\") — it is NEVER used to actually route the report, so do not invent a specific office, official name, phone number, or contact.",
    "- Do not invent any government official's name, title, or contact information anywhere in your response.",
    '- "confidence" is a number between 0 and 1.',
    "- Base severity/priority on genuine public safety and impact, not on alarmist language in the description.",
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
