import { describe, it, expect, vi, beforeEach } from "vitest";

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
  GEMINI_RETRY,
  GEMINI_ATTEMPT_TIMEOUT_MS,
  AI_TOTAL_BUDGET_MS,
  NETWORK_RETRY_DELAY_MS,
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

describe("Gemini transient-error handling (503 high demand / 429)", () => {
  const apiError = (status: number) => new ApiError({ message: `{"error":{"code":${status}}}`, status });

  it("enables the SDK's own retry with exponential backoff, only for 429/5xx, at most 3 calls", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({ text: JSON.stringify(validAiResponse) });
    constructorOptions.length = 0;
    await analyzeReport(validInput);
    expect(constructorOptions.at(-1)).toMatchObject({ httpOptions: { retryOptions: GEMINI_RETRY } });
    expect(GEMINI_RETRY.attempts).toBe(3);
    expect(GEMINI_RETRY.initialDelay).toBe(1);
    expect(GEMINI_RETRY.jitter).toBeGreaterThan(0);
    expect(GEMINI_RETRY.httpStatusCodes).toEqual([429, 500, 502, 503, 504]);
    expect(GEMINI_RETRY.httpStatusCodes).not.toContain(400);
    expect(GEMINI_RETRY.httpStatusCodes).not.toContain(403);
  });

  it("a 503 that survives the SDK's retries becomes a transient AIUnavailableError with status 503 — not retried again by the app", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockRejectedValue(apiError(503));
    const err = await analyzeReport(validInput).catch((e) => e);
    expect(err).toBeInstanceOf(AIUnavailableError);
    expect(err.status).toBe(503);
    expect(err.transient).toBe(true);
    expect(isNetworkLevelAIFailure(err)).toBe(false);
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it("429 is transient; 400/403/404 are permanent", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    for (const [status, transient] of [[429, true], [400, false], [403, false], [404, false]] as const) {
      generateContentMock.mockRejectedValueOnce(apiError(status));
      const err = await analyzeReport(validInput).catch((e) => e);
      expect(err.status).toBe(status);
      expect(err.transient).toBe(transient);
      expect(TRANSIENT_GEMINI_STATUSES.includes(status)).toBe(transient);
    }
  });

  it("a failure with no HTTP response (network) is transient with no status — the one case the app retries once", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockRejectedValue(new TypeError("fetch failed"));
    const err = await analyzeReport(validInput).catch((e) => e);
    expect(err.transient).toBe(true);
    expect(err.status).toBeUndefined();
    expect(isNetworkLevelAIFailure(err)).toBe(true);
  });

  it("missing key and invalid model output are never transient (never retried)", async () => {
    const noKey = await analyzeReport(validInput).catch((e) => e);
    expect(noKey.transient).toBe(false);
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({ text: "not json" });
    const badOutput = await analyzeReport(validInput).catch((e) => e);
    expect(badOutput.transient).toBe(false);
    expect(isNetworkLevelAIFailure(badOutput)).toBe(false);
  });

  it("never puts the API key in the error", async () => {
    process.env.GEMINI_API_KEY = "test-key-SECRET-123";
    generateContentMock.mockRejectedValue(apiError(503));
    const err = await analyzeReport(validInput).catch((e) => e);
    expect(String(err.message)).not.toContain("SECRET-123");
  });
});

