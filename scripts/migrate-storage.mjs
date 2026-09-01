// ------------------------------------------------------------------
// Copy Supabase Storage objects between projects, and re-point the URLs the
// database holds at the new project's domain.
//
//   node scripts/migrate-storage.mjs --dry-run
//   node scripts/migrate-storage.mjs            copy files + rewrite URLs
//   node scripts/migrate-storage.mjs --urls-only   rewrite URLs, copy nothing
//
// SOURCE is the project in NEW_SUPABASE_* (after the Sep 2026 migration that
// pair points at the OLD project — see apps/admin/.env.local), TARGET is the
// project in NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
//
// WHY THIS IS SEPARATE FROM migrate-project-data.mjs
// --------------------------------------------------
// storage.objects rows are only metadata. The bytes live in Supabase's own
// object store and are reachable ONLY over the HTTP Storage API — there is no
// path to them through the Postgres connection. Copying the metadata rows
// alone would have produced a database full of URLs pointing at files that do
// not exist, which is worse than an empty bucket: the app would render broken
// images instead of its no-image fallback.
//
// That distinction is why this could not run during the migration. The old
// project is suspended for exceeding its egress quota, and a suspended project
// 402s the Storage API — with the service_role key, and for a public object,
// because the restriction is applied at the edge ahead of authentication:
//
//   GET /storage/v1/object/public/product-images/branding/logo-…jpeg  ->  402
//
// So the files stay where they are until that suspension is cleared. This
// script exists so that moment is one command, not an afternoon.
// ------------------------------------------------------------------
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", "apps", "admin", ".env.local") });
for (const oid of [1114, 1184, 1082, 114]) pg.types.setTypeParser(oid, (v) => v);

const DRY = process.argv.includes("--dry-run");
const URLS_ONLY = process.argv.includes("--urls-only");

