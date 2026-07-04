import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./fetch-all";

// Server-side paginated products query. Both the SSR page (first page) and the
// "load more" / search server action call this, so a product list never loads
// the whole table: each call fetches one page of products plus the related
// variants / barcodes / availability / option labels for ONLY those product ids.

export interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  label: string;
  cost: number;
  sale_price: number;
  reorder_point: number;
  default_discount_type: "PERCENT" | "FIXED" | null;
  default_discount_value: number;
  is_default: boolean;
  active: boolean;
  image_url: string | null;
  barcode: string | null;
  on_hand: number;
  available: number;
  avg_cost: number;
}

export interface ProductRow {
  id: string;
  sku: string;
  name: string;
  brand: string | null;
  category_id: string | null;
  category: string;
  base_unit: string;
  description: string | null;
  has_variants: boolean;
  is_variable_weight: boolean;
  active: boolean;
  image_url: string | null;
  variants: VariantRow[];
  variant_count: number;
  on_hand: number;
  stock_value: number;
  price_min: number;
  price_max: number;
  low: boolean;
  out: boolean;
}

export interface ProductsPage {
  rows: ProductRow[];
  total: number;
  offset: number;
  limit: number;
}

export interface ProductsQuery {
  q?: string;
  categoryId?: string;
  /** Fetch exactly one product by id (used when the scanner opens it to edit). */
  productId?: string;
  offset?: number;
  limit?: number;
}

export const PRODUCTS_PAGE_SIZE = 20;

