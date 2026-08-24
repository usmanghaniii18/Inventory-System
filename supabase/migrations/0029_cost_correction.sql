-- ------------------------------------------------------------
-- Safe "Correct cost price" tool for data-entry mistakes
-- ------------------------------------------------------------
-- Weighted-average costing normally derives a variant's cost from purchases and
-- it is not directly editable. But staff can mistype the cost when first adding a
-- product. This adds a controlled, audited correction that fixes the cost GOING
-- FORWARD without rewriting history.
--
-- Two cost numbers exist in this system (see 0004/0014):
--   * product_variants.cost   — static "standard cost"; used by inventory
--                               valuation + dashboard "Stock Value".
--   * stock_levels.avg_cost   — true weighted-average; the value POS reads to
--                               snapshot COGS at sale time.
-- A correction sets BOTH to the corrected figure so every surface agrees again.
--
-- WHAT IS NEVER TOUCHED (history is preserved):
--   * sale_items.unit_cogs, sales.cogs_total, sales.profit — the COGS/profit of
--     past completed sales were snapshotted at sale time and stay exactly as they
--     were. The profit & margin reports read those snapshots, so past profit and
--     past margins do not move.
--   * the append-only stock_moves ledger — no historical move is edited/deleted.
-- Normal weighted-average behaviour is unchanged: purchases/GRNs still drive cost
-- through apply_stock_move(); this is only a manual correction for mistakes.

-- 1) Audit trail — every correction is recorded (who/when/old/new/reason).
create table if not exists cost_corrections (
  id           bigint generated always as identity primary key,
  variant_id   uuid not null references product_variants(id) on delete cascade,
  product_id   uuid not null references products(id) on delete cascade,
  old_cost     numeric(14,4) not null,
  new_cost     numeric(14,4) not null,
  old_avg_cost numeric(14,4) not null,
  had_history  boolean not null,
  reason       text,
  corrected_by uuid references profiles(id),
  created_at   timestamptz not null default now()
);

create index if not exists idx_cost_corrections_variant
  on cost_corrections(variant_id, created_at desc);

alter table cost_corrections enable row level security;
-- Readable by signed-in staff for the audit trail; all writes go through the
-- security-definer RPC below (service_role), never directly from the client.
drop policy if exists "cost_corrections staff read" on cost_corrections;
create policy "cost_corrections staff read" on cost_corrections
  for select to authenticated using (is_staff());

-- 2) The correction itself — one transaction, SECURITY DEFINER (called by the
--    server action with the service-role client; role gating lives in the action).
create or replace function correct_variant_cost(
  p_variant_id uuid,
  p_new_cost   numeric,
  p_reason     text,
  p_created_by uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id  uuid;
  v_old_cost    numeric(14,4);
  v_old_avg     numeric(14,4);
  v_had_history boolean;
begin
  -- Lock the variant row for the duration of the correction.
  select product_id, cost into v_product_id, v_old_cost
    from product_variants where id = p_variant_id for update;
  if v_product_id is null then
    raise exception 'Variant % not found', p_variant_id using errcode = 'no_data_found';
  end if;
  if p_new_cost is null or p_new_cost < 0 then
    raise exception 'Cost must be 0 or more' using errcode = 'check_violation';
  end if;

  -- Current physical weighted-average (on-hand-weighted across PHYSICAL locations).
  select coalesce(sum(sl.on_hand * sl.avg_cost) / nullif(sum(sl.on_hand), 0), 0)
    into v_old_avg
    from stock_levels sl
    join locations l on l.id = sl.location_id
   where sl.variant_id = p_variant_id and l.type = 'PHYSICAL';

  -- History = any ledger movement other than the initial OPENING seed.
  select exists (
    select 1 from stock_moves
     where variant_id = p_variant_id and reference_type <> 'OPENING'
  ) into v_had_history;

  -- (a) Forward static cost — drives inventory valuation / dashboard stock value.
  update product_variants
     set cost = p_new_cost, updated_at = now()
   where id = p_variant_id;

  -- (b) Forward weighted-average — drives the COGS POS will snapshot on FUTURE
  --     sales. Past sales already captured their own COGS and are untouched.
  --     Revalue the PHYSICAL stock rows to the corrected cost (non-physical rows
  --     like CUSTOMER/SUPPLIER hold no real inventory and are irrelevant).
  update stock_levels sl
     set avg_cost = p_new_cost, updated_at = now()
    from locations l
   where sl.location_id = l.id
     and sl.variant_id = p_variant_id
     and l.type = 'PHYSICAL';

  insert into cost_corrections(variant_id, product_id, old_cost, new_cost,
                               old_avg_cost, had_history, reason, corrected_by)
  values (p_variant_id, v_product_id, coalesce(v_old_cost, 0), p_new_cost,
          coalesce(v_old_avg, 0), v_had_history, nullif(p_reason, ''), p_created_by);

  return jsonb_build_object(
    'old_cost', coalesce(v_old_cost, 0),
    'new_cost', p_new_cost,
    'old_avg_cost', coalesce(v_old_avg, 0),
    'had_history', v_had_history
  );
end;
$$;

revoke execute on function correct_variant_cost(uuid, numeric, text, uuid) from public;
grant execute on function correct_variant_cost(uuid, numeric, text, uuid) to service_role;
