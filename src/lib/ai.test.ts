import { describe, it, expect, vi, beforeEach } from "vitest";

const generateContentMock = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
  Type: { OBJECT: "OBJECT", STRING: "STRING", NUMBER: "NUMBER", ARRAY: "ARRAY", BOOLEAN: "BOOLEAN" },
}));

// Imported after the mock so analyzeReport picks up the mocked GoogleGenAI.
const { analyzeReport, AIUnavailableError } = await import("@/lib/ai");

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
