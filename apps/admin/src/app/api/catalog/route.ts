import { NextResponse } from "next/server";
import { createClient } from "@hamza/shared/supabase/server";
import { fetchAll } from "@/lib/fetch-all";

// The lightweight catalogue index: one row per sellable variant with name,
// option label, primary barcode, price, cost and live stock. The client caches
// this (in-memory + IndexedDB) so scans and search resolve instantly and keep
// working through brief network drops — see src/lib/catalog-cache.ts.
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Paged (with a unique tie-breaker) so a catalogue over 1000 variants is
  // fully cached for scanning/search — never truncated at the PostgREST cap.
  let data: unknown[];
  try {
    data = await fetchAll((from, to) => supabase
      .from("catalog_index")
      .select(
        "variant_id, product_id, product_name, brand, has_variants, is_variable_weight, sku, label, barcode, price, cost, disc_type, disc_value, reorder_point, category_id, image_url, unit, available, avg_cost, active, updated_at",
      )
      .eq("active", true)
      .order("product_name").order("variant_id").range(from, to));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "catalog error" }, { status: 500 });
  }

  return NextResponse.json(
    { items: data, fetchedAt: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
