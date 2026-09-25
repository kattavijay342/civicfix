import { describe, it, expect } from "vitest";
import { timeAgo, isWithin } from "./time-ago";

describe("timeAgo", () => {
  const now = Date.parse("2026-09-25T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("formats each range", () => {
    expect(timeAgo(ago(20_000), now)).toBe("Just now");
    expect(timeAgo(ago(12 * 60_000), now)).toBe("12 min ago");
    expect(timeAgo(ago(3 * 3_600_000), now)).toBe("3 h ago");
    expect(timeAgo(ago(24 * 3_600_000), now)).toBe("1 day ago");
    expect(timeAgo(ago(50 * 3_600_000), now)).toBe("2 days ago");
  });

  it("never shows a negative age for clock skew", () => {
    expect(timeAgo(new Date(now + 60_000).toISOString(), now)).toBe("Just now");
  });

  it("isWithin flags only reports inside the window", () => {
    expect(isWithin(ago(23 * 3_600_000), undefined, now)).toBe(true);
    expect(isWithin(ago(25 * 3_600_000), undefined, now)).toBe(false);
  });
});
