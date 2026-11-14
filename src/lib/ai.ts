import "server-only";
import { ApiError, GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";
import type { CivicLocation, ProblemCategory } from "./types";
import { categoryLabels } from "./categories";
import { dbCategoryValues, dbPriorityValues, dbSeverityValues } from "./db-enums";
import { locationOneLine } from "./location-format";

/** Thrown for any AI failure — missing key, network/API error, or a
 * response that fails schema/enum validation. Callers show the fixed
 * message from Step 20 ("AI analysis is temporarily unavailable.") and a
 * manual retry action, never a raw stack trace.
 *
 * `status` is the Gemini HTTP status when the API answered with an error
 * (e.g. 503 "model is experiencing high demand"); `transient` marks failures
 * worth retrying (429/5xx, no HTTP response, or an attempt timeout) as
 * opposed to permanent ones (missing key, 4xx request errors, invalid model
 * output). */
export class AIUnavailableError extends Error {
  readonly status?: number;
  readonly transient: boolean;
  /** No HTTP response at all (Node's `TypeError: fetch failed`). */
  readonly networkLevel: boolean;
  /** The request was aborted by our own per-attempt timeout or the overall
   * AI budget (see analyzeReportWithinBudget) — not an error from Gemini. */
  readonly timedOut: boolean;
  /** How many Gemini requests were made before giving up (set by
   * analyzeReportWithinBudget on its final error). */
  readonly attempts?: number;
  constructor(
    message: string,
    options: { status?: number; transient?: boolean; networkLevel?: boolean; timedOut?: boolean; attempts?: number } = {}
  ) {
    super(message);
    this.name = "AIUnavailableError";
    this.status = options.status;
    this.transient = options.transient ?? false;
    this.networkLevel = options.networkLevel ?? false;
    this.timedOut = options.timedOut ?? false;
    this.attempts = options.attempts;
  }
}

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

/** Google's current recommended stable Gemini Flash model (listed as Stable
 * with no shutdown date on Google's models/deprecations pages as of
 * 2026-10). A 503 "high demand" from it is temporary capacity pressure on
 * Google's side, handled by analyzeReportWithinBudget below — never faked
 * as success.
 * GEMINI_MODEL (server-only env) can override it without a code change;
 * anything that isn't a plain Gemini model id is ignored. */
const DEFAULT_MODEL = "gemini-3.8-flash";

export function resolveGeminiModel(override = process.env.GEMINI_MODEL): string {
  const value = override?.trim();
  return value && /^gemini-[a-z0-9.-]{1,60}$/.test(value) ? value : DEFAULT_MODEL;
}

/** HTTP statuses Google documents as retryable for the Gemini API
 * (429 RESOURCE_EXHAUSTED, 503 UNAVAILABLE) plus the other transient 5xx. */
export const TRANSIENT_GEMINI_STATUSES = [429, 500, 502, 503, 504];

/**
 * The ONLY retry layer for report analysis (analyzeReportWithinBudget).
 * The SDK's own retry is deliberately off: it can't see our time budget,
 * and when the budget aborts it throws away Gemini's real error.
 *   - maxAttempts: hard ceiling on Gemini calls per analysis (incl. the first).
 *   - backoff before retry n (n = 1, 2): round((1 + jitter) × initialDelayMs
 *     × 2^(n-1)), capped at maxDelayMs, jitter ∈ [0, 1) → 1–2s, then 2–4s
 *     (exponential backoff + jitter, as Google recommends).
 *   - maxAttemptMs: cap on one attempt; each attempt actually gets
 *     min(maxAttemptMs, time left in the budget), so a slow-but-valid
 *     response can finish and no attempt can outlive the budget.
 *   - minRetryAttemptMs: a retry is only started if at least this much
 *     budget remains after its backoff — never a doomed last-second call.
 */
export const GEMINI_RETRY_POLICY = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 4_000,
  maxAttemptMs: 25_000,
  minRetryAttemptMs: 8_000,
} as const;

/** Backoff (ms) before retry number `retry` (1 = before the 2nd attempt). */
export function geminiRetryDelayMs(retry: number, random: () => number = Math.random): number {
  const { initialDelayMs, maxDelayMs } = GEMINI_RETRY_POLICY;
  return Math.min(maxDelayMs, Math.round((1 + random()) * initialDelayMs * 2 ** (retry - 1)));
}

/** An abort of the in-flight request — our per-attempt timeout or the
 * overall budget firing (the SDK surfaces it as a DOMException named
 * AbortError, "This operation was aborted"). */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** Maps a thrown Gemini/SDK error to AIUnavailableError, keeping the HTTP
 * status and Gemini's own message. Never includes the API key (it isn't in
 * any of these errors).
 *   - ApiError: Gemini answered with an HTTP error — transient for
 *     429/500/502/503/504, permanent otherwise.
 *   - abort: our attempt timeout / budget fired — transient, `timedOut`.
 *   - TypeError (`fetch failed`): no HTTP response — transient, `networkLevel`.
 *   - anything else: transient (an unexpected transport failure). */
