import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reverseGeocode } from "./reverse-geocoding";

const ORIGINAL = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

function mockFetchOnce(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
    ...response,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("reverseGeocode", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN = "pk.test-token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;
    else process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN = ORIGINAL;
  });

  it("is unavailable — never fabricates an address — when no provider is configured", async () => {
    delete process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;
    const result = await reverseGeocode(16.2333, 80.0499);
    expect(result).toEqual({
      status: "unavailable",
      reason: "No reverse-geocoding provider is configured (NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN is unset).",
    });
  });

  it("returns a real formatted address from a valid provider response", async () => {
    mockFetchOnce({
      json: async () => ({
        features: [
          {
            properties: {
              full_address: "Sattenapalli RTC Bus Stand, Palnadu, Andhra Pradesh",
              name: "Sattenapalli RTC Bus Stand",
            },
          },
        ],
      }),
    });

    const result = await reverseGeocode(16.2333, 80.0499);
    expect(result).toEqual({
      status: "ok",
      result: {
        formattedAddress: "Sattenapalli RTC Bus Stand, Palnadu, Andhra Pradesh",
        landmark: "Sattenapalli RTC Bus Stand",
      },
    });
  });

  it("is unavailable, not crashed, on a rate-limit response", async () => {
    mockFetchOnce({ ok: false, status: 429 });
    const result = await reverseGeocode(16.2333, 80.0499);
    expect(result.status).toBe("unavailable");
  });

  it("is unavailable, not crashed, on a provider error response", async () => {
    mockFetchOnce({ ok: false, status: 500 });
    const result = await reverseGeocode(16.2333, 80.0499);
    expect(result.status).toBe("unavailable");
  });

  it("is unavailable, not crashed, on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );
    const result = await reverseGeocode(16.2333, 80.0499);
    expect(result.status).toBe("unavailable");
  });

  it("is unavailable, not crashed, when the response has no features", async () => {
    mockFetchOnce({ json: async () => ({ features: [] }) });
    const result = await reverseGeocode(16.2333, 80.0499);
    expect(result.status).toBe("unavailable");
  });

  it("is unavailable, not crashed, on a malformed (non-JSON) response", async () => {
    mockFetchOnce({
      json: async () => {
        throw new Error("invalid json");
      },
    });
    const result = await reverseGeocode(16.2333, 80.0499);
    expect(result.status).toBe("unavailable");
  });
});
