import { describe, it, expect, vi, beforeEach } from "vitest";

const generateContentMock = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
  Type: { OBJECT: "OBJECT", STRING: "STRING", NUMBER: "NUMBER", BOOLEAN: "BOOLEAN" },
}));

const { confirmSameIncident, IncidentAIUnavailableError } = await import("@/lib/incident-ai-confirm");

const validInput = {
  reportA: { category: "road", description: "Large pothole near the bus stand.", areaLabel: "Ward 12" },
  reportB: { category: "road", description: "Road hole growing near the bus stand.", areaLabel: "Ward 12" },
  distanceMeters: 40,
  daysApart: 2,
};

beforeEach(() => {
  generateContentMock.mockReset();
  delete process.env.GEMINI_API_KEY;
});

describe("confirmSameIncident", () => {
  it("throws IncidentAIUnavailableError when no API key is configured", async () => {
    await expect(confirmSameIncident(validInput)).rejects.toBeInstanceOf(IncidentAIUnavailableError);
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it("returns a validated confirmation for a well-formed response", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({ same_incident: true, confidence: 0.82, reasoning: "Both describe the same pothole." }),
    });

    const result = await confirmSameIncident(validInput);
    expect(result.same_incident).toBe(true);
    expect(result.confidence).toBe(0.82);
    expect(result.reasoning).toBeTruthy();
  });

  it("throws on a network/API failure rather than returning a fabricated result", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockRejectedValue(new Error("network error"));
    await expect(confirmSameIncident(validInput)).rejects.toBeInstanceOf(IncidentAIUnavailableError);
  });

  it("throws on an empty response", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({ text: "" });
    await expect(confirmSameIncident(validInput)).rejects.toBeInstanceOf(IncidentAIUnavailableError);
  });

  it("throws on a non-JSON response", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({ text: "not json" });
    await expect(confirmSameIncident(validInput)).rejects.toBeInstanceOf(IncidentAIUnavailableError);
  });

  it("throws when the response fails schema validation (e.g. confidence out of range)", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({ same_incident: true, confidence: 1.5, reasoning: "x" }),
    });
    await expect(confirmSameIncident(validInput)).rejects.toBeInstanceOf(IncidentAIUnavailableError);
  });

  it("keeps the existing model and passes the worker's abort signal through (AI-2)", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({ text: JSON.stringify({ same_incident: false, confidence: 0.3, reasoning: "Different." }) });
    const signal = new AbortController().signal;
    await confirmSameIncident(validInput, { signal, timeoutMs: 90_000 });
    expect(generateContentMock.mock.calls[0][0]).toMatchObject({ model: "gemini-3.6-flash", config: { abortSignal: signal } });
  });

  it.each([
    ["HTTP 503", Object.assign(new Error("high demand"), { status: 503 }), { kind: "http", status: 503 }],
    ["HTTP 404", Object.assign(new Error("model not found"), { status: 404 }), { kind: "http", status: 404 }],
    ["abort/timeout", Object.assign(new Error("aborted"), { name: "AbortError" }), { kind: "timeout" }],
    ["network", new TypeError("fetch failed"), { kind: "network" }],
  ])("classifies a %s failure for the AI-2 worker", async (_label, error, expected) => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockRejectedValue(error);
    await expect(confirmSameIncident(validInput)).rejects.toMatchObject(expected);
  });

  it("classifies a missing key and invalid output as such", async () => {
    await expect(confirmSameIncident(validInput)).rejects.toMatchObject({ kind: "not_configured" });
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({ text: "not json" });
    await expect(confirmSameIncident(validInput)).rejects.toMatchObject({ kind: "invalid_output" });
  });

  it("throws when a required field is missing", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({ same_incident: true, confidence: 0.7 }),
    });
    await expect(confirmSameIncident(validInput)).rejects.toBeInstanceOf(IncidentAIUnavailableError);
  });
});
