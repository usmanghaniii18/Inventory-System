import { describe, it, expect } from "vitest";
import { resolveRange, bucketKey, bucketOf, formatKarachiDateTime } from "./dates";

// Karachi (PKT) is a fixed UTC+5 offset, no DST. These tests pin instants as
// literal UTC ISO strings so they're deterministic regardless of the machine
// running them (unlike `new Date()`-based assertions, which would depend on
// today's real date).

describe("resolveRange — Karachi calendar boundaries", () => {
  it("custom_date resolves to the exact UTC instants for that Karachi calendar day", () => {
    const r = resolveRange("custom_date", "2026-07-27", "");
    // 27 Jul 2026 00:00 PKT = 26 Jul 2026 19:00 UTC
    expect(r.from.toISOString()).toBe("2026-07-26T19:00:00.000Z");
    // 27 Jul 2026 23:59:59.999 PKT = 27 Jul 2026 18:59:59.999 UTC
    expect(r.to.toISOString()).toBe("2026-07-27T18:59:59.999Z");
    expect(r.label).toBe("27 Jul 2026");
  });

  it("custom_range resolves from/to on the Karachi calendar, not UTC", () => {
    const r = resolveRange("custom_range", "2026-07-01", "2026-07-27");
    expect(r.from.toISOString()).toBe("2026-06-30T19:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-07-27T18:59:59.999Z");
  });

  it("widening a custom_range's end date never shrinks the window", () => {
    const narrow = resolveRange("custom_range", "2026-07-01", "2026-07-24");
    const wide = resolveRange("custom_range", "2026-07-01", "2026-07-27");
    expect(wide.from.getTime()).toBe(narrow.from.getTime());
    expect(wide.to.getTime()).toBeGreaterThan(narrow.to.getTime());
  });

  it("custom_date never routes a plain YYYY-MM-DD through UTC-midnight Date parsing", () => {
    // Regression: `new Date("2026-01-01")` is UTC midnight, which is already
    // 5am on 1 Jan in Karachi — a naive parse would've been right here by
    // accident. Assert the explicit UTC instant to lock the real behavior in.
    const r = resolveRange("custom_date", "2026-01-01", "");
    expect(r.from.toISOString()).toBe("2025-12-31T19:00:00.000Z");
  });
});

describe("bucketKey — buckets by Karachi calendar day/month, not UTC", () => {
  it("a sale at 1am PKT (still previous day in UTC) buckets into the correct Karachi day", () => {
    // 2026-07-28 01:00 PKT = 2026-07-27 20:00 UTC
    const d = new Date("2026-07-27T20:00:00.000Z");
    expect(bucketKey(d, "day")).toBe("28 Jul");
  });

  it("a sale at 11pm PKT stays on the same Karachi day", () => {
    // 2026-07-27 23:00 PKT = 2026-07-27 18:00 UTC
    const d = new Date("2026-07-27T18:00:00.000Z");
    expect(bucketKey(d, "day")).toBe("27 Jul");
  });

  it("hour bucket reads the Karachi hour, not the UTC hour", () => {
    // 2026-07-28 01:30 PKT = 2026-07-27 20:30 UTC
    const d = new Date("2026-07-27T20:30:00.000Z");
    expect(bucketKey(d, "hour")).toBe("01:00");
  });

  it("month bucket reads the Karachi month across a UTC month boundary", () => {
    // 2026-08-01 00:30 PKT = 2026-07-31 19:30 UTC
    const d = new Date("2026-07-31T19:30:00.000Z");
    expect(bucketKey(d, "month")).toBe("Aug 2026");
  });
});

describe("bucketOf", () => {
  it("still buckets a single-day range by hour and a wide range by month", () => {
    expect(bucketOf(resolveRange("today"))).toBe("hour");
    expect(bucketOf(resolveRange("this_year"))).toBe("month");
  });
});

describe("formatKarachiDateTime", () => {
  it("formats a UTC instant on the Karachi calendar/clock", () => {
    // 2026-07-27 23:30 PKT = 2026-07-27 18:30 UTC
    expect(formatKarachiDateTime(new Date("2026-07-27T18:30:00.000Z"))).toBe("27 Jul 2026, 11:30 PM");
  });

  it("crosses the UTC day boundary into the correct Karachi day/AM", () => {
    // 2026-07-28 00:15 PKT = 2026-07-27 19:15 UTC
    expect(formatKarachiDateTime(new Date("2026-07-27T19:15:00.000Z"))).toBe("28 Jul 2026, 12:15 AM");
  });
});
