-- ------------------------------------------------------------
-- 0031 — barcode scan integrity
-- ------------------------------------------------------------
-- Fixes the two DATABASE-side contributors to "the barcode doesn't scan / it
-- scans the wrong product" at the till. (The wrong-product bug itself was in
-- the POS client — see src/lib/useHardwareScanner.ts and features/pos.)
--
--   1. catalog_index exposed exactly ONE barcode per variant (`limit 1`), so a
--      product carrying a second code — a manufacturer EAN alongside the
--      internal shelf sticker — could only ever be scanned by whichever one the
--      view happened to pick. Worse, `order by is_primary desc` alone is not a
--      total order, so WHICH one it picked was not stable between fetches.
--      The view now also emits `barcodes`: every code on the variant, primary
--      first then oldest-first, which the client indexes in full.
--
--   2. Re-assert the uniqueness guarantees the scan path depends on. The global
--      UNIQUE on product_barcodes.barcode has been present since 0001 and is
--      the reason two products cannot share a code; this makes that explicit
--      and idempotent, and adds the partial index that stops a variant from
--      holding two competing PRIMARY barcodes (which is what made the old
--      `limit 1` non-deterministic).
--
-- Read-only for existing data: nothing here rewrites a barcode, so no sticker
-- already on a shelf is invalidated.

-- 1. Uniqueness guarantees ---------------------------------------------------

-- Global: one product per barcode. Present since 0001; asserted here so an
-- environment that predates it (or had it dropped by hand) is repaired.
do $$
begin
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'product_barcodes'::regclass
       and c.contype  = 'u'
       and (select array_agg(a.attname order by a.attname)
              from unnest(c.conkey) k
              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k)
           = array['barcode']
  ) and not exists (
    select 1 from pg_indexes
     where tablename = 'product_barcodes' and indexname = 'uq_product_barcodes_barcode'
  ) then
    -- Fails loudly if live data already violates it; barcode-audit.mjs lists
    -- the offenders so they can be corrected by hand first. Never auto-edited.
    create unique index uq_product_barcodes_barcode on product_barcodes(barcode);
  end if;
end $$;

-- At most one PRIMARY barcode per variant, so "the primary barcode" is a
-- single well-defined row rather than an arbitrary pick.
create unique index if not exists uq_barcodes_primary_per_variant
  on product_barcodes(variant_id)
  where is_primary and variant_id is not null;

-- 2. catalog_index: expose EVERY barcode ------------------------------------
create or replace view catalog_index as
  select
    pv.id                                           as variant_id,
    pv.product_id,
    p.name                                          as product_name,
    p.brand,
    p.has_variants,
    p.is_variable_weight,
    pv.sku,
    coalesce(
      (select string_agg(pov.value, ' / ' order by po.sort, pov.sort)
         from variant_option_values vov
         join product_option_values pov on pov.id = vov.option_value_id
         join product_options po        on po.id  = pov.option_id
        where vov.variant_id = pv.id),
      case when pv.is_default then 'Default' else pv.sku end
    )                                               as label,
    -- Primary barcode: what the label printer stamps and the UI shows. The
    -- id tie-breaker makes the pick TOTAL, so it cannot change between fetches.
    (select b.barcode
       from product_barcodes b
      where b.variant_id = pv.id
      order by b.is_primary desc nulls last, b.id
      limit 1)                                      as barcode,
    -- Every barcode on the variant, primary first — the scan index is built
    -- from this, so an alternate code resolves exactly like the primary one.
    coalesce(
      (select array_agg(b.barcode order by b.is_primary desc nulls last, b.id)
         from product_barcodes b
        where b.variant_id = pv.id),
      '{}'::text[]
    )                                               as barcodes,
    pv.sale_price::numeric(14,2)                    as price,
    pv.cost::numeric(14,4)                          as cost,
    p.category_id,
    coalesce(pv.image_url, p.image_url)             as image_url,
    coalesce(va.available, 0)::numeric(14,3)        as available,
    coalesce(va.avg_cost, 0)::numeric(14,4)         as avg_cost,
    (pv.active and p.active)                        as active,
    greatest(pv.updated_at, p.updated_at)           as updated_at,
    pv.default_discount_type                        as disc_type,
    pv.default_discount_value::numeric(14,2)        as disc_value,
    pv.reorder_point::numeric(14,3)                 as reorder_point,
    coalesce(nullif(p.base_unit, ''), 'Pcs')        as unit
  from product_variants pv
  join products p on p.id = pv.product_id
  left join variant_availability va on va.variant_id = pv.id;
