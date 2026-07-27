export type Preset =
  | "today" | "yesterday" | "this_week" | "this_month" | "this_year"
  | "custom_date" | "custom_range";

export const PRESETS: { value: Preset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "this_week", label: "This Week" },
  { value: "this_month", label: "This Month" },
  { value: "this_year", label: "This Year" },
  { value: "custom_date", label: "Custom date" },
  { value: "custom_range", label: "Custom range" },
];

export interface DateRange { from: Date; to: Date; label: string; preset: Preset; }

// The store operates in Pakistan Standard Time — a fixed UTC+5 offset with no
// DST — so "today"/"this month"/etc must be computed on the Karachi calendar,
// not the host process's local time (which is UTC in production; anything
// between 00:00–04:59 PKT would otherwise resolve to the wrong calendar day).
// Everything below is Intl-based (Node ships full ICU) rather than relying on
// date-fns' local-timezone getters, so it's correct on the Karachi dev machine
// AND the UTC server alike.
const TZ = "Asia/Karachi";
const TZ_OFFSET_MS = 5 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface KParts { y: number; m: number; d: number; h: number; mi: number; s: number; }
interface KDate { y: number; m: number; d: number; h?: number; mi?: number; s?: number; ms?: number; }

/** Wall-clock Y/M/D/H/M/S as they read on a Karachi clock for a given instant. */
function karachiParts(instant: Date): KParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get("year"), m: get("month") - 1, d: get("day"), h: get("hour") % 24, mi: get("minute"), s: get("second") };
}

/** The real UTC instant for a given Karachi wall-clock Y/M/D H:M:S. */
function karachiToUtc(p: KDate): Date {
  return new Date(Date.UTC(p.y, p.m, p.d, p.h ?? 0, p.mi ?? 0, p.s ?? 0, p.ms ?? 0) - TZ_OFFSET_MS);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

const kStartOfDay = (instant: Date) => { const p = karachiParts(instant); return karachiToUtc({ y: p.y, m: p.m, d: p.d }); };
const kEndOfDay = (instant: Date) => { const p = karachiParts(instant); return karachiToUtc({ y: p.y, m: p.m, d: p.d, h: 23, mi: 59, s: 59, ms: 999 }); };
const kStartOfMonth = (instant: Date) => { const p = karachiParts(instant); return karachiToUtc({ y: p.y, m: p.m, d: 1 }); };
const kEndOfMonth = (instant: Date) => { const p = karachiParts(instant); return karachiToUtc({ y: p.y, m: p.m, d: daysInMonth(p.y, p.m), h: 23, mi: 59, s: 59, ms: 999 }); };
const kStartOfYear = (instant: Date) => { const p = karachiParts(instant); return karachiToUtc({ y: p.y, m: 0, d: 1 }); };
const kEndOfYear = (instant: Date) => { const p = karachiParts(instant); return karachiToUtc({ y: p.y, m: 11, d: 31, h: 23, mi: 59, s: 59, ms: 999 }); };
const kSubDays = (instant: Date, n: number) => new Date(instant.getTime() - n * 86_400_000);

/** Monday-start week containing the instant, on the Karachi calendar. */
function kStartOfWeek(instant: Date): Date {
  const p = karachiParts(instant);
  const asUtc = new Date(Date.UTC(p.y, p.m, p.d, 12)); // noon: purely for a TZ-agnostic day-of-week lookup
  const dow = asUtc.getUTCDay(); // 0=Sun..6=Sat
  const sinceMonday = (dow + 6) % 7;
  const monday = new Date(asUtc.getTime() - sinceMonday * 86_400_000);
  return karachiToUtc({ y: monday.getUTCFullYear(), m: monday.getUTCMonth(), d: monday.getUTCDate() });
}
function kEndOfWeek(instant: Date): Date {
  return new Date(kStartOfWeek(instant).getTime() + 7 * 86_400_000 - 1);
}

/** Parse a plain "YYYY-MM-DD" (from <input type="date">) as a literal Karachi calendar date — never routed through `new Date(string)`, which parses as UTC midnight and would shift under the +5h offset. */
function parseKarachiDateOnly(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m: m - 1, d };
}

const labelDMY = (p: { y: number; m: number; d: number }) => `${p.d} ${MONTHS[p.m]} ${p.y}`;
const labelDM = (p: { y: number; m: number; d: number }) => `${p.d} ${MONTHS[p.m]}`;
const labelMY = (p: { y: number; m: number }) => `${MONTHS[p.m]} ${p.y}`;

/** Resolve a preset (+ optional custom strings YYYY-MM-DD) into a concrete range. */
export function resolveRange(preset?: string | null, fromStr?: string | null, toStr?: string | null): DateRange {
  const now = new Date();
  const p = (preset as Preset) || "this_month";
  switch (p) {
    case "today":
      return { from: kStartOfDay(now), to: kEndOfDay(now), label: "Today", preset: p };
    case "yesterday": {
      const y = kSubDays(now, 1);
      return { from: kStartOfDay(y), to: kEndOfDay(y), label: "Yesterday", preset: p };
    }
    case "this_week":
      return { from: kStartOfWeek(now), to: kEndOfWeek(now), label: "This Week", preset: p };
    case "this_year":
      return { from: kStartOfYear(now), to: kEndOfYear(now), label: "This Year", preset: p };
    case "custom_date": {
      const dp = fromStr ? parseKarachiDateOnly(fromStr) : karachiParts(now);
      return { from: karachiToUtc(dp), to: karachiToUtc({ ...dp, h: 23, mi: 59, s: 59, ms: 999 }), label: labelDMY(dp), preset: p };
    }
    case "custom_range": {
      const fp = fromStr ? parseKarachiDateOnly(fromStr) : (() => { const mp = karachiParts(now); return { y: mp.y, m: mp.m, d: 1 }; })();
      const tp = toStr ? parseKarachiDateOnly(toStr) : karachiParts(now);
      return {
        from: karachiToUtc(fp),
        to: karachiToUtc({ ...tp, h: 23, mi: 59, s: 59, ms: 999 }),
        label: `${labelDM(fp)} – ${labelDMY(tp)}`,
        preset: p,
      };
    }
    case "this_month":
    default:
      return { from: kStartOfMonth(now), to: kEndOfMonth(now), label: "This Month", preset: "this_month" };
  }
}

/** Bucket granularity for trend charts based on the range span. */
export function bucketOf(range: DateRange): "hour" | "day" | "month" {
  const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;
  if (days <= 1.5) return "hour";
  if (days <= 92) return "day";
  return "month";
}

export function bucketKey(d: Date, bucket: "hour" | "day" | "month") {
  const p = karachiParts(d);
  if (bucket === "hour") return `${String(p.h).padStart(2, "0")}:00`;
  if (bucket === "month") return labelMY(p);
  return labelDM(p);
}

/** "27 Jul 2026, 11:30 PM" on the Karachi calendar/clock, for display of a raw timestamp. */
export function formatKarachiDateTime(d: Date): string {
  const p = karachiParts(d);
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  const ampm = p.h < 12 ? "AM" : "PM";
  return `${labelDMY(p)}, ${h12}:${String(p.mi).padStart(2, "0")} ${ampm}`;
}
