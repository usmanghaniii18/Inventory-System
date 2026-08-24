import { describe, it, expect } from "vitest";
import { DEFAULT_RETURN_WINDOW_DAYS, isWithinReturnWindow } from "@/lib/return-window";

const DAY = 86_400_000;
const NOW = new Date("2026-08-24T12:00:00Z").getTime();
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

describe("return window (Phase H)", () => {
  it("defaults to 30 days, not the old 7", () => {
    expect(DEFAULT_RETURN_WINDOW_DAYS).toBe(30);
  });

  it("accepts a return inside the 30-day window", () => {
    for (const age of [0, 1, 7, 14, 29, 29.9]) {
      expect(isWithinReturnWindow(daysAgo(age), 30, NOW)).toBe(true);
    }
  });

  it("accepts a return on the boundary day", () => {
    expect(isWithinReturnWindow(daysAgo(30), 30, NOW)).toBe(true);
  });

  it("rejects a return after 30 days", () => {
    for (const age of [30.1, 31, 45, 365]) {
      expect(isWithinReturnWindow(daysAgo(age), 30, NOW)).toBe(false);
    }
  });

  it("a sale that the OLD 7-day rule rejected is now accepted", () => {
    const twoWeeksOld = daysAgo(14);
    expect(isWithinReturnWindow(twoWeeksOld, 7, NOW)).toBe(false); // old behaviour
    expect(isWithinReturnWindow(twoWeeksOld, DEFAULT_RETURN_WINDOW_DAYS, NOW)).toBe(true);
  });

  it("treats 0 (or negative) as no time limit at all", () => {
    expect(isWithinReturnWindow(daysAgo(9999), 0, NOW)).toBe(true);
    expect(isWithinReturnWindow(daysAgo(9999), -1, NOW)).toBe(true);
  });

  it("honours a custom configured window", () => {
    expect(isWithinReturnWindow(daysAgo(45), 60, NOW)).toBe(true);
    expect(isWithinReturnWindow(daysAgo(45), 14, NOW)).toBe(false);
  });
});
