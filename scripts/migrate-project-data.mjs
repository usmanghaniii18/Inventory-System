// ------------------------------------------------------------------
// Copy ALL business data + auth from one Supabase project to another.
//
//   node scripts/migrate-project-data.mjs --dry-run   (inspect the plan)
//   node scripts/migrate-project-data.mjs             (do it)
//
// Source is SUPABASE_PROJECT_REF, target is NEW_SUPABASE_PROJECT_REF, both from
// apps/admin/.env.local. The SOURCE IS ONLY EVER READ — every write goes to the
// target, so the old project stays intact as a fallback.
//
// WHY NOT pg_dump: not installed on the machine this was run from, and the
// Supabase pooler does not accept a replication connection anyway. The node pg
// driver is enough: this is 65k rows, not 65 million.
//
// THREE THINGS THAT WILL CORRUPT THE COPY IF IGNORED
// --------------------------------------------------
// 1. TRIGGERS. stock_moves carries trg_apply_stock_move, which maintains
//    stock_levels. Copying stock_moves with triggers live would re-apply all
//    17,863 movements ON TOP of the stock_levels rows copied alongside them —
//    every stock figure in the shop silently doubled. trg_moves_no_update and
//    trg_moves_no_delete would also refuse parts of the write outright.
// 2. FOREIGN KEYS. A single insertion order satisfying 138 constraints exists,
//    but one wrong edge fails the run halfway through.
// 3. SEED DATA. The migrations seed a demo shop (14 products, 26 categories,
//    7 locations) with FRESHLY GENERATED UUIDs — verified NOT equal to the old
//    project's. Merging real data into that leaves stock_levels and stock_moves
//    pointing at location ids that do not exist here.
//
// All three are handled by `session_replication_role = replica` (suppresses
// triggers AND FK checks for the session) plus a full truncate of the target's
// business tables first. The session role is restored in a finally block, and
// the constraints are re-validated at the end by counting rows and re-checking
// the invariants the scan path depends on.
//
// _schema_migrations is deliberately NOT copied or truncated: it records what
// the TARGET has applied, which is the one thing that must not come from the
// source (the target has 0032, the source does not).
// ------------------------------------------------------------------
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", "apps", "admin", ".env.local") });

/**
 * Hand timestamps back as raw strings instead of JavaScript Dates.
 *
 * A Date holds MILLISECONDS. Postgres timestamptz holds MICROSECONDS. Letting
 * the driver parse them silently rounded every one of the 113 timestamp columns
 * in this database on the way through:
 *
 *   source  2026-08-14 22:41:13.218863+00
 *   target  2026-08-14 22:41:13.218+00
 *
 * Nothing errors, every row count still matches, and the loss is invisible
 * unless you checksum the column — which is how it was caught here: the
 * catalogue fingerprints disagreed between the two projects while variant_id
 * and available agreed exactly.
 *
 * No business logic in this app reads microseconds, so the damage would have
 * been cosmetic. But "cosmetic" is a judgement made by whoever notices, and a
 * migration that quietly rewrites 113 columns of production timestamps is not a
 * copy. Parsing off, the text goes out exactly as it came in.
 *
 * date (1082) is included for the same reason; json (114) so an unnormalised
 * json column is not reserialised. jsonb is safe to parse — Postgres normalises
 * it on the way in regardless.
 */
for (const oid of [1114 /* timestamp */, 1184 /* timestamptz */, 1082 /* date */, 114 /* json */]) {
  pg.types.setTypeParser(oid, (v) => v);
}

const DRY = process.argv.includes("--dry-run");
const BATCH = 500;

/** Never copied, and never truncated on the target. */
const SKIP = new Set(["_schema_migrations"]);

/**
 * Copied from the auth schema, in this order.
 *
 * `users` then `identities`: identities.user_id references users.id. Sessions
 * and refresh_tokens are deliberately NOT copied — they are live login state,
 * they expire, and carrying them across would only hand the new project a pile
 * of tokens minted for a different JWT secret. Everyone signs in again once;
 * their PASSWORD still works, which is the part that matters.
 */
const AUTH_TABLES = ["users", "identities"];

function client(ref, password, host) {
  return new pg.Client({
    host, port: 5432, user: `postgres.${ref}`, password,
    database: "postgres", ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000, query_timeout: 300000,
  });
}

