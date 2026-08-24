// Pure construction of the append-only ledger moves a POS sale posts, plus a
// ledger reducer that mirrors the apply_stock_move() DB trigger. Extracted from
// checkoutSale so the "a sale ALWAYS decrements stock, and never writes an
// unlinked move" invariants are unit-testable and can't silently regress.

export interface SaleLine {
  product_id: string;
  variant_id: string;
  qty: number;
  /** Snapshotted weighted-average cost at sale time. */
  unit_cogs: number;
}

export interface SaleMoveContext {
  /** Physical location the stock leaves FROM — its on_hand decrements. */
  mainLocationId: string;
  /** Customer sink the stock moves TO (non-physical). */
  custLocationId: string;
  saleId: string;
  idempotencyKey: string;
  userId: string;
}

export interface SaleStockMove {
  product_id: string;
  variant_id: string;
  qty: number;
  from_location_id: string;
  to_location_id: string;
  unit_cost: number;
  reference_type: "SALE";
  reference_id: string;
  source: "SCAN";
  idempotency_key: string;
  created_by: string;
}

/**
 * Build the stock moves for a completed sale. INVARIANTS (guarded so a future
 * change can't quietly reintroduce the "stock didn't decrement / unlinked row"
 * bugs):
 *   - exactly ONE move per sold line;
 *   - every move goes MAIN (physical) -> CUST, so apply_stock_move() reduces
 *     on_hand at MAIN by qty (the sale decrements);
 *   - every move carries a non-empty product_id AND variant_id (never unlinked);
 *   - qty must be > 0.
 * Throws if any invariant can't be met, so a bad move can't be persisted.
 */
export function buildSaleMoves(lines: SaleLine[], ctx: SaleMoveContext): SaleStockMove[] {
  if (!ctx.mainLocationId || !ctx.custLocationId) {
    throw new Error("sale moves need both a MAIN and a CUST location");
  }
  return lines.map((l, i) => {
    if (!l.product_id) throw new Error("sale line is missing product_id (unlinked stock move)");
    if (!l.variant_id) throw new Error("sale line is missing variant_id (unlinked stock move)");
    if (!(l.qty > 0)) throw new Error("sale line qty must be greater than 0");
    return {
      product_id: l.product_id,
      variant_id: l.variant_id,
      qty: l.qty,
      from_location_id: ctx.mainLocationId,
      to_location_id: ctx.custLocationId,
      unit_cost: l.unit_cogs,
      reference_type: "SALE",
      reference_id: ctx.saleId,
      source: "SCAN",
      idempotency_key: `${ctx.idempotencyKey}-${i}`,
      created_by: ctx.userId,
    };
  });
}

export interface LedgerMove {
  variant_id: string;
  qty: number;
  from_location_id: string | null;
  to_location_id: string | null;
}

/**
 * Net on-hand change a set of moves applies per variant at PHYSICAL locations —
 * mirrors apply_stock_move() (+qty to destination, -qty from source). Lets tests
 * (and any reconciler) assert that a sale actually reduces physical on-hand.
 */
export function netPhysicalOnHandDelta(
  moves: LedgerMove[],
  physicalLocationIds: Set<string>,
): Map<string, number> {
  const delta = new Map<string, number>();
  const add = (variant: string, n: number) => delta.set(variant, (delta.get(variant) ?? 0) + n);
  for (const m of moves) {
    if (m.to_location_id && physicalLocationIds.has(m.to_location_id)) add(m.variant_id, m.qty);
    if (m.from_location_id && physicalLocationIds.has(m.from_location_id)) add(m.variant_id, -m.qty);
  }
  return delta;
}