describe("resolveGeminiModel", () => {
  it("defaults to the stable gemini-3.6-flash", () => {
    expect(resolveGeminiModel(undefined)).toBe("gemini-3.6-flash");
    expect(resolveGeminiModel("")).toBe("gemini-3.6-flash");
  });
  it("accepts a plain Gemini model id override", () => {
    expect(resolveGeminiModel("gemini-3.8-flash")).toBe("gemini-3.8-flash");
    expect(resolveGeminiModel(" gemini-3.5-flash-lite ")).toBe("gemini-3.5-flash-lite");
  });
  it("ignores anything that isn't a plain Gemini model id", () => {
    for (const bad of ["gpt-4o", "gemini-3.6-flash?key=x", "models/gemini-3.6-flash", "gemini 3.6", "../gemini"]) {
      expect(resolveGeminiModel(bad)).toBe("gemini-3.6-flash");
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

describe("timeouts and the per-report time budget", () => {
  const noSleep = vi.fn(async () => {});
  const ok = () => ({ text: JSON.stringify(validAiResponse) });

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
    noSleep.mockClear();
  });

  it("caps every SDK attempt with a 20s HTTP timeout, alongside the transient-only retry", async () => {
    generateContentMock.mockResolvedValue(ok());
    constructorOptions.length = 0;
    await analyzeReport(validInput);
    expect(GEMINI_ATTEMPT_TIMEOUT_MS).toBe(20_000);
    expect(constructorOptions.at(-1)).toMatchObject({ httpOptions: { retryOptions: GEMINI_RETRY, timeout: 20_000 } });
  });

  it("passes the overall budget signal to Gemini so the SDK stops retrying when it fires", async () => {
    generateContentMock.mockResolvedValue(ok());
    const signal = new AbortController().signal;
    await analyzeReport(validInput, { signal });
    expect(generateContentMock.mock.calls.at(-1)?.[0].config.abortSignal).toBe(signal);
  });

  it("normal success: exactly one Gemini request", async () => {
    generateContentMock.mockResolvedValue(ok());
    await analyzeReportWithinBudget(validInput, { sleep: noSleep });
    expect(generateContentMock).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("permanent error (invalid output / 400): one request, no app retry", async () => {
    generateContentMock.mockResolvedValueOnce({ text: "not json" });
    await expect(analyzeReportWithinBudget(validInput, { sleep: noSleep })).rejects.toBeInstanceOf(AIUnavailableError);
    generateContentMock.mockRejectedValueOnce(new ApiError({ message: "bad request", status: 400 }));
    await expect(analyzeReportWithinBudget(validInput, { sleep: noSleep })).rejects.toMatchObject({ status: 400 });
    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("503/429 surviving the SDK's own retries is NOT retried again by the app (no double retry layer)", async () => {
    for (const status of [503, 429]) {
      generateContentMock.mockReset();
      generateContentMock.mockRejectedValue(new ApiError({ message: "high demand", status }));
      await expect(analyzeReportWithinBudget(validInput, { sleep: noSleep })).rejects.toMatchObject({ status, transient: true });
      // One SDK call from the app's point of view (the SDK's ≤3 internal attempts happen inside it).
      expect(generateContentMock).toHaveBeenCalledTimes(1);
    }
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("network-level failure (fetch failed): ONE app retry after 1s, then success", async () => {
    generateContentMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(ok());
    const result = await analyzeReportWithinBudget(validInput, { sleep: noSleep });
    expect(result.category).toBe("road");
    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenCalledWith(NETWORK_RETRY_DELAY_MS);
    // Both attempts share the same overall budget signal.
    const [first, second] = generateContentMock.mock.calls.map((c) => c[0].config.abortSignal);
    expect(first).toBeInstanceOf(AbortSignal);
    expect(second).toBe(first);
  });

  it("network-level failure twice: still only two app-level requests (never more)", async () => {
    generateContentMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(analyzeReportWithinBudget(validInput, { sleep: noSleep })).rejects.toMatchObject({ networkLevel: true });
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("skips the network retry when a full attempt no longer fits in the budget", async () => {
    let t = 0;
    const now = () => t;
    generateContentMock.mockImplementation(async () => {
      t += AI_TOTAL_BUDGET_MS - GEMINI_ATTEMPT_TIMEOUT_MS; // the first attempt used most of the budget
      throw new TypeError("fetch failed");
    });
    await expect(analyzeReportWithinBudget(validInput, { sleep: noSleep, now })).rejects.toMatchObject({ networkLevel: true });
    expect(generateContentMock).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("an attempt timeout / budget abort is transient but never retried by the app", async () => {
    generateContentMock.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const err = await analyzeReportWithinBudget(validInput, { sleep: noSleep }).catch((e) => e);
    expect(err).toBeInstanceOf(AIUnavailableError);
    expect(err.transient).toBe(true);
    expect(isNetworkLevelAIFailure(err)).toBe(false);
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it("budget arithmetic: worst case stays well inside the 60s maxDuration", () => {
    expect(AI_TOTAL_BUDGET_MS).toBe(30_000);
    // The app retry only starts if a full attempt + its wait still fits.
    expect(NETWORK_RETRY_DELAY_MS + GEMINI_ATTEMPT_TIMEOUT_MS).toBeLessThanOrEqual(AI_TOTAL_BUDGET_MS);
    // AI budget + incident-confirmation cap (10s) leaves ≥20s of the 60s for upload/DB/routing.
    expect(60_000 - AI_TOTAL_BUDGET_MS - 10_000).toBeGreaterThanOrEqual(20_000);
    // Absolute call ceiling: a network-level failure is 1 attempt (the SDK
    // doesn't re-send it), then the one app retry may use all SDK attempts.
    expect(1 + GEMINI_RETRY.attempts!).toBe(4);
  });
});