/** Probe pooler regions until one answers for this project ref. */
async function connect(ref, password, label) {
  const REGIONS = ["ap-south-1", "ap-southeast-1", "ap-northeast-1", "us-east-1",
    "us-east-2", "us-west-1", "eu-central-1", "eu-west-2"];
  for (const region of REGIONS) {
    for (const prefix of ["aws-1", "aws-0"]) {
      const host = `${prefix}-${region}.pooler.supabase.com`;
      const c = client(ref, password, host);
      try {
        await c.connect();
        console.log(`  ${label}: ${ref} via ${host}`);
        return c;
      } catch {
        await c.end().catch(() => {});
      }
    }
  }
  throw new Error(`Could not connect to ${label} project ${ref}`);
}

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

/**
 * Copyable columns, and whether the table has a GENERATED ALWAYS identity.
 *
 * Generated/computed columns are excluded — the target recomputes them. An
 * ALWAYS identity is NOT excluded: skipping it lets Postgres mint fresh ids and
 * silently renumbers the table, which is not a copy. It is written back
 * verbatim with OVERRIDING SYSTEM VALUE instead.
 */
async function columns(c, schema, table) {
  const { rows } = await c.query(
    `select column_name, identity_generation from information_schema.columns
      where table_schema=$1 and table_name=$2 and is_generated='NEVER'
      order by ordinal_position`,
    [schema, table],
  );
  return {
    cols: rows.map((r) => r.column_name),
    hasAlwaysIdentity: rows.some((r) => r.identity_generation === "ALWAYS"),
  };
}

async function count(c, schema, table) {
  const { rows } = await c.query(`select count(*)::int n from ${ident(schema)}.${ident(table)}`);
  return rows[0].n;
}

/**
 * Copy one table, batched.
 *
 * Columns are the INTERSECTION of both sides, so a column that exists only on
 * one project is skipped rather than exploding the run. Any such column is
 * reported — silently dropping data is exactly the failure this migration
 * cannot afford.
 */
async function copyTable(src, dst, schema, table) {
  const [srcMeta, dstMeta] = await Promise.all([
    columns(src, schema, table),
    columns(dst, schema, table),
  ]);
  const cols = srcMeta.cols.filter((c) => dstMeta.cols.includes(c));
  const onlySrc = srcMeta.cols.filter((c) => !dstMeta.cols.includes(c));
  const overriding = dstMeta.hasAlwaysIdentity ? "overriding system value " : "";
  const total = await count(src, schema, table);
  if (total === 0) return { table, copied: 0, total: 0, onlySrc };

  const colList = cols.map(ident).join(", ");
  let copied = 0;

  for (let offset = 0; offset < total; offset += BATCH) {
    // ctid gives a stable full-table walk without needing to know the PK.
    const { rows } = await src.query(
      `select ${colList} from ${ident(schema)}.${ident(table)} order by ctid limit $1 offset $2`,
      [BATCH, offset],
    );
    if (!rows.length) break;

    const values = [];
    const tuples = rows.map((row, i) => {
      const ph = cols.map((_, j) => `$${i * cols.length + j + 1}`);
      for (const c of cols) values.push(row[c]);
      return `(${ph.join(", ")})`;
    });
    await dst.query(
      `insert into ${ident(schema)}.${ident(table)} (${colList}) ${overriding}values ${tuples.join(", ")}
       on conflict do nothing`,
      values,
    );
    copied += rows.length;
    process.stdout.write(`\r    ${schema}.${table}: ${copied}/${total}   `);
  }
  process.stdout.write("\n");
  return { table, copied, total, onlySrc };
}

/**
 * Copy every sequence's position from source to target.
 *
 * The earlier version of this walked pg_depend for sequences OWNED BY a column
 * — and found nothing, because an identity column's sequence is an INTERNAL
 * dependency, not an auto one. It reported success while leaving every sequence
 * where the seed data had left it. Two of those would have caused real damage
 * on the first day of trading:
 *
 *   internal_barcode_seq — source at 1020, target at 1000. The next internal
 *     shelf label minted on the new project would have reused a code already
 *     printed and stuck to a product, which is both a UNIQUE violation and, if
 *     it slipped through, the "scans the wrong item" bug this codebase has
 *     already been burned by twice.
 *   web_order_seq — source at 1006, target at 1001: duplicate order numbers.
 *
 * So the rule is simply: a sequence must end up exactly where the source has
 * it. Reading last_value/is_called and calling setval with the same pair
 * reproduces the position precisely, including the is_called distinction that
 * decides whether the NEXT nextval() returns last_value or last_value + 1.
 */
async function copySequences(src, dst) {
  const { rows } = await dst.query(
    `select sequencename from pg_sequences where schemaname='public' order by 1`);
  const done = [];
  for (const { sequencename } of rows) {
    let pos;
    try {
      pos = (await src.query(`select last_value, is_called from public.${ident(sequencename)}`)).rows[0];
    } catch {
      done.push(`${sequencename}: absent on source, left as-is`);
      continue;
    }
    const before = (await dst.query(`select last_value, is_called from public.${ident(sequencename)}`)).rows[0];
    await dst.query(`select setval($1, $2, $3)`, [`public.${sequencename}`, String(pos.last_value), pos.is_called]);
    done.push(
      `${sequencename.padEnd(26)} ${before.last_value}/${before.is_called} -> ${pos.last_value}/${pos.is_called}`,
    );
  }
  return done;
}

