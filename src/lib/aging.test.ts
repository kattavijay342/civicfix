import { describe, it, expect } from "vitest";
import { agingBucketForDays, AGING_BUCKET_KEYS, AGING_BUCKET_LABELS } from "./aging";

describe("agingBucketForDays", () => {
  it("classifies each boundary into the correct bucket, matching get_aging_buckets()'s SQL boundaries", () => {
    expect(agingBucketForDays(0)).toBe("0_1");
    expect(agingBucketForDays(1)).toBe("0_1");
    expect(agingBucketForDays(1.9)).toBe("0_1");
    expect(agingBucketForDays(2)).toBe("2_3");
    expect(agingBucketForDays(3.9)).toBe("2_3");
    expect(agingBucketForDays(4)).toBe("4_7");
    expect(agingBucketForDays(7.9)).toBe("4_7");
    expect(agingBucketForDays(8)).toBe("8_14");
    expect(agingBucketForDays(14.9)).toBe("8_14");
    expect(agingBucketForDays(15)).toBe("15_30");
    expect(agingBucketForDays(30.9)).toBe("15_30");
    expect(agingBucketForDays(31)).toBe("30_plus");
    expect(agingBucketForDays(365)).toBe("30_plus");
  });

  it("has a label for every bucket key, in the same order the SQL function returns them", () => {
    for (const key of AGING_BUCKET_KEYS) {
      expect(AGING_BUCKET_LABELS[key]).toBeTruthy();
    }
    expect(AGING_BUCKET_KEYS).toEqual(["0_1", "2_3", "4_7", "8_14", "15_30", "30_plus"]);
  });
});
