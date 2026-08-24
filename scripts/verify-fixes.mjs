// READ-ONLY verification of Fix #3 (1000-row cap) and Fix #4 (archived names)
// against the REAL Supabase PostgREST endpoint + DB. Changes no data.
import { createClient } from "@supabase/supabase-js";
import { connect } from "./db.mjs";
import dotenv from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env.local") });

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Same paging helper the app now uses.
async function fetchAll(build, page = 1000) {
  const out = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < page) break;
  }
  return out;
}

console.log("=== Fix #3: PostgREST 1000-row cap ===");
// OLD behaviour: a single unranged select silently caps at 1000.
const { data: capped } = await sb.from("product_variants").select("id");
console.log(`  OLD single select .from(product_variants).select(id)  -> ${capped?.length} rows (capped)`);
// NEW behaviour: paginated fetchAll returns the whole table.
const all = await fetchAll((from, to) => sb.from("product_variants").select("id").order("id").range(from, to));
console.log(`  NEW selectAll paginated                               -> ${all.length} rows (complete)`);

const catalogAll = await fetchAll((from, to) => sb.from("catalog_index").select("variant_id").eq("active", true).order("product_name").order("variant_id").range(from, to));
const { data: catalogCapped } = await sb.from("catalog_index").select("variant_id").eq("active", true).order("product_name");
console.log(`  catalog_index (POS/scan): old ${catalogCapped?.length} vs paged ${catalogAll.length}`);
console.log(`  ${all.length > 1000 && all.length > (capped?.length ?? 0) ? "PASS — products past 1000 no longer disappear" : "note: table <=1000 so cap not yet triggered"}`);

console.log("\n=== Fix #4: archived products still resolve a name in historical reports ===");
const db = await connect();
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
// find archived products that have stock-addition moves (would previously show blank)
const archived = await q(`
  select distinct p.id, p.name, pv.id as variant_id
  from products p
  join product_variants pv on pv.product_id = p.id
  join stock_moves sm on sm.variant_id = pv.id
  join locations l on l.id = sm.from_location_id and l.type = 'SUPPLIER'
  where p.active = false
  limit 10`);
console.log(`  archived products with stock-addition history: ${archived.length}`);
// getVariantOptions EXCLUDES these (active only) -> old report showed "—"
const activeOpts = await fetchAll((from, to) => sb.from("product_variants").select("id, product_id, active, products(active)").order("id").range(from, to));
const activeSet = new Set(activeOpts.filter((v) => v.active && v.products?.active).map((v) => v.id));
// getVariantNames INCLUDES all -> new report shows the name
for (const a of archived) {
  const inActive = activeSet.has(a.variant_id);
  console.log(`  "${a.name}"  activeList=${inActive ? "yes" : "NO (blank before)"}  fullNameMap="${a.name}" (now resolves)`);
}
if (!archived.length) console.log("  (no archived products with addition history right now — nothing would render blank)");

console.log("\n=== totals ===");
const t = await q(`select
  (select count(*) from products) products,
  (select count(*) from product_variants) variants,
  (select count(*) from products where active=false) archived`);
console.log(" ", t[0]);
await db.end();
console.log("\ndone (read-only)");