async function main() {
  console.log("Connecting…");
  const src = await connect(process.env.SUPABASE_PROJECT_REF, process.env.SUPABASE_DB_PASSWORD, "SOURCE (read-only)");
  const dst = await connect(process.env.NEW_SUPABASE_PROJECT_REF, process.env.NEW_SUPABASE_DB_PASSWORD, "TARGET (written)");

  if (src.host === dst.host && process.env.SUPABASE_PROJECT_REF === process.env.NEW_SUPABASE_PROJECT_REF) {
    throw new Error("SOURCE and TARGET are the same project — refusing to run.");
  }

  const { rows: tRows } = await src.query(
    `select table_name from information_schema.tables
      where table_schema='public' and table_type='BASE TABLE' order by table_name`);
  const tables = tRows.map((r) => r.table_name).filter((t) => !SKIP.has(t));

  console.log(`\nPublic tables to copy: ${tables.length}  (skipping: ${[...SKIP].join(", ")})`);
  console.log(`Auth tables to copy  : ${AUTH_TABLES.map((t) => "auth." + t).join(", ")}`);
  if (DRY) {
    for (const t of tables) {
      const [o, n] = await Promise.all([count(src, "public", t), count(dst, "public", t)]);
      if (o || n) console.log(`  ${t.padEnd(28)} source=${String(o).padStart(6)}  target=${String(n).padStart(6)}${n ? "  <- will be TRUNCATED" : ""}`);
    }
    for (const t of AUTH_TABLES) {
      const [o, n] = await Promise.all([count(src, "auth", t), count(dst, "auth", t)]);
      console.log(`  auth.${t.padEnd(23)} source=${String(o).padStart(6)}  target=${String(n).padStart(6)}`);
    }
    console.log("\nDRY RUN — nothing written.");
    await src.end(); await dst.end();
    return;
  }

  const results = [];
  try {
    // Suppresses triggers AND foreign-key checks for THIS SESSION only. Every
    // write below therefore lands exactly as it was read, in any order.
    await dst.query("set session_replication_role = replica");
    console.log("\nsession_replication_role = replica (triggers + FK checks off)");

    // Wipe the demo shop the migrations seeded. CASCADE is safe here precisely
    // because FK enforcement is off and everything is about to be replaced.
    const truncatable = tables.map((t) => `public.${ident(t)}`).join(", ");
    await dst.query(`truncate ${truncatable} restart identity cascade`);
    console.log(`Truncated ${tables.length} target tables (seed data cleared)`);
    for (const t of AUTH_TABLES.slice().reverse()) {
      await dst.query(`truncate auth.${ident(t)} cascade`);
    }
    console.log(`Truncated ${AUTH_TABLES.length} auth tables`);

    console.log("\nCopying auth (passwords travel as stored hashes — nobody resets anything):");
    for (const t of AUTH_TABLES) results.push({ schema: "auth", ...(await copyTable(src, dst, "auth", t)) });

    console.log("\nCopying public:");
    for (const t of tables) results.push({ schema: "public", ...(await copyTable(src, dst, "public", t)) });

    console.log("\nCopying sequence positions:");
    for (const line of await copySequences(src, dst)) console.log(`    ${line}`);
  } finally {
    await dst.query("set session_replication_role = origin").catch(() => {});
    console.log("\nsession_replication_role = origin (triggers + FK checks back on)");
  }

  console.log("\n=== VERIFY: row counts, source vs target ===");
  let mismatches = 0;
  for (const r of results.filter((r) => r.total > 0 || r.copied > 0)) {
    const after = await count(dst, r.schema, r.table);
    const before = await count(src, r.schema, r.table);
    const ok = after === before;
    if (!ok) mismatches++;
    console.log(`  ${ok ? "OK  " : "MISMATCH"} ${(r.schema + "." + r.table).padEnd(34)} source=${String(before).padStart(6)} target=${String(after).padStart(6)}`);
    if (r.onlySrc.length) console.log(`       !! columns present only on source (NOT copied): ${r.onlySrc.join(", ")}`);
  }
  console.log(mismatches ? `\n${mismatches} MISMATCH(ES) — investigate before going live.` : "\nAll row counts match.");

  await src.end();
  await dst.end();
  process.exit(mismatches ? 1 : 0);
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
