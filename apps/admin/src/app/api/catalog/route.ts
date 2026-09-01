import { NextResponse } from "next/server";
import { createClient } from "@hamza/shared/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import { packRow, type DbRow } from "@/lib/catalog-payload";
import { load as loadCatalog } from "@/lib/catalog-server-cache";
import { noteServed } from "@/lib/catalog-egress-guard";

// The lightweight catalogue index: one row per sellable variant with name,
// option label, EVERY barcode on the variant, price, cost and live stock. The
// client caches this (in-memory + IndexedDB) so scans and search resolve
// instantly and keep working through brief network drops — see
// src/lib/catalog-cache.ts.
//
// EGRESS — READ THIS BEFORE ADDING `no-store` BACK
// -----------------------------------------------
// This route used to declare `dynamic = "force-dynamic"` and answer with
// `Cache-Control: no-store`, and the client fetched it with `cache: "no-store"`
// too. Every till poll therefore re-read ~1.22 MB from Supabase and pushed all
// of it to the browser. One idle screen cost ~73 MB/hour; nineteen days of that
// exhausted the project's egress quota, and a restricted Supabase project 402s
// its auth endpoints as well — which is how a caching bug in the product grid
// became a total login outage for every cashier.
//
// The route is still uncacheable by any shared cache, and must stay that way:
// it is per-user and cookie-authenticated. Freshness now comes from validation
// rather than from refusing to cache:
//
//   - `no-cache` (NOT `no-store`) lets the browser keep the body and revalidate
//     it. `no-store` forbids keeping it at all, which makes a 304 impossible.
//   - `private` keeps it out of any CDN or proxy — this payload is served on a
//     signed-in session and must never be shared between users.
//   - `must-revalidate` forbids serving it stale if the server is unreachable.
//
// The ETag is the catalogue's fingerprint, so an unchanged catalogue answers
// 304 with no body at all, and catalog-server-cache decides whether Supabase
// even needs to be asked. Nothing here is time-based: a change is visible on
// the next poll, exactly as before.
export const dynamic = "force-dynamic";

const COLUMNS =
  "variant_id, product_id, product_name, brand, has_variants, is_variable_weight, " +
  "sku, label, barcode, barcodes, price, cost, disc_type, disc_value, reorder_point, " +
  "category_id, image_url, unit, available, avg_cost, active, updated_at";

const CACHE_HEADERS = { "Cache-Control": "private, no-cache, must-revalidate" };

export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let cached;
  try {
    cached = await loadCatalog({
      // Cheap change-probe (migration 0032). A missing function is not an
      // error here — the cache falls back to hashing the rows it reads — so a
      // deploy that lands before the migration still serves correct data.
      fingerprint: async () => {
        const { data, error } = await supabase.rpc("catalog_fingerprint");
        if (error || typeof data !== "string") return null;
        return data;
      },
      // Paged (with a unique tie-breaker) so a catalogue over 1000 variants is
      // fully cached for scanning/search — never truncated at the PostgREST cap.
      rows: async () => {
        const rows = await fetchAll<DbRow>((from, to) =>
          supabase
            .from("catalog_index")
            .select(COLUMNS)
            .eq("active", true)
            .order("product_name")
            .order("variant_id")
            .range(from, to) as unknown as PromiseLike<{ data: DbRow[] | null; error: unknown }>,
        );
        return rows.map(packRow);
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "catalog error" },
      { status: 500 },
    );
  }

  const etag = `"${cached.fingerprint}"`;

  // The till already holds this exact catalogue. Answer with no body — this is
  // the branch that carries the overwhelming majority of requests, because the
  // shop is not editing products most of the minutes of the day.
  if (req.headers.get("if-none-match") === etag) {
    noteServed("304");
    return new NextResponse(null, { status: 304, headers: { ...CACHE_HEADERS, ETag: etag } });
  }

  // Counted so a silently broken validator shows up in the Railway logs on the
  // first day rather than as an outage on the nineteenth. See catalog-egress-guard.
  noteServed("full");
  return NextResponse.json(
    { items: cached.rows, fetchedAt: new Date().toISOString() },
    { headers: { ...CACHE_HEADERS, ETag: etag } },
  );
}
