import type { Metadata } from "next";
import { createClient } from "@hamza/shared/supabase/server";
import { getCurrentUser } from "@hamza/shared/auth";
import { PosClient, type PosProduct, type StoreSettings } from "@/features/pos/PosClient";
import { PROMO_SELECT, mapPromotion } from "@hamza/shared/promotions";
import { selectAll } from "@/lib/fetch-all";

export const metadata: Metadata = { title: "POS Billing" };

// First paint renders only a light slice of the catalogue; the client cache
// (useCatalog → /api/catalog, mirrored to IndexedDB) immediately hydrates the
// FULL set for scan/search/offline. Rendering — and JS-mapping — the entire
// catalogue per request was the heavy edge work that tripped 1102 here.
const POS_GRID_LIMIT = 60;

export default async function PosPage() {
  const supabase = await createClient();
  // SSR first paint from the single catalogue_index view (1 query instead of the
  // old 5-query JS assembly); the client then takes over with the cached index.
  // `catIds` is a single-column scan used only to build the complete filter-chip
  // list — far cheaper than mapping every variant into a render object per request.
  const [{ data: catalog }, { data: catIds }, { data: customers }, { data: categories }, { data: settings }, { data: promoRows }, user] = await Promise.all([
    supabase
      .from("catalog_index")
      .select("variant_id, product_id, product_name, has_variants, sku, label, barcode, price, avg_cost, cost, disc_type, disc_value, reorder_point, category_id, available, image_url, unit")
      .eq("active", true)
      .order("product_name")
      .limit(POS_GRID_LIMIT),
    // Paged so the category filter-chip list stays complete past 1000 variants.
    selectAll((from, to) => supabase.from("catalog_index").select("category_id").eq("active", true).order("variant_id").range(from, to)),
    supabase.from("customers").select("id, name, phone, address").order("name"),
    supabase.from("categories").select("id, name, parent_id"),
    supabase.from("settings").select("store_name, tax_percent, store_info").eq("id", 1).maybeSingle(),
    supabase.from("discounts").select(PROMO_SELECT).eq("active", true),
    getCurrentUser(),
  ]);

  const promotions = (promoRows ?? []).map(mapPromotion);
  const categoryParents: Record<string, string | null> = {};
  for (const c of categories ?? []) categoryParents[c.id] = c.parent_id ?? null;

  const info = (settings?.store_info ?? {}) as Record<string, string | undefined>;
  const store: StoreSettings = {
    name: settings?.store_name ?? "Hamza General Store",
    address: info.address,
    phone: info.phone,
    ntn: info.ntn,
    logo_url: info.logo_url,
    receipt_header: info.receipt_header,
    receipt_footer: info.receipt_footer,
    receipt_disclaimer: info.receipt_disclaimer,
    tax_percent: Number(settings?.tax_percent ?? 0),
  };

  const catName = new Map((categories ?? []).map((c) => [c.id, c.name]));

  const items: PosProduct[] = (catalog ?? []).map((v) => ({
    variant_id: v.variant_id,
    product_id: v.product_id,
    name: v.product_name,
    label: v.has_variants ? v.label : "",
    sku: v.sku,
    barcode: v.barcode,
    price: Number(v.price),
    cost: Number(v.avg_cost) || Number(v.cost),
    disc_type: (v.disc_type as "PERCENT" | "FIXED" | null) ?? null,
    disc_value: Number(v.disc_value) || 0,
    reorder_point: Number(v.reorder_point) || 0,
    available: Number(v.available),
    category_id: v.category_id,
    image_url: (v.image_url as string) ?? null,
    unit: (v.unit as string) ?? null,
  }));

  // top-level categories present in the WHOLE active catalogue, for the filter
  // chips — derived from the light category_id scan so the chip list stays
  // complete even though the grid itself only first-paints a slice.
  const usedCats = new Set((catIds ?? []).map((c) => c.category_id).filter(Boolean) as string[]);
  const cats = (categories ?? [])
    .filter((c) => usedCats.has(c.id))
    .map((c) => ({ id: c.id, name: c.parent_id ? `${catName.get(c.parent_id) ?? ""} › ${c.name}` : c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const barcodeIndex: Record<string, string> = {};
  for (const v of items) if (v.barcode) barcodeIndex[v.barcode] = v.variant_id;

  return (
    <PosClient
      products={items}
      categories={cats}
      barcodeIndex={barcodeIndex}
      customers={(customers ?? [])
        // The "Walk-in customer" default lives in the selector itself (empty id),
        // so drop any seeded walk-in record to avoid showing it twice.
        .filter((c) => !/^walk[\s-]?in/i.test(c.name))
        .map((c) => ({ id: c.id, name: c.name, phone: c.phone }))}
      store={store}
      cashierName={user?.fullName ?? "Cashier"}
      promotions={promotions}
      categoryParents={categoryParents}
    />
  );
}
