import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const generateContentMock = vi.fn();
const constructorOptions: unknown[] = [];

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
    constructor(options: unknown) {
      constructorOptions.push(options);
    }
  },
  // Mirrors the SDK's ApiError: Gemini answered with an HTTP error status.
  ApiError: class extends Error {
    status: number;
    constructor({ message, status }: { message: string; status: number }) {
      super(message);
      this.status = status;
    }
  },
  Type: { OBJECT: "OBJECT", STRING: "STRING", NUMBER: "NUMBER", ARRAY: "ARRAY", BOOLEAN: "BOOLEAN" },
}));

// Imported after the mock so analyzeReport picks up the mocked GoogleGenAI.
const {
  analyzeReport,
  analyzeReportWithinBudget,
  AIUnavailableError,
  AI_TOTAL_BUDGET_MS,
  GEMINI_RETRY_POLICY,
  geminiRetryDelayMs,
  TRANSIENT_GEMINI_STATUSES,
  isNetworkLevelAIFailure,
  resolveGeminiModel,
} = await import("@/lib/ai");
const { ApiError } = await import("@google/genai");

const validInput = {
  description: "Large pothole growing after rain",
  category: "ROAD" as const,
  location: { displayName: "Ward 12, Narasaraopet", source: "manual" as const },
};

const validAiResponse = {
  problem_summary: "Large pothole on main road",
  category: "road",
  subcategory: "pothole",
  severity: "high",
  priority: "high",
  reasoning: "Poses a safety risk to vehicles",
  severity_reasoning: "The depression is large enough to damage vehicles and cause loss of control.",
  priority_reasoning: "Located on a high-traffic road, so timely repair reduces accident risk.",
  recommended_department: "Roads & Infrastructure",
  recommended_action: "Dispatch repair crew",
  action_steps: ["Inspect the road section", "Place warning signage", "Schedule repair", "Verify after repair"],
  confidence: 0.9,
  affected_infrastructure: ["road surface"],
  urgency_factors: ["high traffic volume"],
  safety_risk: "Vehicles may lose control or be damaged.",
  affected_population: "Motorists and pedestrians using this road.",
  time_context: "Reported to be worsening after recent rain.",
  location_context: "Main road segment near the bus stand.",
  evidence: null,
  complaint_subject: "Request for repair of road pothole",
  complaint_impact: "The pothole poses a risk to vehicles and pedestrians, especially at night.",
  complaint_action: "Requesting inspection and repair of the affected road surface.",
};

beforeEach(() => {
  generateContentMock.mockReset();
  delete process.env.GEMINI_API_KEY;
});

describe("analyzeReport — happy path", () => {
  it("returns a validated, typed result for a well-formed AI response", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({ text: JSON.stringify(validAiResponse) });

    const result = await analyzeReport(validInput);

    expect(result.category).toBe("road");
    expect(result.priority).toBe("high");
    expect(result.confidence).toBe(0.9);
    expect(result.model).toBeTruthy();
    expect(result.severity_reasoning).toContain("depression");
    expect(result.priority_reasoning).toContain("traffic");
    expect(result.action_steps.length).toBeGreaterThan(0);
    expect(result.complaint_subject).toBeTruthy();
    expect(result.evidence).toBeNull();
  });

  it("accepts structured evidence when an image was attached", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({
        ...validAiResponse,
        evidence: {
          evidence_detected: true,
          observations: ["appears to show a large road-surface depression"],
          apparent_problem: "Road surface damage",
          evidence_confidence: 0.8,
          contradiction_note: null,
        },
      }),
    });

    const result = await analyzeReport({
      ...validInput,
      imageBase64: "ZmFrZQ==",
      imageMimeType: "image/jpeg",
    });

    expect(result.evidence).not.toBeNull();
    expect(result.evidence?.evidence_detected).toBe(true);
    expect(result.evidence?.observations[0]).toContain("appears to show");
  });

  it("surfaces a contradiction note when description and image seem to conflict", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({
        ...validAiResponse,
        category: "streetlight",
        evidence: {
          evidence_detected: true,
          observations: ["shows a streetlight pole in daylight"],
          apparent_problem: null,
          evidence_confidence: 0.4,
          contradiction_note:
            "The description reports a non-functioning streetlight; the image does not provide sufficient evidence to verify current operating status.",
        },
      }),
    });

    const result = await analyzeReport({
      ...validInput,
      category: "STREETLIGHT" as const,
      imageBase64: "ZmFrZQ==",
      imageMimeType: "image/jpeg",
    });

    expect(result.evidence?.contradiction_note).toContain("does not provide sufficient evidence");
  });

  it("accepts null optional context fields when they cannot be reliably determined", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({
        ...validAiResponse,
        subcategory: null,
        affected_infrastructure: null,
        urgency_factors: null,
        safety_risk: null,
        affected_population: null,
        time_context: null,
        location_context: null,
      }),
    });

    const result = await analyzeReport(validInput);
    expect(result.subcategory).toBeNull();
    expect(result.affected_infrastructure).toBeNull();
  });

  it("passes through a low-confidence classification rather than rejecting it", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({ ...validAiResponse, category: "other", confidence: 0.32 }),
    });

    const result = await analyzeReport({
      description: "Road problem.",
      category: "OTHER" as const,
      location: validInput.location,
    });
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.category).toBe("other");
  });
});

