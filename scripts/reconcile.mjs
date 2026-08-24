// READ-ONLY. Definitive reconciliation:
// (A) Recompute every (variant,location,lot) on_hand from the FULL append-only
//     ledger and compare to stock_levels cache. Any diff = trigger drift.
// (B) Blank-name audit: how many stock_moves / variants would render blank in
//     the Stock page and Stock-Addition report, and WHY.
import { connect } from "./db.mjs";
const q = async (c, sql, p = []) => (await c.query(sql, p)).rows;
const db = await connect();

// ---------- (A) Ledger vs cache ----------
const ledger = await q(db, `
  with deltas as (
    select variant_id, from_location_id as loc, lot_id, -sum(qty) as d
      from stock_moves where from_location_id is not null group by variant_id, from_location_id, lot_id
    union all
    select variant_id, to_location_id as loc, lot_id, sum(qty) as d
      from stock_moves where to_location_id is not null group by variant_id, to_location_id, lot_id
  )
  select variant_id, loc, lot_id, sum(d) as expected from deltas group by variant_id, loc, lot_id`);
const key = (r) => `${r.variant_id}|${r.loc ?? r.location_id}|${r.lot_id ?? 'null'}`;
const expMap = new Map(ledger.map((r) => [key(r), Number(r.expected)]));

const cache = await q(db, `select variant_id, location_id as loc, lot_id, on_hand from stock_levels`);
const cacheMap = new Map(cache.map((r) => [key(r), Number(r.on_hand)]));

let drift = 0; const driftRows = [];
const allKeys = new Set([...expMap.keys(), ...cacheMap.keys()]);
for (const k of allKeys) {
  const e = expMap.get(k) ?? 0, c = cacheMap.get(k) ?? 0;
  if (Math.abs(e - c) > 0.0001) { drift++; if (driftRows.length < 30) driftRows.push({ k, ledger: e, cache: c }); }
}
console.log(`(A) Ledger-vs-cache reconciliation over ${allKeys.size} (variant,loc,lot) cells:`);
console.log(`    DRIFT cells (cache != ledger): ${drift}`);
driftRows.forEach((r) => console.log(`    ${r.k}  ledger=${r.ledger} cache=${r.cache}  diff=${(r.cache - r.ledger).toFixed(3)}`));

// Also physical-only per-variant available drift (what the UI shows)
const physExp = await q(db, `
  with deltas as (
    select variant_id, from_location_id as loc, -sum(qty) as d from stock_moves where from_location_id is not null group by variant_id, from_location_id
    union all
    select variant_id, to_location_id as loc, sum(qty) as d from stock_moves where to_location_id is not null group by variant_id, to_location_id
  )
  select d.variant_id, sum(d.d) as expected from deltas d
  join locations l on l.id=d.loc and l.type='PHYSICAL' group by d.variant_id`);
const physExpMap = new Map(physExp.map((r) => [r.variant_id, Number(r.expected)]));
const va = await q(db, `select variant_id, on_hand from variant_availability`);
const vaMap = new Map(va.map((r) => [r.variant_id, Number(r.on_hand)]));
let vaDrift = 0; const vaRows = [];
for (const [vid, e] of physExpMap) { const c = vaMap.get(vid) ?? 0; if (Math.abs(e - c) > 0.0001) { vaDrift++; if (vaRows.length < 20) vaRows.push({ vid, e, c }); } }
console.log(`\n    variant_availability physical on_hand drift vs ledger: ${vaDrift}`);
vaRows.forEach((r) => console.log(`    ${r.vid.slice(0,8)} ledger=${r.e} view=${r.c}`));

// ---------- (B) Blank-name audit ----------
console.log(`\n(B) Blank-name audit:`);
// B1: variants whose product.name is null/empty
const emptyName = await q(db, `select count(*)::int n from product_variants pv join products p on p.id=pv.product_id where coalesce(trim(p.name),'')=''`);
console.log(`    B1 variants with empty product name: ${emptyName[0].n}`);
// B2: active variants under ARCHIVED products (dropped by getVariantOptions -> "—")
const archVar = await q(db, `select count(*)::int n from product_variants pv join products p on p.id=pv.product_id where pv.active and p.active=false`);
console.log(`    B2 active variants under archived products (report shows "—"): ${archVar[0].n}`);
// B3: INACTIVE variants that still have stock_moves (getVariantOptions filters active=true only)
const inactiveWithMoves = await q(db, `
  select count(distinct sm.variant_id)::int n from stock_moves sm
  join product_variants pv on pv.id=sm.variant_id where pv.active=false`);
console.log(`    B3 inactive variants that have stock_moves (report/stock '—'): ${inactiveWithMoves[0].n}`);
// B4: supplier-origin moves (stock additions) whose variant is missing from getVariantOptions
const addMovesBlank = await q(db, `
  select count(*)::int n from stock_moves sm
  join locations l on l.id=sm.from_location_id and l.type='SUPPLIER'
  left join (select pv.id from product_variants pv join products p on p.id=pv.product_id where pv.active and p.active) ok on ok.id=sm.variant_id
  where ok.id is null`);
console.log(`    B4 stock-addition moves whose variant is NOT in getVariantOptions (=> blank in Stock Addition report): ${addMovesBlank[0].n}`);
// B5: total stock-addition moves for context
const addTotal = await q(db, `select count(*)::int n from stock_moves sm join locations l on l.id=sm.from_location_id and l.type='SUPPLIER'`);
console.log(`    B5 total stock-addition moves: ${addTotal[0].n}`);

// B6: distinct products that appear on Stock page (active variant + active product)
const stockPageProds = await q(db, `select count(*)::int n from product_variants pv join products p on p.id=pv.product_id where pv.active and p.active`);
console.log(`    B6 active variants shown on Stock page (name from embed): ${stockPageProds[0].n}`);

await db.end();
console.log("\ndone (read-only)");
