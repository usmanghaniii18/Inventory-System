"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@hamza/shared/supabase/server";
import { createAdminClient } from "@hamza/shared/supabase/admin";
import { getCurrentUser } from "@hamza/shared/auth";
import { selectAll } from "@/lib/fetch-all";

/**
 * PHASE J — archived products and their history, surfaced under Categories.
 *
 * Diagnosis first: is an archived product still in the database?
 * -------------------------------------------------------------
 * YES. "Archive" is a soft delete — `setProductActive(id, false)` only flips
 * `products.active`, leaving the product, its variants, its barcodes and every
 * stock_move / sale_item row untouched. The permanent-delete path
 * (`permanentlyDeleteProduct`) additionally REFUSES to run for any product that
 * has appeared in a stock move, sale, order, reservation or purchase order, so a
 * product with history can never be hard-deleted in the first place.
 *
 * So the history was never lost — it simply had nowhere to be viewed, because
 * every product surface filters on `active = true`. This module reads it back.
 *
 * Cost control: the Categories page loads only a COUNT of archived products per
 * category. The full per-product history is fetched on demand when an admin
 * expands one category, so a store with a long archive never pays for it up
 * front.
 */

export interface ArchivedVariantRow {
  variant_id: string;
  sku: string;
  barcode: string | null;
  on_hand: number;
  avg_cost: number;
}

export interface ArchivedProductRow {
  id: string;
  name: string;
  sku: string;
  brand: string | null;
  category_id: string | null;
  image_url: string | null;
  variants: ArchivedVariantRow[];
  /** Stock still sitting on the shelf under this archived product. */
  on_hand: number;
  stock_value: number;
  /** Lifetime sales history (never cleared by archiving). */
  units_sold: number;
  revenue: number;
  last_sold_at: string | null;
  /** Most recent ledger movement of any kind (receipt, sale, adjustment). */
  last_movement_at: string | null;
}