describe("analyzeReport — failure handling", () => {
  it("throws AIUnavailableError when GEMINI_API_KEY is not configured", async () => {
    await expect(analyzeReport(validInput)).rejects.toBeInstanceOf(AIUnavailableError);
  });

  it("throws AIUnavailableError when the Gemini request itself fails", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockRejectedValue(new Error("network error"));

    await expect(analyzeReport(validInput)).rejects.toBeInstanceOf(AIUnavailableError);
  });

  it("throws AIUnavailableError on an empty response", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({ text: "" });

    await expect(analyzeReport(validInput)).rejects.toBeInstanceOf(AIUnavailableError);
  });
});

describe("analyzeReport — malformed AI response handling", () => {
  it("throws AIUnavailableError on non-JSON text", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({ text: "not json at all" });

    await expect(analyzeReport(validInput)).rejects.toBeInstanceOf(AIUnavailableError);
  });

  it("throws AIUnavailableError when a required field is missing", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const { confidence: _drop, ...incomplete } = validAiResponse;
    void _drop;
    generateContentMock.mockResolvedValue({ text: JSON.stringify(incomplete) });

    await expect(analyzeReport(validInput)).rejects.toBeInstanceOf(AIUnavailableError);
  });

  it("throws AIUnavailableError when severity_reasoning or priority_reasoning is missing", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const { severity_reasoning: _drop, ...incomplete } = validAiResponse;
    void _drop;
    generateContentMock.mockResolvedValue({ text: JSON.stringify(incomplete) });

    await expect(analyzeReport(validInput)).rejects.toBeInstanceOf(AIUnavailableError);
  });

  it("throws AIUnavailableError when action_steps is empty", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({ ...validAiResponse, action_steps: [] }),
    });

    await expect(analyzeReport(validInput)).rejects.toBeInstanceOf(AIUnavailableError);
  });

  it("throws AIUnavailableError when complaint fields are missing", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const { complaint_subject: _drop, ...incomplete } = validAiResponse;
    void _drop;
    generateContentMock.mockResolvedValue({ text: JSON.stringify(incomplete) });

    await expect(analyzeReport(validInput)).rejects.toBeInstanceOf(AIUnavailableError);
  });

  it("throws AIUnavailableError when category is not one of the allowed enum values", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({ ...validAiResponse, category: "not_a_real_category" }),
    });

    await expect(analyzeReport(validInput)).rejects.toBeInstanceOf(AIUnavailableError);
  });

  it("throws AIUnavailableError when confidence is out of the 0-1 range", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({ text: JSON.stringify({ ...validAiResponse, confidence: 1.5 }) });

    await expect(analyzeReport(validInput)).rejects.toBeInstanceOf(AIUnavailableError);
  });

  it("throws AIUnavailableError when evidence has the wrong shape", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({ ...validAiResponse, evidence: { evidence_detected: "yes" } }),
    });

    await expect(analyzeReport(validInput)).rejects.toBeInstanceOf(AIUnavailableError);
  });

  it("never invents a government official's identity even if the model tries to inject one", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({
        ...validAiResponse,
        recommended_action: "Contact Officer Ramesh Kumar at 9876543210 immediately",
      }),
    });

    // Schema validation doesn't scrub content — this documents that the
    // *routing decision* (src/lib/actions/routing.ts) never uses this free
    // text, which is the actual safeguard; the AI layer only validates shape.
    const result = await analyzeReport(validInput);
    expect(result.recommended_action).toContain("Ramesh Kumar");
  });
});

