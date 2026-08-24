import { describe, it, expect } from "vitest";
import { buildSaleMoves, netPhysicalOnHandDelta, type SaleLine, type SaleMoveContext } from "./stock-moves";

const ctx: SaleMoveContext = {
  mainLocationId: "main-loc",
  custLocationId: "cust-loc",
  saleId: "sale-1",
  idempotencyKey: "idem-1",
  userId: "user-1",
};
const PHYSICAL = new Set(["main-loc", "wh-loc"]); // CUST/SUP are NOT physical

describe("buildSaleMoves — a sale always decrements & is always linked", () => {
  it("emits exactly one MAIN->CUST move per line, fully linked, qty>0", () => {
    const lines: SaleLine[] = [
      { product_id: "p1", variant_id: "v1", qty: 3, unit_cogs: 10 },
      { product_id: "p2", variant_id: "v2", qty: 1, unit_cogs: 5 },
    ];
    const moves = buildSaleMoves(lines, ctx);
    expect(moves).toHaveLength(2);
    for (const m of moves) {
      expect(m.from_location_id).toBe("main-loc"); // leaves the shop
      expect(m.to_location_id).toBe("cust-loc");
      expect(m.product_id).toBeTruthy();
      expect(m.variant_id).toBeTruthy();
      expect(m.qty).toBeGreaterThan(0);
      expect(m.reference_type).toBe("SALE");
      expect(m.reference_id).toBe("sale-1");
    }
    // idempotency keys are per-line suffixed so re-posting is a no-op
    expect(moves.map((m) => m.idempotency_key)).toEqual(["idem-1-0", "idem-1-1"]);
  });

  it("REGRESSION: selling qty N reduces the product's physical on_hand by exactly N", () => {
    const lines: SaleLine[] = [{ product_id: "p1", variant_id: "v1", qty: 3, unit_cogs: 10 }];
    const delta = netPhysicalOnHandDelta(buildSaleMoves(lines, ctx), PHYSICAL);
    expect(delta.get("v1")).toBe(-3); // decrements — this test fails if a sale ever stops decrementing
  });

  it("REGRESSION: opening stock 10 then a sale of 3 leaves net physical on_hand at 7", () => {
    const opening = [{ variant_id: "v1", qty: 10, from_location_id: "sup-loc", to_location_id: "main-loc" }];
    const saleMoves = buildSaleMoves([{ product_id: "p1", variant_id: "v1", qty: 3, unit_cogs: 10 }], ctx);
    const net = netPhysicalOnHandDelta([...opening, ...saleMoves], PHYSICAL);
    expect(net.get("v1")).toBe(7);
  });

  it("throws if a line is missing its variant link (can't persist an unlinked move)", () => {
    expect(() => buildSaleMoves([{ product_id: "p1", variant_id: "", qty: 1, unit_cogs: 1 }], ctx)).toThrow(/variant_id/);
  });

  it("throws if a line is missing its product link", () => {
    expect(() => buildSaleMoves([{ product_id: "", variant_id: "v1", qty: 1, unit_cogs: 1 }], ctx)).toThrow(/product_id/);
  });

  it("throws on a non-positive qty", () => {
    expect(() => buildSaleMoves([{ product_id: "p1", variant_id: "v1", qty: 0, unit_cogs: 1 }], ctx)).toThrow(/qty/);
  });

  it("throws if the physical (MAIN) or customer location is missing", () => {
    expect(() => buildSaleMoves([{ product_id: "p1", variant_id: "v1", qty: 1, unit_cogs: 1 }], { ...ctx, mainLocationId: "" })).toThrow(/MAIN|CUST/);
  });
});

describe("netPhysicalOnHandDelta — mirrors apply_stock_move trigger", () => {
  it("counts destination as +qty and source as -qty, only for physical locations", () => {
    const moves = [
      { variant_id: "v1", qty: 5, from_location_id: "sup-loc", to_location_id: "main-loc" }, // purchase in: +5 physical
      { variant_id: "v1", qty: 2, from_location_id: "main-loc", to_location_id: "cust-loc" }, // sale out: -2 physical
    ];
    expect(netPhysicalOnHandDelta(moves, PHYSICAL).get("v1")).toBe(3);
  });

  it("a transfer between two physical locations nets zero", () => {
    const moves = [{ variant_id: "v1", qty: 4, from_location_id: "main-loc", to_location_id: "wh-loc" }];
    expect(netPhysicalOnHandDelta(moves, PHYSICAL).get("v1")).toBe(0);
  });
});
