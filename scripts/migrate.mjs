// Applies supabase/migrations/*.sql to the hosted database via the
// Supabase connection pooler (IPv4). Auto-detects the project's region.
// Idempotent: tracks applied files in _schema_migrations.
//
//   node scripts/migrate.mjs            -> SUPABASE_PROJECT_REF     (primary)
//   node scripts/migrate.mjs --new      -> NEW_SUPABASE_PROJECT_REF (migration target)
//
// The --new switch exists because a migration between projects is the one time
// two live databases sit side by side in the same .env.local, and "which
// database am I actually pointed at" stops being obvious. Rather than relying
// on shell env precedence — invisible in scrollback, and silently wrong if
// dotenv ever starts overriding — the target is named on the command line and
// echoed back before a single statement runs.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Env lives with the app it belongs to (apps/admin/.env.local) since the
// monorepo split; the repo-root path is kept as a fallback for older checkouts.
// Both are covered by .gitignore's `.env*.local` rule — never commit either.
for (const p of [join(__dirname, "..", "apps", "admin", ".env.local"), join(__dirname, "..", ".env.local")]) {
  dotenv.config({ path: p });
}

const USE_NEW = process.argv.includes("--new");
const REF_VAR = USE_NEW ? "NEW_SUPABASE_PROJECT_REF" : "SUPABASE_PROJECT_REF";
const PW_VAR = USE_NEW ? "NEW_SUPABASE_DB_PASSWORD" : "SUPABASE_DB_PASSWORD";
const REF = process.env[REF_VAR];
const PASSWORD = process.env[PW_VAR];
if (!REF || !PASSWORD) {
  console.error(`Missing ${REF_VAR} or ${PW_VAR} in apps/admin/.env.local`);
  process.exit(1);
}
console.log(`Target: ${REF}   (${REF_VAR})
`);

const REGIONS = [
  "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1",
  "ap-northeast-2", "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "eu-central-1", "eu-west-1", "eu-west-2", "eu-west-3", "eu-north-1",
  "ca-central-1", "sa-east-1",
];
const PREFIXES = ["aws-1", "aws-0"]; // newer projects use aws-1

async function connect() {
  for (const region of REGIONS) {
    for (const prefix of PREFIXES) {
      const host = `${prefix}-${region}.pooler.supabase.com`;
      const client = new pg.Client({
        host,
        port: 5432, // session mode — supports DDL
        user: `postgres.${REF}`,
        password: PASSWORD,
        database: "postgres",
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 8000,
      });
      try {
        await client.connect();
        console.log(`✓ Connected via ${host}`);
        return client;
      } catch {
        await client.end().catch(() => {});
        // wrong region/prefix or transient — keep probing
      }
    }
  }
  throw new Error("Could not connect to any Supabase pooler region.");
}

async function main() {
  const client = await connect();

  await client.query(`
    create table if not exists _schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    );`);

  const dir = join(__dirname, "..", "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const { rows } = await client.query(
      "select 1 from _schema_migrations where name = $1",
      [file],
    );
    if (rows.length) {
      console.log(`• skip ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(dir, file), "utf8");
    process.stdout.write(`→ applying ${file} … `);
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into _schema_migrations(name) values ($1)", [file]);
      await client.query("commit");
      console.log("done");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      console.log("FAILED");
      console.error(e.message);
      await client.end();
      process.exit(1);
    }
  }

  await client.end();
  console.log("\n✓ All migrations applied.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
