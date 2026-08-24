-- ------------------------------------------------------------
-- 0030 — Harden the product <-> variant <-> stock link at the DB level
-- ------------------------------------------------------------
-- The append-only stock ledger (stock_moves) and its cache (stock_levels) are
-- the single source of truth for on-hand. A row that carries a product_id but a
-- NULL variant_id (or vice-versa) would be an orphan the Stock/Products/reports
-- views can't resolve — the "blank name / wrong stock" class of bug.
--
-- product_id is already NOT NULL + FK on both tables (0001). variant_id has had
-- a FK since 0004 but was still NULLABLE, relying only on the fill_move_variant()
-- BEFORE-INSERT trigger to populate it. This migration makes that guarantee
-- structural: variant_id becomes NOT NULL on both tables, so even a future code
-- bug (or a direct SQL insert that bypasses the app) can NEVER persist an
-- unlinked stock row.
--
-- SAFETY: this only ADDS constraints; it changes no data and drops nothing.
--   * A defensive backfill first repoints any (currently zero) NULL variant_id
--     to the product's default variant — so the SET NOT NULL can never reject
--     existing, already-consistent data.
--   * If somehow a row could not be resolved, SET NOT NULL would raise and the
--     whole migration rolls back — nothing is left half-applied.
-- Idempotent: re-running is a no-op (guards check is_nullable first).

do $$
declare
  n_moves  int;
  n_levels int;
begin
  -- 1) Defensive backfill (expected to touch 0 rows). stock_moves is append-only
  --    (block_ledger_mutation blocks UPDATE), so suspend that guard just for this
  --    in-place repair, exactly as the 0004 variant backfill did.
  select count(*) into n_moves  from stock_moves  where variant_id is null;
  select count(*) into n_levels from stock_levels where variant_id is null;

  if n_moves > 0 then
    alter table stock_moves disable trigger trg_moves_no_update;
    update stock_moves m
       set variant_id = v.id
      from product_variants v
     where v.product_id = m.product_id and v.is_default and m.variant_id is null;
    alter table stock_moves enable trigger trg_moves_no_update;
    raise notice '0030: backfilled % stock_moves.variant_id', n_moves;
  end if;

  if n_levels > 0 then
    update stock_levels s
       set variant_id = v.id
      from product_variants v
     where v.product_id = s.product_id and v.is_default and s.variant_id is null;
    raise notice '0030: backfilled % stock_levels.variant_id', n_levels;
  end if;

  -- 2) Enforce NOT NULL on stock_moves.variant_id (guarded / idempotent).
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'stock_moves'
       and column_name = 'variant_id' and is_nullable = 'YES'
  ) then
    alter table stock_moves alter column variant_id set not null;
  end if;

  -- 3) Enforce NOT NULL on stock_levels.variant_id (guarded / idempotent).
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'stock_levels'
       and column_name = 'variant_id' and is_nullable = 'YES'
  ) then
    alter table stock_levels alter column variant_id set not null;
  end if;
end $$;

-- 4) Belt-and-suspenders: guarantee the FKs exist (they do since 0004; add-if-missing
--    so a fresh/partial DB is also protected). Named constraints -> idempotent.
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
     where table_schema = 'public' and constraint_name = 'stock_moves_variant_fk'
  ) and not exists (
    -- skip if some other FK already covers stock_moves.variant_id
    select 1
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
     where tc.constraint_type = 'FOREIGN KEY' and tc.table_name = 'stock_moves'
       and kcu.column_name = 'variant_id'
  ) then
    alter table stock_moves
      add constraint stock_moves_variant_fk
      foreign key (variant_id) references product_variants(id);
  end if;

  if not exists (
    select 1 from information_schema.table_constraints
     where table_schema = 'public' and constraint_name = 'stock_levels_variant_fk'
  ) and not exists (
    select 1
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
     where tc.constraint_type = 'FOREIGN KEY' and tc.table_name = 'stock_levels'
       and kcu.column_name = 'variant_id'
  ) then
    alter table stock_levels
      add constraint stock_levels_variant_fk
      foreign key (variant_id) references product_variants(id);
  end if;
end $$;

-- Note: fill_move_variant() (0004) still runs BEFORE INSERT and remains the
-- convenience that lets legacy product-only callers omit variant_id; it resolves
-- the default variant (or raises). The NOT NULL added here is the final backstop
-- that fires even if that trigger were ever dropped or bypassed.