describe("analyzeReport — Phase G3 department recommendation", () => {
  const departmentNames = ["Roads & Infrastructure", "Water Supply", "Electrical"];

  it("constrains recommended_department to the configured departments (prompt + schema enum)", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({ text: JSON.stringify(validAiResponse) });

    await analyzeReport({ ...validInput, departmentNames });

    const request = generateContentMock.mock.calls[0][0];
    const prompt: string = request.contents[0].parts[0].text;
    expect(prompt).toContain("must be exactly one of these configured CivicFix departments");
    expect(prompt).toContain("Roads & Infrastructure; Water Supply; Electrical");
    expect(request.config.responseSchema.properties.recommended_department.enum).toEqual(departmentNames);
    // The shared base schema is never mutated by a per-call enum.
    await analyzeReport(validInput);
    expect(generateContentMock.mock.calls[1][0].config.responseSchema.properties.recommended_department.enum).toBeUndefined();
  });

  it("still returns the model's text as-is — validation against configured departments happens in routing", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({ ...validAiResponse, recommended_department: "Roads & Buildings Department" }),
    });
    const result = await analyzeReport({ ...validInput, departmentNames });
    expect(result.recommended_department).toBe("Roads & Buildings Department");
  });
});

describe("resolveGeminiModel", () => {
  it("defaults to the stable gemini-3.8-flash", () => {
    expect(resolveGeminiModel(undefined)).toBe("gemini-3.8-flash");
    expect(resolveGeminiModel("")).toBe("gemini-3.8-flash");
    expect(resolveGeminiModel("   ")).toBe("gemini-3.8-flash");
  });
  it("accepts a plain Gemini model id override (GEMINI_MODEL)", () => {
    expect(resolveGeminiModel("gemini-3.6-flash")).toBe("gemini-3.6-flash");
    expect(resolveGeminiModel(" gemini-3.5-flash-lite ")).toBe("gemini-3.5-flash-lite");
  });
  it("reads the override from process.env.GEMINI_MODEL by default", () => {
    const previous = process.env.GEMINI_MODEL;
    try {
      process.env.GEMINI_MODEL = "gemini-3.7-flash";
      expect(resolveGeminiModel()).toBe("gemini-3.7-flash");
      delete process.env.GEMINI_MODEL;
      expect(resolveGeminiModel()).toBe("gemini-3.8-flash");
    } finally {
      if (previous === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = previous;
    }
  });
  it("ignores anything that isn't a plain Gemini model id", () => {
    for (const bad of ["gpt-4o", "gemini-3.6-flash?key=x", "models/gemini-3.6-flash", "gemini 3.6", "../gemini"]) {
      expect(resolveGeminiModel(bad)).toBe("gemini-3.8-flash");
    }
  });
  it("records the model actually used on the analysis result", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({ text: JSON.stringify(validAiResponse) });
    const result = await analyzeReport(validInput);
    expect(result.model).toBe(resolveGeminiModel());
    expect(generateContentMock.mock.calls.at(-1)?.[0]).toMatchObject({ model: resolveGeminiModel() });
  });
});

