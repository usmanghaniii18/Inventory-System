/**
 * The alarm that should have gone off nineteen days earlier.
 *
 * The catalogue route quietly served ~1.2 MB to every till on every poll for
 * nineteen days. Nothing was broken in a way anything could see: no error, no
 * failed request, no slow page — just a steadily climbing bill, until the
 * Supabase project hit its egress quota and started 402ing EVERYTHING it
 * serves, /auth/v1 included, and every cashier was locked out of the POS.
 *
 * The fix for that is the ETag and the server cache. This is the smoke
 * detector: if the 304 path ever silently stops working — a proxy stripping
 * If-None-Match, a header rename, a fingerprint that changes on every call, a
 * refactor that reinstates `no-store` — the symptom is once again *nothing
 * visibly wrong*, just full payloads going out at a rate no healthy shop can
 * explain. This turns that into a line in the Railway logs on the first day
 * instead of an outage on the nineteenth.
 *
 * WHY A RATE AND NOT A COUNT
 * --------------------------
 * Full payloads are not the failure. They are correct and expected whenever the
 * catalogue actually changed — a price edit, a delivery received, a burst of
 * sales. What cannot happen in a real shop is HUNDREDS of them in ten minutes:
 * that means the catalogue is reported as changing far faster than a shop can
 * change it, which is the signature of a broken validator rather than a busy
 * till.
 */

/** Rolling window the rate is measured over. */
export const WINDOW_MS = 10 * 60_000;

/**
 * Full payloads within one window before this is treated as a fault.
 *
 * A generous ceiling on purpose — this is a smoke detector, not a rate limiter,
 * and it must never cry wolf on a genuinely busy afternoon. Sized against what
 * a healthy shop produces: tills poll every 5 minutes, so a handful of screens
 * reconciling real changes is a few dozen full reads per window at the very
 * most. Fifty sustained means the validator is not validating.
 */
export const FULL_PAYLOAD_THRESHOLD = 50;

interface Counters {
  windowStart: number;
  full: number;
  notModified: number;
  /** One warning per window — a log line per request would bury the signal. */
  warned: boolean;
}

let c: Counters = { windowStart: 0, full: 0, notModified: 0, warned: false };

export function reset(now = 0): void {
  c = { windowStart: now, full: 0, notModified: 0, warned: false };
}

export interface GuardStats {
  full: number;
  notModified: number;
  windowStart: number;
  tripped: boolean;
}

export function stats(): GuardStats {
  return {
    full: c.full,
    notModified: c.notModified,
    windowStart: c.windowStart,
    tripped: c.warned,
  };
}

/**
 * Record one served response and, if the rate looks pathological, say so once.
 *
 * `warn` is injected so tests can assert on the message rather than scraping
 * stdout; in production it is console.warn, which Railway captures.
 */
export function noteServed(
  kind: "full" | "304",
  now = Date.now(),
  warn: (msg: string) => void = console.warn,
): void {
  if (now - c.windowStart >= WINDOW_MS) {
    c = { windowStart: now, full: 0, notModified: 0, warned: false };
  }

  if (kind === "304") {
    c.notModified++;
    return;
  }
  c.full++;

  if (c.full <= FULL_PAYLOAD_THRESHOLD || c.warned) return;
  c.warned = true;

  const total = c.full + c.notModified;
  const pct = total ? Math.round((c.full / total) * 100) : 100;
  warn(
    `[catalog] EGRESS WARNING: ${c.full} full catalogue payloads in the last ` +
      `${Math.round(WINDOW_MS / 60_000)} min (${pct}% of ${total} requests were ` +
      `NOT 304s). A healthy shop revalidates far more often than it changes. ` +
      `This is what exhausted the Supabase egress quota and took every login ` +
      `down — check that If-None-Match is reaching the route (a proxy may be ` +
      `stripping it), that the ETag is stable across requests, and that ` +
      `catalog_fingerprint() is not changing on every call.`,
  );
}
