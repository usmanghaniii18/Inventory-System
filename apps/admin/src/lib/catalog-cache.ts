// Local catalogue cache — the fast path for scanning and search.
//
// The whole sellable catalogue (one light row per variant) is loaded once from
// /api/catalog, held in memory and mirrored to IndexedDB. Scans and search
// resolve against this instantly (no network per scan) and keep working through
// brief network drops; a background fetch reconciles with the server. This is
// the shared index used by the POS today and the universal scanner (Section 2).

import { unpackRow, type WireRow } from "./catalog-payload";

export interface CatalogItem {
  variant_id: string;
  product_id: string;
  product_name: string;
  brand: string | null;
  has_variants: boolean;
  is_variable_weight: boolean;
  sku: string;
  label: string;
  /** Primary barcode — what the label printer stamps and the UI shows. */
  barcode: string | null;
  /**
   * EVERY barcode on this variant (manufacturer EAN, internal sticker, any
   * alternates), primary first. The scan index is built from this: keying only
   * off `barcode` meant a product with a second code simply would not scan on
   * it — one of the "barcode doesn't scan" reports.
   */
  barcodes?: string[] | null;
  price: number;
  cost: number;
  /** Product's default discount (auto-filled in the POS cart). */
  disc_type: "PERCENT" | "FIXED" | null;
  disc_value: number;
  /** Per-variant low-stock threshold. */
  reorder_point: number;
  category_id: string | null;
  image_url: string | null;
  /** Product base unit (e.g. Pcs / Kg) — shown in the invoice Qty column. */
  unit: string | null;
  available: number;
  avg_cost: number;
  active: boolean;
  updated_at: string;
}

export interface CatalogSnapshot {
  items: CatalogItem[];
  byBarcode: Map<string, CatalogItem>;
  byVariant: Map<string, CatalogItem>;
  /**
   * Mutable: a reconcile that finds the catalogue UNCHANGED stamps these two in
   * place rather than replacing the snapshot, so the till is not re-rendered
   * for a no-op. Nothing renders either field. See refreshFromNetwork().
   */
  fetchedAt: number;
  /** true once a network reconcile has succeeded at least once this session. */
  fresh: boolean;
}

// ---- IndexedDB (tiny single-key store; no dependency) --------------------
const DB_NAME = "hgs-catalog";
const STORE = "kv";
// Bumped with the schema: v1 blobs carry no ETag, so a v1 reader would have to
// re-download the whole catalogue anyway. A new key retires them cleanly.
const KEY = "catalog-v2";

/**
 * How stale a snapshot may get before ensureCatalog() reconciles in the
 * background. Raised from 60s to 5 minutes alongside useCatalog's POLL_MS.
 *
 * The ETag already makes an unchanged poll nearly free, so this is not what
 * protects the egress budget any more — it is defence in depth. If the
 * fingerprint path ever regresses to serving 200s, the damage is a fifth of
 * what it was, and the till still catches up within five minutes. Anything the
 * cashier does that actually changes stock patches the cache locally and
 * immediately (see applyStockDelta), so nothing at a register waits on this.
 */
const REFRESH_AFTER_MS = 5 * 60_000;

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  try {
    const db = await idbOpen();
    return await new Promise<T | undefined>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

async function idbSet(key: string, val: unknown): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await idbOpen();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* persistence is best-effort */
  }
}

// ---- in-memory store + subscriptions -------------------------------------
let snapshot: CatalogSnapshot | null = null;
let loading: Promise<CatalogSnapshot> | null = null;
/** The background reconcile in flight, if any — see refreshFromNetwork(). */
let refreshing: Promise<void> | null = null;
/**
 * Fingerprint of the payload the current snapshot was built from, so an
 * unchanged catalogue can be recognised without rebuilding or re-rendering it.
 */
let signature = "";
/**
 * The server's fingerprint for the catalogue we hold, echoed back as
 * If-None-Match so an unchanged catalogue answers 304 with no body.
 */
