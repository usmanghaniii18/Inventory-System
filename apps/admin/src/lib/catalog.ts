import type { createClient } from "@hamza/shared/supabase/server";
import { selectAll } from "@/lib/fetch-all";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export interface VariantOption {
  variant_id: string;
  product_id: string;
  product_name: string;
  brand: string | null;
  label: string;
  sku: string;
  barcode: string | null;
  cost: number;
  sale_price: number;
  category_id: string | null;
  has_variants: boolean;
}

export interface VariantName {
  variant_id: string;
  product_id: string;
  product_name: string;
  label: string;
  category_id: string | null;
}

/**
 * Name/label lookup for EVERY variant — including ARCHIVED products and INACTIVE
 * variants. Historical records (stock moves, past sales, stock-addition report)
 * must always render a product name even after the product is later archived;
 * getVariantOptions() deliberately drops archived/inactive (it powers active
 * pickers), which is why those rows showed blank. Use THIS for displaying the
 * name of a past record; use getVariantOptions() to build live pickers.
 */
export async function getVariantNames(supabase: Supabase): Promise<Map<string, VariantName>> {
  // Paged (selectAll) + no active filter: the full catalogue, past and present.
  const [{ data: variants }, { data: products }, { data: optionValues }, { data: vov }] = await Promise.all([
    selectAll((from, to) => supabase.from("product_variants").select("id, product_id, sku, is_default").order("id").range(from, to)),
    selectAll((from, to) => supabase.from("products").select("id, name, category_id").order("id").range(from, to)),
    selectAll((from, to) => supabase.from("product_option_values").select("id, value").order("id").range(from, to)),
    selectAll((from, to) => supabase.from("variant_option_values").select("variant_id, option_value_id").order("variant_id").order("option_value_id").range(from, to)),
  ]);

  const productMap = new Map((products ?? []).map((p) => [p.id, p]));
  const valLabel = new Map((optionValues ?? []).map((v) => [v.id, v.value]));
  const labels = new Map<string, string[]>();
  for (const link of vov ?? []) {
    const val = valLabel.get(link.option_value_id);
    if (!val) continue;
    const arr = labels.get(link.variant_id) ?? [];
    arr.push(val);
    labels.set(link.variant_id, arr);
  }

  const out = new Map<string, VariantName>();
  for (const v of variants ?? []) {
    const p = productMap.get(v.product_id);
    out.set(v.id, {
      variant_id: v.id,
      product_id: v.product_id,
      product_name: (p?.name as string) ?? "—",
      label: (labels.get(v.id) ?? []).join(" / ") || (v.is_default ? "Default" : v.sku),
      category_id: (p?.category_id as string) ?? null,
    });
  }
  return out;
}

/**
 * Flat, searchable list of every active variant with a composed option label
 * (e.g. "Ruby Red / 3.5g"). Shared by Purchasing pickers and POS.
 */
export async function getVariantOptions(supabase: Supabase): Promise<VariantOption[]> {
  // Every read below is paged (selectAll) so a catalogue larger than 1000
  // variants/products never silently truncates.
  const [{ data: variants }, { data: products }, { data: barcodes }, { data: optionValues }, { data: vov }] =
    await Promise.all([
      selectAll((from, to) => supabase.from("product_variants").select("id, product_id, sku, cost, sale_price, is_default, active").eq("active", true).order("id").range(from, to)),
      selectAll((from, to) => supabase.from("products").select("id, name, brand, category_id, has_variants, active").order("id").range(from, to)),
      selectAll((from, to) => supabase.from("product_barcodes").select("variant_id, barcode, is_primary").order("id").range(from, to)),
      selectAll((from, to) => supabase.from("product_option_values").select("id, value").order("id").range(from, to)),
      selectAll((from, to) => supabase.from("variant_option_values").select("variant_id, option_value_id").order("variant_id").order("option_value_id").range(from, to)),
    ]);

  const productMap = new Map((products ?? []).map((p) => [p.id, p]));
  const barcodeMap = new Map<string, string>();
  for (const b of barcodes ?? []) if (!barcodeMap.has(b.variant_id) || b.is_primary) barcodeMap.set(b.variant_id, b.barcode);
  const valLabel = new Map((optionValues ?? []).map((v) => [v.id, v.value]));
  const labels = new Map<string, string[]>();
  for (const link of vov ?? []) {
    const val = valLabel.get(link.option_value_id);
    if (!val) continue;
    const arr = labels.get(link.variant_id) ?? [];
    arr.push(val);
    labels.set(link.variant_id, arr);
  }

  return (variants ?? [])
    .map((v) => {
      const p = productMap.get(v.product_id);
      if (!p || p.active === false) return null;
      return {
        variant_id: v.id,
        product_id: v.product_id,
        product_name: p.name as string,
        brand: (p.brand as string) ?? null,
        label: (labels.get(v.id) ?? []).join(" / ") || (v.is_default ? "Default" : v.sku),
        sku: v.sku,
        barcode: barcodeMap.get(v.id) ?? null,
        cost: Number(v.cost),
        sale_price: Number(v.sale_price),
        category_id: (p.category_id as string) ?? null,
        has_variants: Boolean(p.has_variants),
      } as VariantOption;
    })
    .filter((x): x is VariantOption => x !== null)
    .sort((a, b) => a.product_name.localeCompare(b.product_name) || a.label.localeCompare(b.label));
}
