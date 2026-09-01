-- ------------------------------------------------------------
-- 0032 — catalog_fingerprint(): the cheap "has anything changed?" probe
-- ------------------------------------------------------------
-- Why this exists: EGRESS.
--
-- /api/catalog served the whole catalogue — 2,297 rows, ~1.22 MB of JSON —
-- on every request, with `force-dynamic` + `Cache-Control: no-store` and a
-- client `fetch(..., { cache: "no-store" })`. A till polls once a minute, so
-- ONE idle screen that nobody touches pulled ~73 MB/hour out of Supabase and
-- ~16 GB over nineteen days. That is what exhausted the project's egress quota
-- and took every login down with it (the whole project 402s, auth included).
--
-- The client already had the right idea: catalog-cache.ts fingerprinted the
-- payload so an UNCHANGED catalogue would not re-render the till. But it
-- computed that fingerprint from the payload it had just downloaded, so it
-- saved a React render and not one single byte.
--
-- This function moves the same question to where it can actually be answered
-- cheaply: Postgres computes the fingerprint and returns 40-odd bytes. The API
-- route asks THIS first and only re-reads the full catalogue when the answer
-- changed, so a poll over an unchanged catalogue costs ~0.003% of what it did.
--
-- WHAT GOES INTO THE FINGERPRINT, AND WHY EXACTLY THESE THREE COLUMNS
--   variant_id  — catches an add, a delete, or a variant being de/re-activated.
--   updated_at  — greatest(pv.updated_at, p.updated_at) in catalog_index, so it
--                 moves on any edit: name, price, cost, barcode, discount, unit.
--   available   — MUST be listed separately. It comes from variant_availability,
--                 an aggregate over stock movements, and a sale or a goods
--                 receipt changes it WITHOUT touching either updated_at column.
--                 Fingerprinting on updated_at alone would let a till keep
--                 serving stale stock indefinitely — exactly the "sold item
--                 still shows in stock" class of bug.
--
-- Ordering is explicit (order by variant_id) so the hash is stable: without it
-- the aggregate would follow whatever order the scan happened to produce and
-- the fingerprint would change when nothing had.
--
-- Read-only. Creates no table, rewrites no row, touches no existing object.

create or replace function public.catalog_fingerprint()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    count(*)::text || ':' || md5(string_agg(
      variant_id::text || '|' || updated_at::text || '|' || available::text,
      ',' order by variant_id
    )),
    '0:empty'
  )
  from catalog_index
  where active;
$$;

comment on function public.catalog_fingerprint() is
  'Cheap change-detection for the sellable catalogue. Returns "<count>:<md5>" '
  'over (variant_id, updated_at, available) of every active row. /api/catalog '
  'polls this instead of re-reading ~1.2 MB of JSON on every till refresh.';

-- The POS calls this with the signed-in user's own token, not the service key.
revoke all on function public.catalog_fingerprint() from public;
grant execute on function public.catalog_fingerprint() to authenticated, service_role;