let etag: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

function build(items: CatalogItem[], fetchedAt: number, fresh: boolean): CatalogSnapshot {
  const byBarcode = new Map<string, CatalogItem>();
  const byVariant = new Map<string, CatalogItem>();
  const conflicts: string[] = [];
  for (const it of items) {
    byVariant.set(it.variant_id, it);
    // Index every code the variant carries, not just the primary one.
    const codes = it.barcodes?.length ? it.barcodes : it.barcode ? [it.barcode] : [];
    for (const raw of codes) {
      const code = (raw ?? "").trim();
      if (!code) continue;
      const prev = byBarcode.get(code);
      // The DB has a UNIQUE constraint on product_barcodes.barcode, so this is
      // unreachable in a healthy database. If it ever fires, the code is
      // genuinely ambiguous and must resolve to NOTHING rather than to whichever
      // row happened to be indexed last — a wrong item on a bill is worse than
      // a refused scan. scripts/barcode-audit.mjs reports these.
      if (prev && prev.variant_id !== it.variant_id) {
        conflicts.push(code);
        continue;
      }
      byBarcode.set(code, it);
    }
  }
  for (const code of conflicts) byBarcode.delete(code);
  if (conflicts.length && typeof console !== "undefined") {
    console.error("[catalog] duplicate barcodes ignored — run scripts/barcode-audit.mjs", conflicts);
  }
  return { items, byBarcode, byVariant, fetchedAt, fresh };
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSnapshot(): CatalogSnapshot | null {
  return snapshot;
}

/**
 * Cheap content fingerprint. Row count plus each variant's id and its own
 * updated_at — the column the view already maintains — so any add, edit, price
 * change, barcode assignment or stock movement changes it, and nothing else
 * does. Comparing this is a few hundred microseconds against the tens of
 * milliseconds a rebuild-and-re-render costs.
 */
function signatureOf(items: CatalogItem[]): string {
  let s = `${items.length}`;
  for (const it of items) s += `|${it.variant_id}:${it.updated_at}:${it.available}`;
  return s;
}

/**
 * Reconcile with the server.
 *
 * SINGLE FLIGHT, AND WHY IT MATTERS ON A TILL
 * -------------------------------------------
 * The refresh triggers are an interval, window focus, visibilitychange and
 * `online`. Returning to the till fires focus AND visibilitychange together,
 * and neither one updates `fetchedAt` until its own fetch RESOLVES, so the old
 * code started a second and third identical request while the first was still
 * in the air — each of which then rebuilt the index and re-rendered the screen.
 *
 * NO WORK WHEN NOTHING CHANGED
 * ----------------------------
 * The catalogue is usually identical to the copy already held: this runs every
 * 60 seconds whether or not the shop touched anything. Rebuilding the maps and
 * emitting anyway handed React a brand-new snapshot object every minute, which
 * invalidated every useMemo on the POS screen and re-rendered its product grid
 * — over two thousand cards, unvirtualised — for no change at all.
 *
 * That re-render is what broke scanning. It blocks the main thread for long
 * enough that the keystrokes of a barcode already in flight queue up behind it,
 * and a burst delivered in one clump after a stall used to read as a stale
 * sequence followed by a fresh one: the leading digits were dropped and the
 * remainder was billed as a whole code. The detector no longer measures time
 * that way (see useHardwareScanner's stampOf), so this is now the second line
 * of defence rather than the only one — but not doing the work is still the
 * better fix, and it keeps a till responsive besides.
 */
async function refreshFromNetwork(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      // `no-store` here would forbid the browser from keeping the body at all,
      // which makes a 304 impossible — the whole saving depends on it holding
      // the previous response. `no-cache` still revalidates on every request;
      // the ETag decides whether a body comes back. See api/catalog/route.ts.
      const res = await fetch("/api/catalog", {
        cache: "no-cache",
        headers: etag ? { "If-None-Match": etag } : undefined,
      });

      // Unchanged — no body was sent. This is the common case by a wide margin
      // and the reason an idle till is nearly free. Mark it checked and leave
      // the snapshot object (and therefore the screen) alone.
      if (res.status === 304) {
        if (snapshot) {
          snapshot.fetchedAt = Date.now();
          snapshot.fresh = true;
        }
        return;
      }

      if (!res.ok) throw new Error(`catalog ${res.status}`);

      const serverTag = res.headers?.get?.("ETag") ?? null;
      const data = (await res.json()) as { items: WireRow[] };
      const items = (data.items ?? []).map(unpackRow);

      // Second line of defence. A 200 that turns out to carry the catalogue we
      // already hold still must not re-render the till — over two thousand
      // unvirtualised cards, mid-scan. This is what covers the window before
      // migration 0032 is applied, and any future regression in the ETag path.
      const sig = signatureOf(items);
      if (snapshot && sig === signature) {
        // Updated IN PLACE, deliberately. useSyncExternalStore compares what
        // getSnapshot() returns on every render, so handing back a new object
        // would re-render the till anyway, which is the cost this branch exists
        // to avoid. Neither field is rendered; both only drive staleness.
        snapshot.fetchedAt = Date.now();
        snapshot.fresh = true;
        etag = serverTag ?? etag;
        return;
      }

      signature = sig;
      etag = serverTag;
      snapshot = build(items, Date.now(), true);
      emit();
      await idbSet(KEY, { items: data.items ?? [], etag, fetchedAt: snapshot.fetchedAt });
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * Apply a stock change the client already knows about, without a network round
 * trip — the local half of "don't re-fetch 1.2 MB because one item sold".
 *
 * A completed sale used to call ensureCatalog({ force: true }), which bypassed
 * every cache and pulled the entire catalogue back purely to learn that N items
 * of one variant had gone. The sale response already settles that: the till
 * knows exactly what it sold. So patch those rows and let the ordinary
 * (ETag-validated) reconcile confirm it in the background.
 *
 * Mutates the held items in place and emits ONCE, so the grid re-renders for a
 * real change — a sold-out item must grey out immediately — but only once per
 * sale rather than once per line.
 *
 * Deliberately does NOT write IndexedDB: the authoritative number arrives with
 * the next reconcile, and persisting a locally-derived figure risks a till
 * starting up tomorrow trusting arithmetic instead of the server. Unknown
 * variant ids are ignored rather than invented.
 */
export function applyStockDelta(deltas: { variant_id: string; qty: number }[]): void {
  if (!snapshot || deltas.length === 0) return;
  let touched = false;
  for (const d of deltas) {
    const it = snapshot.byVariant.get(d.variant_id);
    if (!it || !Number.isFinite(d.qty) || d.qty === 0) continue;
    const next = Number(it.available) - d.qty;
    // Stock is never negative at a till: the sale that produced this delta was
    // already checked against on-hand server-side.
    it.available = next > 0 ? next : 0;
    touched = true;
  }
  if (!touched) return;
  // The signature must move with the data, or the next 200 would compare equal
  // to a catalogue we have since edited and skip a rebuild that is genuinely
  // needed. The ETag is cleared for the same reason: ours no longer describes
  // what we hold, so the next poll must ask for a full answer.
  signature = signatureOf(snapshot.items);
  etag = null;
  emit();
}

/**
 * Ensure the catalogue is loaded. Resolves with whatever we have as fast as
 * possible (IndexedDB cache first) and reconciles with the server in the
 * background. Safe to call repeatedly; concurrent calls share one load.
 */
export async function ensureCatalog(opts?: { force?: boolean }): Promise<CatalogSnapshot> {
  if (snapshot && !opts?.force) {
    if (Date.now() - snapshot.fetchedAt > REFRESH_AFTER_MS) void refreshFromNetwork().catch(() => {});
    return snapshot;
  }
  if (loading && !opts?.force) return loading;

  loading = (async () => {
    // 1. instant: hydrate from IndexedDB so the UI has data immediately.
    if (!snapshot) {
      const cached = await idbGet<{ items: WireRow[]; etag: string | null; fetchedAt: number }>(KEY);
      if (cached?.items?.length) {
        const items = cached.items.map(unpackRow);
        signature = signatureOf(items);
        // Carrying the stored ETag into the first request is what makes a cold
        // start cheap too: a till reopened in the morning revalidates against
        // last night's catalogue and gets a 304 instead of a fresh megabyte.
        etag = cached.etag ?? null;
        snapshot = build(items, cached.fetchedAt, false);
        emit();
      }
    }
    // 2. reconcile with the server; keep the cached copy if offline.
    try {
      await refreshFromNetwork();
    } catch {
      /* offline — cached snapshot (if any) stays usable */
    }
    loading = null;
    return snapshot ?? build([], 0, false);
  })();

  return loading;
}

// ---- lookups -------------------------------------------------------------
export function lookupByBarcode(code: string): CatalogItem | null {
  return snapshot?.byBarcode.get(code) ?? null;
}

/**
 * Robust barcode lookup for scans: exact match first, then forgiving fallbacks
 * (trim, and leading-zero / string-vs-number differences) so a scanned code
 * still resolves when it was stored with a different zero-padding.
 */
export function lookupBarcodeLoose(code: string): CatalogItem | null {
  if (!snapshot || !code) return null;
  const exact = snapshot.byBarcode.get(code);
  if (exact) return exact;
  const trimmed = code.trim();
  if (trimmed !== code) {
    const hit = snapshot.byBarcode.get(trimmed);
    if (hit) return hit;
  }
  if (/^\d+$/.test(trimmed)) {
    // Zero-padding tolerance, but only when UNAMBIGUOUS. Returning the first
    // hit could resolve a scan to a different product than the one on the
    // sticker whenever two codes differ only by leading zeros.
    const bare = trimmed.replace(/^0+/, "") || "0";
    let hit: CatalogItem | null = null;
    for (const [bc, item] of snapshot.byBarcode) {
      if (!/^\d+$/.test(bc) || (bc.replace(/^0+/, "") || "0") !== bare) continue;
      if (hit && hit.variant_id !== item.variant_id) return null; // ambiguous
      hit = item;
    }
    return hit;
  }
  return null;
}

/**
 * Is this string EXACTLY a barcode in the catalogue?
 *
 * Exact equality against the scan index — no prefix, substring, zero-padding
 * or fuzzy fallback of any kind. The wedge detector uses it to decide whether
 * a burst too short to judge on timing alone is a real scan, so anything
 * looser here would hand that decision back to guesswork.
 *
 * Ambiguous codes are already absent from the index (build() drops any code
 * claimed by two variants), so a duplicate can never answer true.
 */
export function isKnownBarcode(code: string): boolean {
  return !!snapshot && !!code && snapshot.byBarcode.has(code);
}

export function lookupByVariant(variantId: string): CatalogItem | null {
  return snapshot?.byVariant.get(variantId) ?? null;
}

/** Substring search over name / option label / sku / barcode. */
export function searchCatalog(q: string, limit = 50): CatalogItem[] {
  if (!snapshot) return [];
  const t = q.trim().toLowerCase();
  if (!t) return snapshot.items.slice(0, limit);
  const out: CatalogItem[] = [];
  for (const it of snapshot.items) {
    if (
      it.product_name.toLowerCase().includes(t) ||
      it.label.toLowerCase().includes(t) ||
      it.sku.toLowerCase().includes(t) ||
      (it.barcodes?.length ? it.barcodes : [it.barcode ?? ""]).some((b) => (b ?? "").includes(t))
    ) {
      out.push(it);
      if (out.length >= limit) break;
    }
  }
  return out;
}
