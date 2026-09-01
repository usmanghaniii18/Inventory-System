/**
 * The server's copy of the catalogue, and the reason a till poll no longer
 * costs Supabase a megabyte.
 *
 * THE BUG THIS EXISTS TO FIX
 * --------------------------
 * /api/catalog re-read all ~2,300 rows (~1.22 MB of JSON) from PostgREST on
 * every single request. Each open screen polls on a timer, on focus, on
 * visibilitychange and on `online`, and every one of those was a full read.
 * One idle till pulled ~73 MB/hour; over nineteen days that exhausted the
 * project's egress quota, and a quota-restricted Supabase project 402s
 * EVERYTHING — including /auth/v1 — so every cashier was locked out of the POS
 * by a caching bug in the product grid.
 *
 * TWO LAYERS, AND THE DIFFERENT BILLS THEY PROTECT
 * -----------------------------------------------
 * The ETag in the route saves Railway -> browser bytes. It does NOT save
 * Supabase egress on its own: you cannot compute an ETag over data you have not
 * fetched. THIS module is the half that protects Supabase, and it does it by
 * asking a much cheaper question first.
 *
 *   1. Inside TTL_MS, serve the held payload and ask Supabase nothing at all.
 *      N tills polling in the same window cost one read between them, not N.
 *   2. Past the TTL, call catalog_fingerprint() (migration 0032) — Postgres
 *      hashes (variant_id, updated_at, available) over the active catalogue and
 *      returns ~40 bytes. Unchanged (the overwhelmingly common case): stamp the
 *      held copy fresh and return it. Only a CHANGED fingerprint re-reads the
 *      1.22 MB.
 *
 * So an idle catalogue costs ~40 bytes per TTL window rather than 1.22 MB per
 * poll per till — about four ten-thousandths of the old traffic — and the data
 * is still never more than TTL_MS stale, because staleness is settled by a real
 * query against the live table and not by a timer.
 *
 * FRESHNESS IS NOT TRADED AWAY
 * ----------------------------
 * `available` is in the fingerprint on purpose. It comes from
 * variant_availability, and a sale or a goods receipt moves it WITHOUT touching
 * either updated_at column — fingerprinting on updated_at alone would let a
 * till show stock it had already sold. See migration 0032.
 *
 * Process-local by design. Railway may run more than one instance; each keeps
 * its own copy, which costs one extra fingerprint call per instance per window
 * and cannot serve anything staler than TTL_MS. A shared cache would buy very
 * little for the coordination it would cost.
 */

import type { WireRow } from "./catalog-payload";

/**
 * How long a held payload is served without re-checking the fingerprint.
 *
 * Sized against the failure it prevents, not against the clock: the till polls
 * every 5 minutes (useCatalog's POLL_MS) and a sale patches its own cache
 * locally, so nothing at a register is waiting on this. Ten seconds is short
 * enough that a price changed on the office screen reaches a till essentially
 * immediately, and long enough that a burst of tills returning from screensaver
 * together shares one read.
 */
export const TTL_MS = 10_000;

interface Held {
  rows: WireRow[];
  /** The fingerprint the rows were read at — also the ETag. */
  fingerprint: string;
  /** When the fingerprint was last CONFIRMED current (not when rows were read). */
  checkedAt: number;
}

let held: Held | null = null;
/** Collapses concurrent misses into one refresh — see load(). */
let inFlight: Promise<Held> | null = null;

export function peek(): Held | null {
  return held;
}

/** Test seam: the cache is module-global and would otherwise leak across tests. */
export function reset(): void {
  held = null;
  inFlight = null;
}

export interface Loaders {
  /** `catalog_fingerprint()` — cheap. Returns null when unavailable. */
  fingerprint: () => Promise<string | null>;
  /** Full read of the active catalogue. Expensive; called as rarely as possible. */
  rows: () => Promise<WireRow[]>;
}

/**
 * Return the current catalogue, re-reading Supabase only when it must.
 *
 * SINGLE FLIGHT. Several tills polling at once past the TTL would otherwise
 * each start their own fingerprint call and their own full read — the identical
 * stampede this module exists to stop, just moved from the client to the
 * server. They share one refresh instead.
 */
export async function load(l: Loaders, now = Date.now()): Promise<Held> {
  if (held && now - held.checkedAt < TTL_MS) return held;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const fp = await l.fingerprint();

      // Unchanged — the whole point. Stamp it current; read nothing.
      //
      // Stamped with `now` — the caller's clock — and NOT Date.now(). The two
      // are the same in production, but only one of them is the value the TTL
      // above is compared against, and mixing the two makes the window mean
      // whatever the wall clock happened to say. It also leaves the cache
      // untestable without faking global time.
      if (fp !== null && held && fp === held.fingerprint) {
        held = { ...held, checkedAt: now };
        return held;
      }

      const rows = await l.rows();
      // A null fingerprint means the probe is unavailable (migration 0032 not
      // applied yet, or the RPC was revoked). Fall back to hashing the payload
      // we just read: the ETag still works, so the browser still gets its 304s
      // and only the Supabase-side saving is lost until the migration lands.
      held = { rows, fingerprint: fp ?? weakHash(rows), checkedAt: now };
      return held;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Fallback fingerprint over rows already in hand — the same three fields
 * migration 0032 hashes, so the two agree on what counts as a change.
 *
 * FNV-1a: not a security hash and not trying to be. It only has to change when
 * the catalogue changes, and it must not pull a crypto dependency into a path
 * that can run on every request.
 */
export function weakHash(rows: WireRow[]): string {
  let h = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  for (const r of rows) feed(`${r.variant_id}|${r.updated_at}|${r.available},`);
  return `${rows.length}:${(h >>> 0).toString(16)}`;
}
