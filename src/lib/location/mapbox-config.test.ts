import { describe, it, expect, afterEach } from "vitest";
import { getMapboxToken, isMapboxConfigured } from "./mapbox-config";

const ORIGINAL = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

describe("getMapboxToken / isMapboxConfigured", () => {
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;
    else process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN = ORIGINAL;
  });

  it("returns null when unset — never a fabricated placeholder token", () => {
    delete process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;
    expect(getMapboxToken()).toBeNull();
    expect(isMapboxConfigured()).toBe(false);
  });

  it("returns null for a blank/whitespace-only value", () => {
    process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN = "   ";
    expect(getMapboxToken()).toBeNull();
    expect(isMapboxConfigured()).toBe(false);
  });

  it("returns the trimmed token when set", () => {
    process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN = "  pk.test-token  ";
    expect(getMapboxToken()).toBe("pk.test-token");
    expect(isMapboxConfigured()).toBe(true);
  });
});
