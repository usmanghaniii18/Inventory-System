// Local catalogue cache — the fast path for scanning and search.
//
// The whole sellable catalogue (one light row per variant) is loaded once from
// /api/catalog, held in memory and mirrored to IndexedDB. Scans and search
// resolve against this instantly (no network per scan) and keep working through
// brief network drops; a background fetch reconciles with the server. This is
// the shared index used by the POS today and the universal scanner (Section 2).

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
const KEY = "catalog-v1";
const REFRESH_AFTER_MS = 60_000;

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
      const res = await fetch("/api/catalog", { cache: "no-store" });
      if (!res.ok) throw new Error(`catalog ${res.status}`);
      const data = (await res.json()) as { items: CatalogItem[] };
      const items = data.items ?? [];
      const sig = signatureOf(items);
      if (snapshot && sig === signature) {
        // Same catalogue. Mark it checked so the next tick does not re-fetch,
        // and leave the snapshot object — and therefore the screen — alone.
        //
        // Updated IN PLACE, deliberately. useSyncExternalStore compares what
        // getSnapshot() returns on every render, so handing back a new object
        // would re-render the till anyway, which is the cost this branch exists
        // to avoid. Neither field is rendered; both only drive staleness.
        snapshot.fetchedAt = Date.now();
        snapshot.fresh = true;
        return;
      }
      signature = sig;
      snapshot = build(items, Date.now(), true);
      emit();
      await idbSet(KEY, { items, fetchedAt: snapshot.fetchedAt });
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
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
      const cached = await idbGet<{ items: CatalogItem[]; fetchedAt: number }>(KEY);
      if (cached?.items?.length) {
        signature = signatureOf(cached.items);
        snapshot = build(cached.items, cached.fetchedAt, false);
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