/** Sanitize a search term for a PostgREST `or(...ilike...)` filter. */
function sanitize(q: string) {
  return q.replace(/[(),%*]/g, " ").trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchProductsPage(supabase: SupabaseClient<any>, params: ProductsQuery = {}): Promise<ProductsPage> {
  const limit = params.limit ?? PRODUCTS_PAGE_SIZE;
  const offset = params.offset ?? 0;
  const term = params.q ? sanitize(params.q) : "";

  // 1. one page of parent products (filtered + counted, bounded by range)
  let pq = supabase
    .from("products")
    .select("id, sku, name, brand, category_id, base_unit, description, default_sale_price, has_variants, is_variable_weight, active, image_url", {
      count: "exact",
    })
    .order("name")
    .order("id")
    .range(offset, offset + limit - 1);
  if (params.productId) pq = pq.eq("id", params.productId);
  if (params.categoryId) pq = pq.eq("category_id", params.categoryId);
  if (term) pq = pq.or(`name.ilike.%${term}%,brand.ilike.%${term}%,sku.ilike.%${term}%`);

  const { data: products, count, error } = await pq;
  if (error) throw error;

  const ids = (products ?? []).map((p) => p.id as string);
  if (!ids.length) return { rows: [], total: count ?? 0, offset, limit };

  // 2. related rows for ONLY this page's products. Each `.in(ids)` read is paged
  // (selectAll) with a stable order so a large page (e.g. a bulk export chunk)
  // never silently stops at PostgREST's 1000-row cap — a page's variants /
  // barcodes / availability all load in full no matter how many there are.
  const [{ data: categories }, { data: variants }, { data: options }, { data: optionValues }] = await Promise.all([
    supabase.from("categories").select("id, name, parent_id"),
    selectAll((from, to) => supabase
      .from("product_variants")
      .select("id, product_id, sku, cost, sale_price, reorder_point, default_discount_type, default_discount_value, is_default, active, image_url")
      .in("product_id", ids)
      .order("is_default", { ascending: false }).order("id").range(from, to)),
    supabase.from("product_options").select("id, product_id, name, sort").in("product_id", ids).order("sort"),
    // Paged so option-value labels stay complete once the catalogue's variant
    // options exceed 1000 rows overall.
    selectAll((from, to) => supabase.from("product_option_values").select("id, option_id, value, sort").order("id").range(from, to)),
  ]);

  const variantIds = (variants ?? []).map((v) => v.id as string);
  const [{ data: availability }, { data: barcodes }, { data: vov }] = await Promise.all([
    selectAll((from, to) => supabase.from("variant_availability").select("variant_id, on_hand, reserved, available, avg_cost").in("variant_id", variantIds).order("variant_id").range(from, to)),
    selectAll((from, to) => supabase.from("product_barcodes").select("variant_id, barcode, is_primary").in("variant_id", variantIds).order("variant_id").order("barcode").range(from, to)),
    selectAll((from, to) => supabase.from("variant_option_values").select("variant_id, option_value_id").in("variant_id", variantIds).order("variant_id").order("option_value_id").range(from, to)),
  ]);

  const catName = new Map((categories ?? []).map((c) => [c.id, c.name as string]));
  const availMap = new Map((availability ?? []).map((a) => [a.variant_id, a]));
  const barcodeMap = new Map<string, string>();
  for (const b of barcodes ?? []) {
    if (!barcodeMap.has(b.variant_id) || b.is_primary) barcodeMap.set(b.variant_id, b.barcode as string);
  }

  const valLabel = new Map((optionValues ?? []).map((v) => [v.id, v.value as string]));
  const variantLabels = new Map<string, string[]>();
  for (const link of vov ?? []) {
    const val = valLabel.get(link.option_value_id);
    if (!val) continue;
    const arr = variantLabels.get(link.variant_id) ?? [];
    arr.push(val);
    variantLabels.set(link.variant_id, arr);
  }
  void options; // option names not needed for the label join here

  const variantsByProduct = new Map<string, VariantRow[]>();
  for (const v of variants ?? []) {
    const av = availMap.get(v.id);
    const row: VariantRow = {
      id: v.id,
      product_id: v.product_id,
      sku: v.sku,
      label: (variantLabels.get(v.id) ?? []).join(" / ") || (v.is_default ? "Default" : v.sku),
      cost: Number(v.cost),
      sale_price: Number(v.sale_price),
      reorder_point: Number(v.reorder_point),
      default_discount_type: (v.default_discount_type as "PERCENT" | "FIXED" | null) ?? null,
      default_discount_value: Number(v.default_discount_value) || 0,
      is_default: v.is_default,
      active: v.active,
      image_url: (v.image_url as string) ?? null,
      barcode: barcodeMap.get(v.id) ?? null,
      on_hand: av ? Number(av.on_hand) : 0,
      available: av ? Number(av.available) : 0,
      avg_cost: av ? Number(av.avg_cost) : 0,
    };
    const arr = variantsByProduct.get(v.product_id) ?? [];
    arr.push(row);
    variantsByProduct.set(v.product_id, arr);
  }

  const rows: ProductRow[] = (products ?? []).map((p) => {
    const vs = variantsByProduct.get(p.id) ?? [];
    const prices = vs.map((v) => v.sale_price).filter((n) => n > 0);
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      brand: p.brand ?? null,
      category_id: p.category_id,
      category: p.category_id ? catName.get(p.category_id) ?? "—" : "—",
      base_unit: p.base_unit,
      description: (p.description as string) ?? null,
      has_variants: p.has_variants,
      is_variable_weight: p.is_variable_weight,
      active: p.active,
      image_url: (p.image_url as string) ?? null,
      variants: vs,
      variant_count: vs.length,
      on_hand: vs.reduce((s, v) => s + v.on_hand, 0),
      stock_value: vs.reduce((s, v) => s + v.on_hand * v.avg_cost, 0),
      price_min: prices.length ? Math.min(...prices) : Number(p.default_sale_price),
      price_max: prices.length ? Math.max(...prices) : Number(p.default_sale_price),
      low: vs.some((v) => v.available > 0 && v.available <= v.reorder_point),
      out: vs.length > 0 && vs.every((v) => v.available <= 0),
    };
  });

  return { rows, total: count ?? 0, offset, limit };
}

// Chunk size for a full-catalogue read (export). Kept moderate so each page's
// parent `.range(...)` and its related `.in(ids)` reads both stay well under
// PostgREST's 1000-row cap and the URL stays short — the loop then walks through
// the ENTIRE (optionally filtered) catalogue, so nothing is dropped up to
// 15,000+ products.
const EXPORT_CHUNK = 200;

/**
 * Fetch EVERY product (optionally filtered by search / category) by walking the
 * paginated {@link fetchProductsPage} in {@link EXPORT_CHUNK}-sized pages. Used
 * by the Products export so the file reflects the full set, not just the first
 * 1000 rows a single unbounded query would return.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchAllProducts(supabase: SupabaseClient<any>, params: ProductsQuery = {}): Promise<ProductRow[]> {
  const out: ProductRow[] = [];
  for (let offset = 0; ; offset += EXPORT_CHUNK) {
    const page = await fetchProductsPage(supabase, { ...params, offset, limit: EXPORT_CHUNK });
    out.push(...page.rows);
    if (page.rows.length < EXPORT_CHUNK || out.length >= page.total) break;
  }
  return out;
}
