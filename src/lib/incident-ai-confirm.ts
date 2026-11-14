import "server-only";
import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";

/** Thrown for any failure — missing key, network/API error, invalid
 * response. Callers (src/lib/incident-detection.ts) always catch this and
 * fall back to the deterministic "candidate" classification — this module
 * is a best-effort semantic assist, never a requirement for the app to
 * keep working (spec §6: "if Gemini is unavailable... the application MUST
 * continue working"). */
export class IncidentAIUnavailableError extends Error {
  /** Sanitized failure category, so the AI-2 incident worker can decide
   * retry vs. permanent without parsing messages:
   *   http (with `status`), timeout, network, invalid_output,
   *   not_configured, unknown. */
  readonly kind: "http" | "timeout" | "network" | "invalid_output" | "not_configured" | "unknown";
  /** Gemini's HTTP status when it answered with an error. */
  readonly status?: number;
  constructor(
    message: string,
    details: { kind?: IncidentAIUnavailableError["kind"]; status?: number } = {}
  ) {
    super(message);
    this.name = "IncidentAIUnavailableError";
    this.kind = details.kind ?? "unknown";
    this.status = details.status;
  }
}

/** Unchanged model for incident confirmation (switching it needs separate
 * approval); exported so the AI-2 worker can record it on its job row. */
export const INCIDENT_CONFIRM_MODEL = "gemini-3.6-flash";
const MODEL = INCIDENT_CONFIRM_MODEL;

/** Inline (legacy) timeout. The AI-2 worker passes its own, longer one. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Maps an SDK/transport failure to a sanitized category — duck-typed (an
 * HTTP error from @google/genai carries a numeric `status`). */
function classifyTransportError(err: unknown): IncidentAIUnavailableError {
  const e = err as { status?: unknown; name?: unknown } | null;
  if (e && typeof e.status === "number" && e.status >= 100 && e.status <= 599) {
    return new IncidentAIUnavailableError(`Gemini HTTP ${e.status}`, { kind: "http", status: e.status });
  }
  if (e && (e.name === "AbortError" || e.name === "TimeoutError")) {
    return new IncidentAIUnavailableError("Gemini request timed out.", { kind: "timeout" });
  }
  if (err instanceof TypeError) {
    return new IncidentAIUnavailableError("Gemini request failed (network).", { kind: "network" });
  }
  return new IncidentAIUnavailableError(err instanceof Error ? err.message : "Gemini request failed.", { kind: "unknown" });
}

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
}, options: {
  /** Aborts this one request — the AI-2 worker passes its 90s budget. */
  signal?: AbortSignal;
  /** SDK-level request timeout; defaults to the legacy inline 10s. */
  timeoutMs?: number;
} = {}): Promise<IncidentConfirmation> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new IncidentAIUnavailableError("GEMINI_API_KEY is not configured.", { kind: "not_configured" });
  }

  // One attempt. Inline callers keep the original 10s cap; the AI-2
  // background worker (src/lib/incident-jobs.ts) passes a longer timeout
  // and its own abort signal. Any failure is an IncidentAIUnavailableError,
  // which incident-detection already treats as "no AI confirmation".
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS } });

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
        ...(options.signal ? { abortSignal: options.signal } : {}),
      },
    });
    text = response.text;
  } catch (err) {
    throw classifyTransportError(err);
  }

  if (!text) {
    throw new IncidentAIUnavailableError("AI returned an empty response.", { kind: "invalid_output" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new IncidentAIUnavailableError("AI returned a non-JSON response.", { kind: "invalid_output" });
  }

  const result = confirmationSchema.safeParse(parsed);
  if (!result.success) {
    throw new IncidentAIUnavailableError(
      `AI response failed validation: ${result.error.issues.map((i) => i.message).join("; ")}`,
      { kind: "invalid_output" }
    );
  }

  return result.data;
}
