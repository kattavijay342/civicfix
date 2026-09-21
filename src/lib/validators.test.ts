import { describe, it, expect } from "vitest";
import { isValidReporterName, isValidIndianMobile, mobileDigitsOnly } from "@/lib/validators";

describe("isValidReporterName", () => {
  it("accepts a normal name", () => {
    expect(isValidReporterName("Priya Rao")).toBe(true);
  });
  it("rejects a single character", () => {
    expect(isValidReporterName("A")).toBe(false);
  });
  it("rejects an empty/whitespace-only name", () => {
    expect(isValidReporterName("   ")).toBe(false);
  });
  it("rejects a name over 60 characters", () => {
    expect(isValidReporterName("A".repeat(61))).toBe(false);
  });
  it("accepts exactly 60 characters", () => {
    expect(isValidReporterName("A".repeat(60))).toBe(true);
  });
});

describe("mobileDigitsOnly", () => {
  it("strips spaces and dashes", () => {
    expect(mobileDigitsOnly("98765 43210")).toBe("9876543210");
    expect(mobileDigitsOnly("98765-43210")).toBe("9876543210");
  });
  it("strips a leading +91 country code", () => {
    expect(mobileDigitsOnly("+919876543210")).toBe("9876543210");
  });
  it("strips a leading bare 91 country code", () => {
    expect(mobileDigitsOnly("919876543210")).toBe("9876543210");
  });
});

describe("isValidIndianMobile", () => {
  it("accepts a valid 10-digit number starting 6-9", () => {
    expect(isValidIndianMobile("9876543210")).toBe(true);
    expect(isValidIndianMobile("6000000000")).toBe(true);
  });
  it("rejects a number starting 0-5", () => {
    expect(isValidIndianMobile("5876543210")).toBe(false);
  });
  it("rejects too few digits", () => {
    expect(isValidIndianMobile("987654321")).toBe(false);
  });
  it("rejects too many digits", () => {
    expect(isValidIndianMobile("98765432101")).toBe(false);
  });
  it("accepts with a +91 prefix", () => {
    expect(isValidIndianMobile("+91 98765 43210")).toBe(true);
  });
  it("rejects non-numeric input", () => {
    expect(isValidIndianMobile("not-a-number")).toBe(false);
  });
});