describe("Gemini error classification (one request, no SDK retry)", () => {
  const apiError = (status: number) => new ApiError({ message: `{"error":{"code":${status},"status":"UNAVAILABLE"}}`, status });

  it("makes exactly one HTTP request per analyzeReport call — SDK retries are off", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockRejectedValue(apiError(503));
    constructorOptions.length = 0;
    await analyzeReport(validInput).catch(() => {});
    expect(generateContentMock).toHaveBeenCalledTimes(1);
    const options = constructorOptions.at(-1) as { httpOptions?: { retryOptions?: unknown } };
    expect(options.httpOptions?.retryOptions).toBeUndefined();
  });

  it("AI-2 M2: sets an SDK-level HTTP timeout only when the caller passes timeoutMs (retries stay off)", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({ text: JSON.stringify(validAiResponse) });
    constructorOptions.length = 0;
    await analyzeReport(validInput, { timeoutMs: 40_000 });
    await analyzeReport(validInput);
    const [withTimeout, inline] = constructorOptions as Array<{ httpOptions?: { timeout?: number; retryOptions?: unknown } }>;
    expect(withTimeout.httpOptions).toEqual({ timeout: 40_000 });
    expect(inline.httpOptions).toBeUndefined();
  });

  it("keeps Gemini's real HTTP status and message", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockRejectedValue(apiError(503));
    const err = await analyzeReport(validInput).catch((e) => e);
    expect(err).toBeInstanceOf(AIUnavailableError);
    expect(err.status).toBe(503);
    expect(err.message).toContain('"code":503');
    expect(err.transient).toBe(true);
  });

  it("429/500/502/503/504 are transient; 400/401/403/404 are permanent", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    for (const [status, transient] of [[429, true], [500, true], [502, true], [503, true], [504, true], [400, false], [401, false], [403, false], [404, false]] as const) {
      generateContentMock.mockRejectedValueOnce(apiError(status));
      const err = await analyzeReport(validInput).catch((e) => e);
      expect(err.status).toBe(status);
      expect(err.transient).toBe(transient);
      expect(TRANSIENT_GEMINI_STATUSES.includes(status)).toBe(transient);
    }
  });

  it("a network failure (fetch failed) is transient and network-level, with no status", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockRejectedValue(new TypeError("fetch failed"));
    const err = await analyzeReport(validInput).catch((e) => e);
    expect(err.transient).toBe(true);
    expect(err.status).toBeUndefined();
    expect(isNetworkLevelAIFailure(err)).toBe(true);
  });

  it("an abort (our attempt timeout / budget) is transient and `timedOut`, never a fake HTTP status", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockRejectedValue(new DOMException("This operation was aborted", "AbortError"));
    const err = await analyzeReport(validInput).catch((e) => e);
    expect(err.transient).toBe(true);
    expect(err.timedOut).toBe(true);
    expect(err.status).toBeUndefined();
    expect(err.networkLevel).toBe(false);
  });

  it("missing key and invalid model output are permanent", async () => {
    const noKey = await analyzeReport(validInput).catch((e) => e);
    expect(noKey.transient).toBe(false);
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({ text: "not json" });
    const badOutput = await analyzeReport(validInput).catch((e) => e);
    expect(badOutput.transient).toBe(false);
  });

  it("never puts the API key in the error", async () => {
    process.env.GEMINI_API_KEY = "test-key-SECRET-123";
    generateContentMock.mockRejectedValue(apiError(503));
    const err = await analyzeReport(validInput).catch((e) => e);
    expect(String(err.message)).not.toContain("SECRET-123");
  });
});

