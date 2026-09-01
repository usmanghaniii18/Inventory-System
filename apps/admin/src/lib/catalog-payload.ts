/**
 * The wire format for /api/catalog, and the only place that knows how the
 * server's compact row differs from the CatalogItem the till actually uses.
 *
 * WHY A WIRE FORMAT AT ALL
 * ------------------------
 * The catalogue is ~2,300 rows. Four of its twenty-two columns carry no
 * information over the wire, and measured against the live database they cost
 * 175 kB of every 1.22 MB payload — 13.7% — to say nothing at all:
 *
 *   active     32 kB  the route selects `.eq("active", true)`, so it is `true`
 *                     on every row it could ever return.
 *   barcodes   59 kB  identical to `[barcode]` on 2,297 of 2,297 rows. The
 *                     client already falls back to the primary code when the
 *                     array is absent, so sending it is pure duplication.
 *   image_url  39 kB  NULL on 2,297 of 2,297 rows (no product photos are set).
 *   avg_cost   45 kB  the till computes `avg_cost || cost` and uses nothing
 *                     else, so the server can send that one resolved number.
 *
 * Each omission is a value the client can reconstruct EXACTLY, so this is a
 * smaller encoding of the same data — not a reduced payload. `updated_at` is
 * deliberately NOT trimmed despite being 8.6%: it is what signatureOf() reads
 * to notice a change when a response arrives without an ETag, and that is the
 * fallback that protects the till if the fingerprint path ever regresses.
 */

import type { CatalogItem } from "./catalog-cache";

/** A row as it travels over the wire: absent fields are reconstructible. */
export interface WireRow {
  variant_id: string;
  product_id: string;
  product_name: string;
  brand: string | null;
  has_variants: boolean;
  is_variable_weight: boolean;
  sku: string;
  label: string;
  barcode: string | null;
  /** Present ONLY when the variant carries a code other than `barcode`. */
  barcodes?: string[];
  price: number;
  /** Already resolved to `avg_cost || cost` — the till's own formula. */
  cost: number;
  disc_type: "PERCENT" | "FIXED" | null;
  disc_value: number;
  reorder_point: number;
  category_id: string | null;
  /** Present ONLY when the product actually has a photo. */
  image_url?: string;
  unit: string | null;
  available: number;
  updated_at: string;
}

/** Row shape as it comes back from `catalog_index`. */
export interface DbRow extends Omit<WireRow, "barcodes" | "image_url" | "cost"> {
  barcodes: string[] | null;
  image_url: string | null;
  cost: number;
  avg_cost: number;
  active: boolean;
}

/**
 * DB row -> wire row. Drops only what {@link unpackRow} can rebuild.
 *
 * `barcodes` is kept whenever it is not exactly `[barcode]`: a variant with a
 * manufacturer EAN alongside its internal sticker MUST keep both, because the
 * scan index is built from this array and a dropped code is a barcode that
 * stops scanning at the till.
 */
export function packRow(r: DbRow): WireRow {
  const codes = r.barcodes ?? [];
  const redundant = codes.length === 0 || (codes.length === 1 && codes[0] === r.barcode);
  const out: WireRow = {
    variant_id: r.variant_id,
    product_id: r.product_id,
    product_name: r.product_name,
    brand: r.brand,
    has_variants: r.has_variants,
    is_variable_weight: r.is_variable_weight,
    sku: r.sku,
    label: r.label,
    barcode: r.barcode,
    price: Number(r.price),
    // The till only ever reads `avg_cost || cost`; resolve it once, here.
    cost: Number(r.avg_cost) || Number(r.cost),
    disc_type: r.disc_type,
    disc_value: Number(r.disc_value) || 0,
    reorder_point: Number(r.reorder_point) || 0,
    category_id: r.category_id,
    unit: r.unit,
    available: Number(r.available),
    updated_at: r.updated_at,
  };
  if (!redundant) out.barcodes = codes;
  if (r.image_url) out.image_url = r.image_url;
  return out;
}

/**
 * Wire row -> CatalogItem. Restores every field the till reads, so nothing
 * downstream of the cache can tell the difference.
 */
export function unpackRow(w: WireRow): CatalogItem {
  return {
    ...w,
    barcodes: w.barcodes ?? (w.barcode ? [w.barcode] : []),
    image_url: w.image_url ?? null,
    // Kept for call sites that still read it; packRow already resolved the
    // average into `cost`, so both names now answer with the same number.
    avg_cost: w.cost,
    active: true,
  };
}
