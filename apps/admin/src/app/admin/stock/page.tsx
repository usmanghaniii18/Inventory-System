import type { Metadata } from "next";
import { createClient } from "@hamza/shared/supabase/server";
import { selectAll } from "@/lib/fetch-all";
import { StockClient, type StockRow, type PhysLocation } from "@/features/stock/StockClient";

export const metadata: Metadata = { title: "Stock" };

export default async function StockPage() {
  const supabase = await createClient();

  // Each variant carries its product and barcodes via DB-side joins (PostgREST
  // embeds), so the edge function makes fewer round-trips and skips building the
  // product/barcode lookup maps. The dead product_options scan (its rows were
  // never read) is gone; option labels still come from the two option tables.
  const [
    { data: variants }, { data: categories },
    { data: availability }, { data: levels }, { data: locations },
    { data: optionValues }, { data: vov },
  ] = await Promise.all([
    // Active variants only; archived products (products.active = false) are
    // inactive — they must not appear in stock, the low-stock tile, or the
    // low_stock filter the dashboard deep-links to. The product's `active` is
    // pulled through the embed and re-checked below (a variant can be active
    // under an archived product).
    // Paged so >1000 variants / >1000 stock-level rows never truncate.
    selectAll((from, to) => supabase
      .from("product_variants")
      .select("id, product_id, sku, reorder_point, is_default, products(name, base_unit, category_id, active), product_barcodes(barcode, is_primary)")
      .eq("active", true).order("id").range(from, to)),
    supabase.from("categories").select("id, name, parent_id, sort").order("sort").order("name"),
    selectAll((from, to) => supabase.from("variant_availability").select("variant_id, on_hand, reserved, available, avg_cost").order("variant_id").range(from, to)),
    selectAll((from, to) => supabase.from("stock_levels").select("variant_id, location_id, on_hand").order("variant_id").order("location_id").range(from, to)),
    supabase.from("locations").select("id, code, name, type").eq("type", "PHYSICAL").order("code"),
    selectAll((from, to) => supabase.from("product_option_values").select("id, value").order("id").range(from, to)),
    selectAll((from, to) => supabase.from("variant_option_values").select("variant_id, option_value_id").order("variant_id").order("option_value_id").range(from, to)),
  ]);

  const catName = new Map((categories ?? []).map((c) => [c.id, c.name]));
  const availMap = new Map((availability ?? []).map((a) => [a.variant_id, a]));

  const valLabel = new Map((optionValues ?? []).map((v) => [v.id, v.value]));
  const variantLabels = new Map<string, string[]>();
  for (const link of vov ?? []) {
    const val = valLabel.get(link.option_value_id);
    if (!val) continue;
    const arr = variantLabels.get(link.variant_id) ?? [];
    arr.push(val);
    variantLabels.set(link.variant_id, arr);
  }

  const physLocs = (locations ?? []) as { id: string; code: string; name: string }[];
  const physById = new Map(physLocs.map((l) => [l.id, l]));
  const byLoc = new Map<string, Map<string, number>>(); // variant_id -> code -> on_hand
  for (const l of levels ?? []) {
    const loc = physById.get(l.location_id);
    if (!loc) continue;
    const m = byLoc.get(l.variant_id) ?? new Map();
    m.set(loc.code, (m.get(loc.code) ?? 0) + Number(l.on_hand));
    byLoc.set(l.variant_id, m);
  }

  type Prod = { name: string; base_unit: string; category_id: string | null; active: boolean };
  const productOf = (v: { products: unknown }) => {
    const prod = v.products as Prod | Prod[] | null;
    return Array.isArray(prod) ? prod[0] ?? null : prod;
  };

  const rows: StockRow[] = (variants ?? [])
    // Drop archived products (products.active = false) — inactive, so never part
    // of the active stock view, its low-stock tile, or the low_stock filter.
    .filter((v) => { const p = productOf(v); return p != null && p.active !== false; })
    .map((v) => {
    const p = productOf(v);
    const bcs = (v.product_barcodes ?? []) as { barcode: string; is_primary: boolean }[];
    // primary barcode if one exists, else the first — matches the old map's pick.
    const barcode = bcs.find((b) => b.is_primary)?.barcode ?? bcs[0]?.barcode ?? null;
    const av = availMap.get(v.id);
    const on_hand = av ? Number(av.on_hand) : 0;
    const avg_cost = av ? Number(av.avg_cost) : 0;
    const locMap = byLoc.get(v.id) ?? new Map();
    return {
      id: v.id,
      variant_id: v.id,
      product_id: v.product_id,
      product_name: p?.name ?? "—",
      label: (variantLabels.get(v.id) ?? []).join(" / ") || (v.is_default ? "Default" : v.sku),
      sku: v.sku,
      barcode,
      base_unit: p?.base_unit ?? "pcs",
      category: p?.category_id ? (catName.get(p.category_id) ?? "—") : "—",
      category_id: p?.category_id ?? null,
      reorder_point: Number(v.reorder_point),
      on_hand,
      reserved: av ? Number(av.reserved) : 0,
      available: av ? Number(av.available) : 0,
      avg_cost,
      value: on_hand * avg_cost,
      byLocation: physLocs.map((l) => ({ code: l.code, name: l.name, on_hand: locMap.get(l.code) ?? 0 })),
    };
  }).sort((a, b) => a.product_name.localeCompare(b.product_name) || a.label.localeCompare(b.label));

  // A category is offered in the filter if it (or, for a main category, any of
  // its sub-categories) actually has products — same rollup as the product
  // count, so a main category with only sub-categorised products still shows up.
  const allCats = (categories ?? []) as { id: string; name: string; parent_id: string | null }[];
  const directCatIds = new Set(rows.map((r) => r.category_id).filter(Boolean) as string[]);
  const childrenOf = new Map<string, string[]>();
  for (const c of allCats) if (c.parent_id) childrenOf.set(c.parent_id, [...(childrenOf.get(c.parent_id) ?? []), c.id]);
  const hasProductsCache = new Map<string, boolean>();
  const hasProducts = (id: string): boolean => {
    const cached = hasProductsCache.get(id);
    if (cached !== undefined) return cached;
    const result = directCatIds.has(id) || (childrenOf.get(id) ?? []).some(hasProducts);
    hasProductsCache.set(id, result);
    return result;
  };
  const catOptions = allCats
    .filter((c) => hasProducts(c.id))
    .map((c) => ({ id: c.id, name: c.name, parent_id: c.parent_id }));

  const locOptions: PhysLocation[] = physLocs.map((l) => ({ code: l.code, name: l.name }));

  return <StockClient rows={rows} categories={catOptions} locations={locOptions} />;
}