const SRC_REF = process.env.NEW_SUPABASE_PROJECT_REF; // the retained old project
const SRC_URL = `https://${SRC_REF}.supabase.co`;
const DST_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const DST_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// The old project's service key, kept commented in .env.local for rollback.
function oldServiceKey() {
  try {
    const txt = readFileSync(join(__dirname, "..", "apps", "admin", ".env.local"), "utf8");
    return (txt.match(/^#\s*SUPABASE_SERVICE_ROLE_KEY=(.+)$/m) || [])[1]?.trim() || null;
  } catch { return null; }
}

async function reachable(base, key) {
  try {
    const r = await fetch(`${base}/storage/v1/bucket`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    return { ok: r.ok, status: r.status, body: r.ok ? null : (await r.text()).slice(0, 160) };
  } catch (e) { return { ok: false, status: 0, body: e.message }; }
}

async function copyObjects(srcKey) {
  const src = new pg.Client({
    host: "aws-1-ap-south-1.pooler.supabase.com", port: 5432,
    user: `postgres.${SRC_REF}`, password: process.env.NEW_SUPABASE_DB_PASSWORD,
    database: "postgres", ssl: { rejectUnauthorized: false },
  });
  await src.connect();
  const { rows } = await src.query(
    `select bucket_id, name, (metadata->>'mimetype') mime, (metadata->>'size')::bigint size
       from storage.objects order by bucket_id, name`);
  await src.end();
  console.log(`\n${rows.length} object(s) to copy:`);

  let ok = 0, failed = 0;
  for (const o of rows) {
    const line = `  ${o.bucket_id}/${o.name} (${o.size} B)`;
    if (DRY) { console.log(`${line}  [dry-run]`); continue; }
    try {
      const got = await fetch(`${SRC_URL}/storage/v1/object/${o.bucket_id}/${encodeURI(o.name)}`,
        { headers: { apikey: srcKey, Authorization: `Bearer ${srcKey}` } });
      if (!got.ok) { console.log(`${line}  DOWNLOAD FAILED HTTP ${got.status}`); failed++; continue; }
      const buf = Buffer.from(await got.arrayBuffer());
      const put = await fetch(`${DST_URL}/storage/v1/object/${o.bucket_id}/${encodeURI(o.name)}`, {
        method: "POST",
        headers: {
          apikey: DST_KEY, Authorization: `Bearer ${DST_KEY}`,
          "Content-Type": o.mime || "application/octet-stream",
          "x-upsert": "true",
        },
        body: buf,
      });
      if (!put.ok) { console.log(`${line}  UPLOAD FAILED HTTP ${put.status} ${(await put.text()).slice(0, 90)}`); failed++; continue; }
      console.log(`${line}  copied`);
      ok++;
    } catch (e) { console.log(`${line}  ERROR ${e.message.slice(0, 70)}`); failed++; }
  }
  return { ok, failed, total: rows.length };
}

/**
 * Re-point every stored URL at the target project.
 *
 * Done as a plain string swap of the project subdomain, so a path is never
 * rewritten — the object key on the new project is identical to the old one,
 * which is what lets the file copy and the URL rewrite happen in either order.
 */
async function rewriteUrls() {
  const dst = new pg.Client({
    host: "aws-0-ap-south-1.pooler.supabase.com", port: 5432,
    user: `postgres.${process.env.SUPABASE_PROJECT_REF}`, password: process.env.SUPABASE_DB_PASSWORD,
    database: "postgres", ssl: { rejectUnauthorized: false },
  });
  await dst.connect();

  const { rows: cols } = await dst.query(
    `select table_name, column_name, data_type from information_schema.columns
      where table_schema='public' and data_type in ('text','jsonb') order by 1,2`);

  const changes = [];
  for (const { table_name: t, column_name: c, data_type: dt } of cols) {
    const cast = dt === "jsonb" ? `${c}::text` : c;
    let hit;
    try {
      hit = await dst.query(
        `select count(*)::int n from public.${JSON.stringify(t).replace(/"/g, '"')} where ${cast} like $1`,
        [`%${SRC_REF}.supabase.co%`]);
    } catch { continue; }
    if (!hit.rows[0].n) continue;
    changes.push({ t, c, dt, n: hit.rows[0].n });
    if (DRY) continue;
    const expr = dt === "jsonb"
      ? `replace(${c}::text, $1, $2)::jsonb`
      : `replace(${c}, $1, $2)`;
    await dst.query(
      `update public.${JSON.stringify(t).replace(/"/g, '"')} set ${c} = ${expr} where ${cast} like $3`,
      [`${SRC_REF}.supabase.co`, `${DST_URL.replace(/^https?:\/\//, "")}`, `%${SRC_REF}.supabase.co%`]);
  }
  await dst.end();
  return changes;
}

async function main() {
  if (!DST_URL || !DST_KEY) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  console.log(`SOURCE (files): ${SRC_URL}`);
  console.log(`TARGET (files): ${DST_URL}${DRY ? "   [DRY RUN]" : ""}`);

  if (!URLS_ONLY) {
    const srcKey = oldServiceKey();
    const s = await reachable(SRC_URL, srcKey || DST_KEY);
    console.log(`\nsource Storage API: HTTP ${s.status}${s.ok ? " reachable" : ""}`);
    if (!s.ok) {
      console.log(`  ${s.body}`);
      console.log("\n  Files CANNOT be copied while the source project is restricted.");
      console.log("  Clear its egress suspension, then re-run this script.");
      console.log("  Continuing with the URL rewrite only.\n");
    } else {
      const r = await copyObjects(srcKey);
      console.log(`\ncopied ${r.ok}/${r.total}, failed ${r.failed}`);
    }
  }

  const changes = await rewriteUrls();
  console.log(`\nURL references to ${SRC_REF}.supabase.co:`);
  if (!changes.length) console.log("  none found — nothing points at the old project");
  for (const c of changes) console.log(`  ${DRY ? "would rewrite" : "rewrote"} ${c.t}.${c.c} (${c.dt}) — ${c.n} row(s)`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