export function toAIUnavailableError(err: unknown): AIUnavailableError {
  if (err instanceof ApiError) {
    return new AIUnavailableError(err.message, { status: err.status, transient: TRANSIENT_GEMINI_STATUSES.includes(err.status) });
  }
  if (isAbortError(err)) {
    return new AIUnavailableError("Gemini request timed out.", { transient: true, timedOut: true });
  }
  const message = err instanceof Error ? err.message : "Gemini request failed.";
  return new AIUnavailableError(message, { transient: true, networkLevel: err instanceof TypeError });
}

/** True for a network-level failure (no HTTP response at all). */
export function isNetworkLevelAIFailure(err: unknown): boolean {
  return err instanceof AIUnavailableError && err.networkLevel;
}

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

/** When the configured department names are known, Gemini's structured
 * output is constrained to exactly those names (an enum), so the
 * recommendation is directly resolvable. The server still re-validates it
 * against the `departments` table (src/lib/routing.ts) — the enum is a
 * quality aid, not the trust boundary. */
function responseSchemaFor(departmentNames: string[]) {
  if (departmentNames.length === 0) return RESPONSE_SCHEMA;
  return {
    ...RESPONSE_SCHEMA,
    properties: {
      ...RESPONSE_SCHEMA.properties,
      recommended_department: { type: Type.STRING, enum: departmentNames },
    },
  };
}

/** Shared "do not invent" ground rules, centralized so they appear exactly
 * once instead of being copy-pasted across prompt sections (Step "AI
 * prompt quality"). */
const INTEGRITY_RULES = [
  "- Do not invent any government official's name, title, badge number, or contact information anywhere in your response.",
  "- \"recommended_department\" names a department, never a person, office, address, or phone number. It is a recommendation: CivicFix validates it against its own configured departments before any routing.",
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
  departmentNames: string[];
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
    input.departmentNames.length > 0
      ? "- \"recommended_department\" must be exactly one of these configured CivicFix departments: " +
        input.departmentNames.join("; ") +
        ". Pick the one responsible for the problem you classified in \"category\"."
      : "- \"recommended_department\" is the name of the municipal department best suited to handle the problem.",
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
  /** Configured department names (the `departments` table). */
  departmentNames?: string[];
}, options: {
  /** Aborts this ONE Gemini request — analyzeReportWithinBudget passes the
   * per-attempt timeout combined with the overall AI budget. */
  signal?: AbortSignal;
  /** Optional SDK-level HTTP timeout (ms) — the AI-2 background worker sets
   * it alongside `signal` so the request is bounded even if an abort were
   * not honoured. Inline callers don't pass it (behaviour unchanged). */
  timeoutMs?: number;
} = {}): Promise<AIAnalysisResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AIUnavailableError("GEMINI_API_KEY is not configured.");
  }

  // Exactly one HTTP request per call: no SDK retryOptions (the SDK only
  // retries when they're set) — retries live in analyzeReportWithinBudget.
  const ai = new GoogleGenAI(
    options.timeoutMs !== undefined ? { apiKey, httpOptions: { timeout: options.timeoutMs } } : { apiKey }
  );
  const model = resolveGeminiModel();
  const departmentNames = input.departmentNames ?? [];

  const parts: Array<Record<string, unknown>> = [
    { text: buildPrompt({ ...input, hasImage: Boolean(input.imageBase64), departmentNames }) },
  ];
  if (input.imageBase64 && input.imageMimeType) {
    parts.push({ inlineData: { mimeType: input.imageMimeType, data: input.imageBase64 } });
  }

  let text: string | undefined;
  try {
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchemaFor(departmentNames),
        ...(options.signal ? { abortSignal: options.signal } : {}),
      },
    });
    text = response.text;
  } catch (err) {
    throw toAIUnavailableError(err);
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

  return { ...result.data, model };
}

/** Total time (ms) one report's AI analysis may take, across every attempt
 * and backoff wait. Server Actions that run this declare maxDuration = 60
 * on their page; this leaves the rest for upload, DB writes, routing,
 * notifications and incident linking (whose own Gemini call is capped at
 * 10s — src/lib/incident-ai-confirm.ts). */
export const AI_TOTAL_BUDGET_MS = 30_000;

type AttemptOutcome = "success" | "http_error" | "timeout" | "network_error" | "invalid_response" | "not_configured" | "error";

function outcomeOf(err: AIUnavailableError): AttemptOutcome {
  if (err.status !== undefined) return "http_error";
  if (err.timedOut) return "timeout";
  if (err.networkLevel) return "network_error";
  if (/GEMINI_API_KEY/.test(err.message)) return "not_configured";
  if (!err.transient) return "invalid_response";
  return "error";
}