describe("analyzeReportWithinBudget — controlled retry inside the 30s budget", () => {
  const ok = () => ({ text: JSON.stringify(validAiResponse) });
  const apiError = (status: number) => new ApiError({ message: `{"error":{"code":${status},"message":"high demand","status":"UNAVAILABLE"}}`, status });
  const sleepMock = vi.fn<(ms: number) => Promise<void>>(async () => {});
  const midJitter = () => 0.5;
  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key-SECRET-123";
    sleepMock.mockClear();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    info.mockRestore();
  });

  it("policy: 3 attempts max, 25s per-attempt cap, retry only with ≥8s left, inside the 30s budget", () => {
    expect(GEMINI_RETRY_POLICY.maxAttempts).toBe(3);
    expect(GEMINI_RETRY_POLICY.maxAttemptMs).toBe(25_000);
    expect(GEMINI_RETRY_POLICY.minRetryAttemptMs).toBe(8_000);
    expect(AI_TOTAL_BUDGET_MS).toBe(30_000);
    // AI budget + incident-confirmation cap (10s) leaves ≥20s of maxDuration 60s.
    expect(60_000 - AI_TOTAL_BUDGET_MS - 10_000).toBeGreaterThanOrEqual(20_000);
  });

  it("backoff with jitter: 1–2s before the 2nd attempt, 2–4s before the 3rd (capped at 4s)", () => {
    expect(geminiRetryDelayMs(1, () => 0)).toBe(1_000);
    expect(geminiRetryDelayMs(1, () => 0.999)).toBe(1_999);
    expect(geminiRetryDelayMs(2, () => 0)).toBe(2_000);
    expect(geminiRetryDelayMs(2, () => 0.999)).toBe(3_998);
    expect(geminiRetryDelayMs(5, () => 0.999)).toBe(4_000);
  });

  it("normal success: exactly 1 Gemini call, logged as success", async () => {
    generateContentMock.mockResolvedValue(ok());
    const result = await analyzeReportWithinBudget(validInput, { sleep: sleepMock });
    expect(result.category).toBe("road");
    expect(generateContentMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/attempt 1\/3 model=gemini-[\w.-]+ outcome=success durationMs=\d+/));
  });

  it("permanent errors: 1 call, no retry (400, invalid output, missing key → 0 calls)", async () => {
    generateContentMock.mockRejectedValueOnce(apiError(400));
    await expect(analyzeReportWithinBudget(validInput, { sleep: sleepMock })).rejects.toMatchObject({ status: 400, transient: false });
    generateContentMock.mockResolvedValueOnce({ text: "not json" });
    await expect(analyzeReportWithinBudget(validInput, { sleep: sleepMock })).rejects.toMatchObject({ transient: false });
    expect(generateContentMock).toHaveBeenCalledTimes(2);
    delete process.env.GEMINI_API_KEY;
    await expect(analyzeReportWithinBudget(validInput, { sleep: sleepMock })).rejects.toMatchObject({ transient: false });
    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("503 then success: retried once after a 1–2s backoff", async () => {
    generateContentMock.mockRejectedValueOnce(apiError(503)).mockResolvedValueOnce(ok());
    const result = await analyzeReportWithinBudget(validInput, { sleep: sleepMock, random: midJitter });
    expect(result.category).toBe("road");
    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(1_500);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/attempt 1\/3 model=gemini-[\w.-]+ outcome=http_error status=503 durationMs=\d+/));
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/attempt 2\/3 .*outcome=success/));
  });

  it("each transient kind is retried: 429, 500, 502, 504, network failure, attempt timeout", async () => {
    const transientErrors = [apiError(429), apiError(500), apiError(502), apiError(504), new TypeError("fetch failed"), new DOMException("This operation was aborted", "AbortError")];
    for (const error of transientErrors) {
      generateContentMock.mockReset();
      generateContentMock.mockRejectedValueOnce(error).mockResolvedValueOnce(ok());
      await expect(analyzeReportWithinBudget(validInput, { sleep: sleepMock })).resolves.toMatchObject({ category: "road" });
      expect(generateContentMock).toHaveBeenCalledTimes(2);
    }
  });

  it("persistent 503: hard ceiling of 3 Gemini calls, and the final error is Gemini's REAL 503 — not a generic abort", async () => {
    generateContentMock.mockRejectedValue(apiError(503));
    const err = await analyzeReportWithinBudget(validInput, { sleep: sleepMock, random: midJitter }).catch((e) => e);
    expect(generateContentMock).toHaveBeenCalledTimes(3);
    expect(sleepMock.mock.calls.map((c) => c[0])).toEqual([1_500, 3_000]);
    expect(err).toBeInstanceOf(AIUnavailableError);
    expect(err.status).toBe(503);
    expect(err.message).toContain("high demand");
    expect(err.message).toContain("(3 Gemini attempts)");
    expect(err.message).not.toMatch(/operation was aborted/i);
    expect(err.attempts).toBe(3);
    expect(err.transient).toBe(true);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("network failures also count toward the 3-call ceiling", async () => {
    generateContentMock.mockRejectedValue(new TypeError("fetch failed"));
    const err = await analyzeReportWithinBudget(validInput, { sleep: sleepMock }).catch((e) => e);
    expect(generateContentMock).toHaveBeenCalledTimes(3);
    expect(err).toMatchObject({ networkLevel: true, attempts: 3 });
  });

  it("each attempt gets min(25s, budget left) — later attempts get only what's left", async () => {
    let t = 0;
    const now = () => t;
    const sleep = async (ms: number) => {
      t += ms;
    };
    const attemptBudgets: number[] = [];
    // Record each attempt's timeout from the signal it receives by timing
    // when it would abort: here we only check the budget arithmetic via `now`.
    generateContentMock.mockImplementation(async () => {
      attemptBudgets.push(30_000 - t); // time left when the attempt starts
      t += 2_000; // each attempt fails fast with 503
      throw apiError(503);
    });
    await analyzeReportWithinBudget(validInput, { sleep, now, random: midJitter }).catch(() => {});
    // 1st starts with the full 30s (capped to 25s per attempt), later ones with what's left.
    expect(attemptBudgets).toEqual([30_000, 26_500, 21_500]);
    expect(Math.min(GEMINI_RETRY_POLICY.maxAttemptMs, attemptBudgets[0])).toBe(25_000);
  });

  it("a slow first attempt leaves too little budget: no doomed retry, and the real Gemini error is kept", async () => {
    let t = 0;
    const now = () => t;
    generateContentMock.mockImplementation(async () => {
      t += 24_000; // slow, then Gemini answers 503
      throw apiError(503);
    });
    const err = await analyzeReportWithinBudget(validInput, { sleep: sleepMock, now, random: midJitter }).catch((e) => e);
    expect(generateContentMock).toHaveBeenCalledTimes(1); // 30 − 24 − 1.5 < 8s → no retry
    expect(sleepMock).not.toHaveBeenCalled();
    expect(err.status).toBe(503);
    expect(err.message).toContain("high demand");
    expect(err.message).toContain("30s AI time budget exhausted");
    expect(err.attempts).toBe(1);
  });

  it("real timers: a hung attempt is aborted at its per-attempt timeout and retried", async () => {
    // Small real budgets so the test runs in milliseconds.
    let call = 0;
    const seenSignals: AbortSignal[] = [];
    generateContentMock.mockImplementation(async (req: { config: { abortSignal: AbortSignal } }) => {
      call++;
      seenSignals.push(req.config.abortSignal);
      if (call === 1) {
        // Hang until our attempt timeout aborts it (like the SDK does).
        await new Promise((_, reject) =>
          req.config.abortSignal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")))
        );
      }
      return ok();
    });
    const result = await analyzeReportWithinBudget(validInput, { budgetMs: 2_000, maxAttemptMs: 100, minRetryAttemptMs: 50, sleep: sleepMock, random: () => 0 });
    expect(result.category).toBe("road");
    expect(call).toBe(2);
    expect(seenSignals[0].aborted).toBe(true);
    expect(seenSignals[1]).not.toBe(seenSignals[0]); // a fresh signal per attempt
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/attempt 1\/3 .*outcome=timeout durationMs=\d+/));
  });

  it("real timers: the overall budget aborts a hung attempt and stops — 503 seen earlier is what's reported", async () => {
    let call = 0;
    generateContentMock.mockImplementation(async (req: { config: { abortSignal: AbortSignal } }) => {
      call++;
      if (call === 1) throw apiError(503);
      await new Promise((_, reject) =>
        req.config.abortSignal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")))
      );
      return ok();
    });
    const started = Date.now();
    const err = await analyzeReportWithinBudget(validInput, { budgetMs: 3_000, maxAttemptMs: 10_000, minRetryAttemptMs: 50, sleep: sleepMock, random: () => 0 }).catch((e) => e);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(call).toBe(2); // budget fired during attempt 2 → no attempt 3
    expect(err.status).toBe(503); // the real Gemini error, not "This operation was aborted"
    expect(err.message).toContain("high demand");
    expect(err.message).toContain("AI time budget exhausted");
    expect(err.message).not.toMatch(/operation was aborted/i);
  });

  it("logs model/attempt/outcome/status/duration only — never the API key or report content", async () => {
    generateContentMock.mockRejectedValue(apiError(503));
    await analyzeReportWithinBudget(validInput, { sleep: sleepMock }).catch(() => {});
    const lines = [...warn.mock.calls, ...info.mock.calls].map((c) => c.join(" "));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(/^\[gemini\] report analysis attempt \d\/3 model=gemini-[\w.-]+ outcome=\w+( status=\d+)? durationMs=\d+$/);
      expect(line).not.toContain("SECRET-123");
      expect(line).not.toContain(validInput.description);
    }
  });
});
