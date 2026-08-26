// Read-only barcode integrity report for the LIVE database.
//
//   node scripts/barcode-audit.mjs            # human-readable report
//   node scripts/barcode-audit.mjs --csv      # CSV, for handing to the shop
//
// Reports, and CHANGES NOTHING:
//   1. duplicate barcodes  — one code claimed by two different products. These
//      are what would make a scan bill the wrong item, so the POS now refuses
//      to resolve them at all. Each needs a human decision about which product
//      keeps the code.
//   2. variants with NO barcode — items that cannot be scanned at the till.
//   3. variants with more than one PRIMARY barcode — ambiguous "the barcode".
//   4. malformed / suspicious codes — whitespace or control characters inside
//      the stored value (a scanner CR/LF that got saved), non-EAN check digits
//      on 13-digit codes, and codes too short to be scannable.
//   5. internal-sequence health — how close the generator is to exhausting the
//      5-digit weight-template field.
//
// Nothing here writes. Fix duplicates by hand in Products → the variant → Barcode.
import { connect } from "./db.mjs";

const CSV = process.argv.includes("--csv");

const EAN_CHECK = (d12) => {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
};

const Q = {
  duplicates: `
    select b.barcode,
           count(*)                                   as rows,
           count(distinct b.variant_id)               as variants,
           string_agg(distinct p.name || ' / ' || pv.sku, ' | ' order by p.name || ' / ' || pv.sku) as products
      from product_barcodes b
      join product_variants pv on pv.id = b.variant_id
      join products p          on p.id  = pv.product_id
     group by b.barcode
    having count(distinct b.variant_id) > 1
     order by count(*) desc, b.barcode`,

  missing: `
    select p.name, pv.sku, pv.id as variant_id, p.active as product_active, pv.active as variant_active
      from product_variants pv
      join products p on p.id = pv.product_id
     where not exists (select 1 from product_barcodes b where b.variant_id = pv.id)
     order by p.active desc, pv.active desc, p.name, pv.sku`,

  multiPrimary: `
    select p.name, pv.sku, pv.id as variant_id, count(*) as primaries,
           string_agg(b.barcode, ', ' order by b.id) as codes
      from product_barcodes b
      join product_variants pv on pv.id = b.variant_id
      join products p          on p.id  = pv.product_id
     where b.is_primary
     group by p.name, pv.sku, pv.id
    having count(*) > 1
     order by count(*) desc, p.name`,

  all: `
    select b.barcode, b.type, b.is_primary, p.name, pv.sku
      from product_barcodes b
      left join product_variants pv on pv.id = b.variant_id
      left join products p          on p.id  = pv.product_id
     order by p.name nulls last, b.barcode`,

  seq: `select last_value, is_called from internal_barcode_seq`,
};

function classify(code) {
  const bad = [];
  if (code !== code.trim()) bad.push("leading/trailing whitespace");
  if (/[\r\n\t]/.test(code)) bad.push("embedded CR/LF/Tab");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(code)) bad.push("control character");
  if (code.trim().length < 6) bad.push("too short to scan reliably");
  const t = code.trim();
  if (/^\d{13}$/.test(t) && EAN_CHECK(t.slice(0, 12)) !== Number(t[12])) {
    bad.push("13 digits but INVALID EAN-13 check digit");
  }
  return bad;
}

function table(rows, cols) {
  if (!rows.length) return "  (none)";
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (cells) => "  " + cells.map((v, i) => String(v ?? "").padEnd(w[i])).join("  ");
  return [line(cols), line(w.map((n) => "-".repeat(n))), ...rows.map((r) => line(cols.map((c) => r[c])))].join("\n");
}

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

async function main() {
  const db = await connect();
  try {
    const [dup, missing, multi, all, seq] = await Promise.all(
      [Q.duplicates, Q.missing, Q.multiPrimary, Q.all, Q.seq].map((q) => db.query(q).then((r) => r.rows)),
    );

    const malformed = all
      .map((r) => ({ ...r, issues: classify(r.barcode ?? "") }))
      .filter((r) => r.issues.length)
      .map((r) => ({ ...r, issues: r.issues.join("; ") }));

    if (CSV) {
      const out = [["section", "barcode", "product", "sku", "detail"].map(csvCell).join(",")];
      for (const r of dup) out.push(["DUPLICATE", r.barcode, r.products, "", `${r.rows} rows / ${r.variants} variants`].map(csvCell).join(","));
      for (const r of missing) out.push(["NO_BARCODE", "", r.name, r.sku, `variant ${r.variant_id}`].map(csvCell).join(","));
      for (const r of multi) out.push(["MULTI_PRIMARY", r.codes, r.name, r.sku, `${r.primaries} primary rows`].map(csvCell).join(","));
      for (const r of malformed) out.push(["MALFORMED", r.barcode, r.name, r.sku, r.issues].map(csvCell).join(","));
      console.log(out.join("\n"));
      return;
    }

    const seqNow = seq[0] ? Number(seq[0].last_value) : 0;
    console.log(`\nBARCODE AUDIT — ${all.length} barcode rows\n${"=".repeat(60)}`);

    console.log(`\n1. DUPLICATE BARCODES (one code, two products) — ${dup.length}`);
    console.log("   These are the ones that can bill the WRONG product. The POS now");
    console.log("   refuses to resolve them; pick a winner and re-issue the other.");
    console.log(table(dup, ["barcode", "rows", "variants", "products"]));

    console.log(`\n2. VARIANTS WITH NO BARCODE (cannot be scanned) — ${missing.length}`);
    console.log(table(missing.slice(0, 50), ["name", "sku", "product_active", "variant_active"]));
    if (missing.length > 50) console.log(`  … and ${missing.length - 50} more (use --csv for the full list)`);

    console.log(`\n3. VARIANTS WITH >1 PRIMARY BARCODE (ambiguous) — ${multi.length}`);
    console.log(table(multi, ["name", "sku", "primaries", "codes"]));

    console.log(`\n4. MALFORMED / SUSPICIOUS CODES — ${malformed.length}`);
    console.log(table(malformed.slice(0, 50), ["barcode", "name", "sku", "issues"]));
    if (malformed.length > 50) console.log(`  … and ${malformed.length - 50} more (use --csv for the full list)`);

    console.log(`\n5. INTERNAL SEQUENCE — at ${seqNow}`);
    console.log(`   Weight templates use a 5-digit field (max 99999): ${
      seqNow > 99_999 ? "EXHAUSTED — variable-weight codes will be refused" : `${99_999 - seqNow} left`}`);

    const bad = dup.length + multi.length + malformed.length;
    console.log(`\n${"=".repeat(60)}`);
    console.log(bad === 0
      ? "No integrity problems found. Unscannable items above are the only action."
      : `${bad} record(s) need MANUAL correction. Nothing was changed by this script.`);
    console.log("");
    process.exitCode = bad === 0 ? 0 : 1;
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(2); });
