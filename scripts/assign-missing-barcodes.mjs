// Give every ACTIVE variant that has no barcode a scannable internal one.
//
//   node scripts/assign-missing-barcodes.mjs            # DRY RUN — shows the plan
//   node scripts/assign-missing-barcodes.mjs --apply    # writes
//   node scripts/assign-missing-barcodes.mjs --csv      # results as CSV
//
// This mirrors assignInternalBarcode() in apps/admin/src/features/products/
// actions.ts exactly — same sequence (`internal_barcode_seq`), same generator,
// same INSERT, same retry-past-a-collision behaviour. It exists separately only
// because that function is a Next.js server action behind a manager auth check
// and a Supabase client, neither of which a maintenance script can reach. The
// generator itself is shared with the app via scripts/lib/internal-barcode.mjs,
// and apps/admin/src/lib/barcode.parity.test.ts asserts the two agree.
//
// SAFETY
//   • Only ever INSERTS, for a variant that has NO barcode row at all. It never
//     reads, rewrites or deletes an existing barcode, so no sticker already on
//     a shelf can be invalidated.
//   • Only ACTIVE products with ACTIVE variants. Archived items are left alone.
//   • Each variant is its own transaction: one failure cannot cost the others.
//   • A unique-violation draws a fresh sequence value and retries.
import { connect } from "./db.mjs";
import { generateInternalEan13, generateWeightTemplateEan13 } from "./lib/internal-barcode.mjs";

const APPLY = process.argv.includes("--apply");
const CSV = process.argv.includes("--csv");
const RETRIES = 5;

const TARGETS = `
  select p.name, pv.sku, pv.id as variant_id, p.id as product_id,
         coalesce(p.is_variable_weight, false) as is_variable_weight
    from product_variants pv
    join products p on p.id = pv.product_id
   where not exists (select 1 from product_barcodes b where b.variant_id = pv.id)
     and p.active and pv.active
   order by p.name`;

const isUniqueViolation = (e) =>
  e?.code === "23505" || /duplicate key|unique constraint/i.test(e?.message ?? "");

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

async function assignOne(db, t) {
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      await db.query("begin");
      const { rows } = await db.query("select nextval('internal_barcode_seq') as n");
      const n = Number(rows[0].n);
      const barcode = t.is_variable_weight
        ? generateWeightTemplateEan13(n)
        : generateInternalEan13(n);
      await db.query(
        `insert into product_barcodes(product_id, variant_id, barcode, type, is_primary)
         values ($1, $2, $3, 'INTERNAL', true)`,
        [t.product_id, t.variant_id, barcode],
      );
      await db.query("commit");
      return { ok: true, barcode };
    } catch (e) {
      await db.query("rollback").catch(() => {});
      if (!isUniqueViolation(e)) return { ok: false, error: e.message };
      // collision — draw the next sequence value and try again
    }
  }
  return { ok: false, error: `still colliding after ${RETRIES} attempts` };
}

async function main() {
  const db = await connect();
  try {
    const targets = (await db.query(TARGETS)).rows;

    if (!targets.length) {
      console.log("Every active variant already has a barcode. Nothing to do.");
      return;
    }

    if (!APPLY) {
      console.log(`\nDRY RUN — ${targets.length} active variant(s) would be given a barcode.`);
      console.log("Nothing has been written. Re-run with --apply to write.\n");
      for (const t of targets) console.log(`  ${t.name.trim()}  (sku ${t.sku})`);
      console.log("");
      return;
    }

    const results = [];
    for (const t of targets) {
      const res = await assignOne(db, t);
      results.push({ name: t.name.trim(), sku: t.sku, ...res });
      if (!res.ok) console.error(`  ! ${t.name.trim()}: ${res.error}`);
    }

    const done = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    if (CSV) {
      console.log(["Product", "SKU", "Barcode"].map(csvCell).join(","));
      for (const r of done) console.log([r.name, r.sku, r.barcode].map(csvCell).join(","));
      return;
    }

    const w1 = Math.max(7, ...done.map((r) => r.name.length));
    const w2 = Math.max(3, ...done.map((r) => r.sku.length));
    console.log(`\nASSIGNED ${done.length} BARCODE(S)\n`);
    console.log(`  ${"Product".padEnd(w1)}  ${"SKU".padEnd(w2)}  Barcode`);
    console.log(`  ${"-".repeat(w1)}  ${"-".repeat(w2)}  -------------`);
    for (const r of done) console.log(`  ${r.name.padEnd(w1)}  ${r.sku.padEnd(w2)}  ${r.barcode}`);
    if (failed.length) {
      console.log(`\n${failed.length} FAILED:`);
      for (const r of failed) console.log(`  ${r.name} — ${r.error}`);
      process.exitCode = 1;
    }
    console.log("\nPrint labels for these from Products → the item → Label.\n");
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(2); });