/** One structured line per Gemini attempt: model, attempt, outcome, HTTP
 * status, duration. Never the API key, the prompt, or the report content. */
function logAttempt(entry: { model: string; attempt: number; outcome: AttemptOutcome; status?: number; durationMs: number }) {
  const line = `[gemini] report analysis attempt ${entry.attempt}/${GEMINI_RETRY_POLICY.maxAttempts} model=${entry.model} outcome=${entry.outcome}${
    entry.status !== undefined ? ` status=${entry.status}` : ""
  } durationMs=${entry.durationMs}`;
  if (entry.outcome === "success") console.info(line);
  else console.warn(line);
}

/**
 * One AI analysis for one report, inside a hard time budget, with exactly
 * ONE retry layer (this loop — the SDK's own retry is off):
 *   - normal success: exactly 1 Gemini call;
 *   - permanent error (missing key, 4xx other than 429, empty/invalid
 *     output): 1 call, no retry;
 *   - transient error (HTTP 429/500/502/503/504, network failure with no
 *     HTTP response, or an attempt timeout): retried with backoff (1–2s,
 *     then 2–4s), at most GEMINI_RETRY_POLICY.maxAttempts = 3 calls total;
 *   - each attempt's timeout = min(25s, time left in the budget); a retry is
 *     only started if ≥ 8s of budget remains after its backoff.
 * The whole thing never exceeds `budgetMs`. When it gives up, the error
 * carries the REAL last Gemini HTTP status and message (e.g. 503 "high
 * demand") rather than a generic abort, plus how many attempts were made.
 * Every attempt is logged (logAttempt). Callers treat any throw as "AI
 * unavailable": the report stays `reported` and retryable.
 */
export async function analyzeReportWithinBudget(
  input: Parameters<typeof analyzeReport>[0],
  deps: {
    budgetMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** Jitter source in [0, 1) — injectable for tests. */
    random?: () => number;
    /** Overrides of GEMINI_RETRY_POLICY's time limits — for tests. */
    maxAttemptMs?: number;
    minRetryAttemptMs?: number;
  } = {}
): Promise<AIAnalysisResult> {
  const budgetMs = deps.budgetMs ?? AI_TOTAL_BUDGET_MS;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;
  const maxAttemptMs = deps.maxAttemptMs ?? GEMINI_RETRY_POLICY.maxAttemptMs;
  const minRetryAttemptMs = deps.minRetryAttemptMs ?? GEMINI_RETRY_POLICY.minRetryAttemptMs;
  const model = resolveGeminiModel();

  const deadline = now() + budgetMs;
  const budgetSignal = AbortSignal.timeout(budgetMs);

  let attempts = 0;
  let lastError: AIUnavailableError | null = null;
  /** The most recent error Gemini itself returned (has an HTTP status). */
  let lastGeminiError: AIUnavailableError | null = null;
  let budgetExhausted = false;

  for (let attempt = 1; attempt <= GEMINI_RETRY_POLICY.maxAttempts; attempt++) {
    if (attempt > 1) {
      const delay = geminiRetryDelayMs(attempt - 1, random);
      if (deadline - now() - delay < minRetryAttemptMs) {
        budgetExhausted = true;
        break;
      }
      await sleep(delay);
    }

    const attemptMs = Math.min(maxAttemptMs, deadline - now());
    if (attemptMs <= 0 || budgetSignal.aborted) {
      budgetExhausted = true;
      break;
    }

    attempts = attempt;
    const startedAt = now();
    try {
      const result = await analyzeReport(input, { signal: AbortSignal.any([budgetSignal, AbortSignal.timeout(attemptMs)]) });
      logAttempt({ model, attempt, outcome: "success", durationMs: now() - startedAt });
      return result;
    } catch (err) {
      const error = err instanceof AIUnavailableError ? err : toAIUnavailableError(err);
      logAttempt({ model, attempt, outcome: outcomeOf(error), status: error.status, durationMs: now() - startedAt });
      if (!error.transient) throw error; // permanent: never retried
      lastError = error;
      if (error.status !== undefined) lastGeminiError = error;
      if (budgetSignal.aborted) {
        budgetExhausted = true;
        break;
      }
    }
  }

  // Give up — surface the REAL Gemini error when there was one.
  const cause = lastGeminiError ?? lastError ?? new AIUnavailableError("AI analysis failed.", { transient: true });
  const suffix = `(${attempts} Gemini attempt${attempts === 1 ? "" : "s"}${budgetExhausted ? `; ${Math.round(budgetMs / 1000)}s AI time budget exhausted` : ""})`;
  throw new AIUnavailableError(`${cause.message} ${suffix}`, {
    status: cause.status,
    transient: true,
    networkLevel: cause.networkLevel,
    timedOut: cause.timedOut,
    attempts,
  });
}
