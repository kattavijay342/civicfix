import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { performLocationSearch } from "./search";

const ORIGINAL = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

function mockFetchOnce(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ features: [] }),
    ...response,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("performLocationSearch", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN = "pk.test-token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;
    else process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN = ORIGINAL;
  });

  it("never calls the provider below the minimum query length", async () => {
    const fetchMock = mockFetchOnce({});
    const result = await performLocationSearch("kr");
    expect(result).toEqual({ status: "ok", results: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is unavailable — never fabricates a suggestion — when no provider is configured", async () => {
    delete process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;
    const result = await performLocationSearch("Krosuru");
    expect(result.status).toBe("unavailable");
  });

  it("parses real suggestions from a valid provider response", async () => {
    mockFetchOnce({
      json: async () => ({
        features: [
          {
            properties: {
              mapbox_id: "abc123",
              name: "Krosuru",
              place_formatted: "Palnadu, Andhra Pradesh, India",
              feature_type: "place",
            },
            geometry: { type: "Point", coordinates: [80.0499, 16.2333] },
          },
        ],
      }),
    });

    const result = await performLocationSearch("Krosuru");
    expect(result).toEqual({
      status: "ok",
      results: [
        {
          id: "abc123",
          label: "Krosuru",
          context: "Palnadu, Andhra Pradesh, India",
          latitude: 16.2333,
          longitude: 80.0499,
          placeType: "place",
        },
      ],
    });
  });

  it("drops malformed features instead of fabricating a placeholder for them", async () => {
    mockFetchOnce({
      json: async () => ({
        features: [
          { properties: { name: "Missing geometry" } },
          { properties: {}, geometry: { type: "Point", coordinates: [80.0, 16.0] } }, // no label
          {
            properties: { name: "Valid Place" },
            geometry: { type: "Point", coordinates: [80.1, 16.1] },
          },
        ],
      }),
    });

    const result = await performLocationSearch("Valid Place search term");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.results).toHaveLength(1);
      expect(result.results[0].label).toBe("Valid Place");
    }
  });

  it("is unavailable, not crashed, on a rate-limit response", async () => {
    mockFetchOnce({ ok: false, status: 429 });
    const result = await performLocationSearch("Krosuru");
    expect(result.status).toBe("unavailable");
  });

  it("is unavailable, not crashed, on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const result = await performLocationSearch("Krosuru");
    expect(result.status).toBe("unavailable");
  });

  it("propagates AbortError so the caller's own cancellation isn't swallowed", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));
    await expect(performLocationSearch("Krosuru")).rejects.toThrow("aborted");
  });
});
