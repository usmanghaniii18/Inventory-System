// Shared connector for one-off DB scripts. Reuses migrate.mjs's region probing.
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

// `--new` points a one-off script at NEW_SUPABASE_PROJECT_REF instead of the
// primary one. Added for the project-to-project migration, where two live
// databases sit in the same .env.local and every audit needs running against
// both to be worth anything.
const USE_NEW = process.argv.includes("--new");
const REF = USE_NEW ? process.env.NEW_SUPABASE_PROJECT_REF : process.env.SUPABASE_PROJECT_REF;
const PASSWORD = USE_NEW ? process.env.NEW_SUPABASE_DB_PASSWORD : process.env.SUPABASE_DB_PASSWORD;

const REGIONS = [
  "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1",
  "ap-northeast-2", "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "eu-central-1", "eu-west-1", "eu-west-2", "eu-west-3", "eu-north-1",
  "ca-central-1", "sa-east-1",
];
const PREFIXES = ["aws-1", "aws-0"];

export async function connect() {
  if (!REF || !PASSWORD) throw new Error("Missing SUPABASE_PROJECT_REF or SUPABASE_DB_PASSWORD");
  for (const region of REGIONS) {
    for (const prefix of PREFIXES) {
      const host = `${prefix}-${region}.pooler.supabase.com`;
      const client = new pg.Client({
        host, port: 5432, user: `postgres.${REF}`, password: PASSWORD,
        database: "postgres", ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000,
      });
      try { await client.connect(); if (process.env.DB_VERBOSE) console.log(`  (${REF} via ${host})`); return client; }
      catch { await client.end().catch(() => {}); }
    }
  }
  throw new Error("Could not connect to any Supabase pooler region.");
}
