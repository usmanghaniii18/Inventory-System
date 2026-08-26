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

async function refreshFromNetwork(): Promise<void> {
  const res = await fetch("/api/catalog", { cache: "no-store" });
  if (!res.ok) throw new Error(`catalog ${res.status}`);
  const data = (await res.json()) as { items: CatalogItem[] };
  snapshot = build(data.items ?? [], Date.now(), true);
  emit();
  await idbSet(KEY, { items: data.items ?? [], fetchedAt: snapshot.fetchedAt });
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
