import "server-only";
import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";

/** Thrown for any failure — missing key, network/API error, invalid
 * response. Callers (src/lib/incident-detection.ts) always catch this and
 * fall back to the deterministic "candidate" classification — this module
 * is a best-effort semantic assist, never a requirement for the app to
 * keep working (spec §6: "if Gemini is unavailable... the application MUST
 * continue working"). */
export class IncidentAIUnavailableError extends Error {}

const MODEL = "gemini-3.6-flash";

const confirmationSchema = z.object({
  same_incident: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(300),
});

export type IncidentConfirmation = z.infer<typeof confirmationSchema>;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    same_incident: { type: Type.BOOLEAN },
    confidence: { type: Type.NUMBER },
    reasoning: { type: Type.STRING },
  },
  required: ["same_incident", "confidence", "reasoning"],
} as const;

/**
 * ONE small, structured Gemini call asking whether two citizen reports
 * plausibly describe the SAME real-world civic problem — used only for the
 * deterministic "ambiguous band" (src/lib/incident-detection.ts's
 * AI_CONFIRM_MIN/MAX), never on every report (spec §6). Input is exactly
 * the same category of free text (category/description/area labels) this
 * app already sends to Gemini for src/lib/ai.ts's analyzeReport() — no new
 * privacy surface, no PII beyond what the citizen already submitted, and
 * never a specific official's name/contact info (same INTEGRITY_RULES
 * spirit as ai.ts).
 */
export async function confirmSameIncident(input: {
  reportA: { category: string; description: string; areaLabel: string };
  reportB: { category: string; description: string; areaLabel: string };
  distanceMeters: number | null;
  daysApart: number;
}): Promise<IncidentConfirmation> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new IncidentAIUnavailableError("GEMINI_API_KEY is not configured.");
  }

  const ai = new GoogleGenAI({ apiKey });

  const prompt = [
    "You are helping a civic-issue platform decide whether two separately-submitted citizen reports describe the SAME real-world physical problem (e.g. the same pothole, the same broken streetlight) rather than two different problems that merely happen to be nearby or in the same category.",
    "Return ONLY the requested JSON.",
    "",
    `Report A — category: ${input.reportA.category}; area: ${input.reportA.areaLabel}; description: ${input.reportA.description}`,
    `Report B — category: ${input.reportB.category}; area: ${input.reportB.areaLabel}; description: ${input.reportB.description}`,
    `Approximate distance between them: ${input.distanceMeters != null ? `${Math.round(input.distanceMeters)} meters` : "unknown (no GPS coordinates on at least one report)"}.`,
    `Reported ${input.daysApart} day(s) apart.`,
    "",
    "Rules:",
    "- Judge ONLY from the text given above — do not invent facts, official names, dates, or measurements not stated here.",
    "- \"same_incident\" should be true only if the descriptions plausibly refer to the same physical problem in the same specific location, not merely the same general category of problem in the same general area.",
    "- If you are not confident, set a lower \"confidence\" rather than presenting a guess as certain.",
    "- \"reasoning\" is one short, factual sentence citing which details agree or disagree.",
  ].join("\n");

  let text: string | undefined;
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });
    text = response.text;
  } catch (err) {
    throw new IncidentAIUnavailableError(err instanceof Error ? err.message : "Gemini request failed.");
  }

  if (!text) {
    throw new IncidentAIUnavailableError("AI returned an empty response.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new IncidentAIUnavailableError("AI returned a non-JSON response.");
  }

  const result = confirmationSchema.safeParse(parsed);
  if (!result.success) {
    throw new IncidentAIUnavailableError(
      `AI response failed validation: ${result.error.issues.map((i) => i.message).join("; ")}`
    );
  }

  return result.data;
}