/** How many archived products sit in each category (cheap, page-level). */
export async function getArchivedCounts(): Promise<Record<string, number>> {
  const supabase = await createClient();
  const rows = await selectAll<{ id: string; category_id: string | null }>((from, to) =>
    supabase.from("products").select("id, category_id").eq("active", false).order("id").range(from, to));
  const out: Record<string, number> = {};
  for (const r of rows.data ?? []) {
    const key = r.category_id ?? "__uncategorised__";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/**
 * Full archived-product history for ONE category (or the uncategorised bucket,
 * via the sentinel id "__uncategorised__"). Loaded on demand.
 */
export async function getArchivedProductsForCategory(categoryId: string): Promise<{ rows: ArchivedProductRow[] } | { error: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: "Not authorized." };
  const supabase = await createClient();

  let pq = supabase
    .from("products")
    .select("id, name, sku, brand, category_id, image_url")
    .eq("active", false)
    .order("name");
  pq = categoryId === "__uncategorised__" ? pq.is("category_id", null) : pq.eq("category_id", categoryId);
  const { data: products, error } = await pq;
  if (error) return { error: error.message };
  if (!products?.length) return { rows: [] };

  const productIds = products.map((p) => p.id as string);

  const { data: variants } = await selectAll<{ id: string; product_id: string; sku: string }>((from, to) =>
    supabase.from("product_variants").select("id, product_id, sku").in("product_id", productIds).order("id").range(from, to));
  const variantIds = variants.map((v) => v.id);

  const [avail, barcodes, saleItems, moves] = await Promise.all([
    variantIds.length
      ? selectAll<{ variant_id: string; on_hand: number; avg_cost: number }>((from, to) =>
          supabase.from("variant_availability").select("variant_id, on_hand, avg_cost").in("variant_id", variantIds).order("variant_id").range(from, to))
      : Promise.resolve({ data: [] }),
    variantIds.length
      ? selectAll<{ variant_id: string; barcode: string; is_primary: boolean }>((from, to) =>
          supabase.from("product_barcodes").select("variant_id, barcode, is_primary").in("variant_id", variantIds).order("variant_id").range(from, to))
      : Promise.resolve({ data: [] }),
    // Lifetime sales history for these products — the whole point of the screen.
    selectAll<{ product_id: string; qty: number; line_total: number; sales: { created_at: string } | { created_at: string }[] | null }>((from, to) =>
      supabase.from("sale_items").select("product_id, qty, line_total, sales(created_at)").in("product_id", productIds).order("id").range(from, to)),
    selectAll<{ product_id: string; created_at: string }>((from, to) =>
      supabase.from("stock_moves").select("product_id, created_at").in("product_id", productIds).order("created_at", { ascending: false }).range(from, to)),
  ]);

  const availOf = new Map((avail.data ?? []).map((a) => [a.variant_id, a]));
  const barcodeOf = new Map<string, string>();
  for (const b of barcodes.data ?? []) if (!barcodeOf.has(b.variant_id) || b.is_primary) barcodeOf.set(b.variant_id, b.barcode);

  const sold = new Map<string, { qty: number; revenue: number; last: string | null }>();
  for (const it of saleItems.data ?? []) {
    const rel = it.sales;
    const at = (Array.isArray(rel) ? rel[0]?.created_at : rel?.created_at) ?? null;
    const cur = sold.get(it.product_id) ?? { qty: 0, revenue: 0, last: null };
    cur.qty += Number(it.qty);
    cur.revenue += Number(it.line_total);
    if (at && (!cur.last || at > cur.last)) cur.last = at;
    sold.set(it.product_id, cur);
  }

  const lastMove = new Map<string, string>();
  for (const m of moves.data ?? []) {
    const cur = lastMove.get(m.product_id);
    if (!cur || m.created_at > cur) lastMove.set(m.product_id, m.created_at);
  }

  const variantsByProduct = new Map<string, ArchivedVariantRow[]>();
  for (const v of variants) {
    const a = availOf.get(v.id);
    const arr = variantsByProduct.get(v.product_id) ?? [];
    arr.push({
      variant_id: v.id,
      sku: v.sku,
      barcode: barcodeOf.get(v.id) ?? null,
      on_hand: a ? Number(a.on_hand) : 0,
      avg_cost: a ? Number(a.avg_cost) : 0,
    });
    variantsByProduct.set(v.product_id, arr);
  }

  const rows: ArchivedProductRow[] = products.map((p) => {
    const vs = variantsByProduct.get(p.id as string) ?? [];
    const s = sold.get(p.id as string);
    return {
      id: p.id as string,
      name: p.name as string,
      sku: p.sku as string,
      brand: (p.brand as string) ?? null,
      category_id: (p.category_id as string) ?? null,
      image_url: (p.image_url as string) ?? null,
      variants: vs,
      on_hand: vs.reduce((t, v) => t + v.on_hand, 0),
      stock_value: vs.reduce((t, v) => t + v.on_hand * v.avg_cost, 0),
      units_sold: s?.qty ?? 0,
      revenue: s?.revenue ?? 0,
      last_sold_at: s?.last ?? null,
      last_movement_at: lastMove.get(p.id as string) ?? null,
    };
  });

  return { rows };
}

/**
 * Bring an archived product back into the active catalogue. Reuses the same
 * `products.active` flag the Products screen's Archive/Restore uses, so this is
 * the identical operation — just reachable from Categories too.
 */
export async function restoreArchivedProduct(productId: string): Promise<{ ok: true } | { error: string }> {
  const user = await getCurrentUser();
  if (!user || (user.role !== "owner" && user.role !== "manager")) return { error: "Not authorized." };
  const db = createAdminClient();
  const { error } = await db.from("products").update({ active: true }).eq("id", productId);
  if (error) return { error: error.message };
  revalidatePath("/admin/categories");
  revalidatePath("/admin/products");
  revalidatePath("/admin/stock");
  return { ok: true };
}
