import { describe, it, expect } from "vitest";
import { checkoutSchema, returnSchema, adjustSchema, productInputSchema } from "./validation";

const ID = "11111111-1111-1111-1111-111111111111";

describe("checkoutSchema", () => {
  const valid = {
    lines: [{ variant_id: ID, product_id: ID, qty: 2, unit_price: 100 }],
    customer_id: null,
    payments: [{ method: "CASH", amount: 200 }],
    idempotency_key: "k1",
  };
  it("accepts a well-formed sale", () => {
    expect(checkoutSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects an empty cart", () => {
    expect(checkoutSchema.safeParse({ ...valid, lines: [] }).success).toBe(false);
  });
  it("rejects a non-positive quantity", () => {
    expect(checkoutSchema.safeParse({ ...valid, lines: [{ ...valid.lines[0], qty: 0 }] }).success).toBe(false);
  });
  it("rejects a missing payment", () => {
    expect(checkoutSchema.safeParse({ ...valid, payments: [] }).success).toBe(false);
  });
  it("rejects a bad id", () => {
    expect(checkoutSchema.safeParse({ ...valid, lines: [{ ...valid.lines[0], variant_id: "nope" }] }).success).toBe(false);
  });
  it("REGRESSION: a sale line can never be unlinked (both product_id and variant_id required)", () => {
    const noProduct = { qty: 1, unit_price: 100, variant_id: ID };
    const noVariant = { qty: 1, unit_price: 100, product_id: ID };
    expect(checkoutSchema.safeParse({ ...valid, lines: [noProduct] }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...valid, lines: [noVariant] }).success).toBe(false);
  });
});

describe("returnSchema", () => {
  it("requires at least one item and a refund method", () => {
    const base = { sale_id: ID, receipt_no: "INV-1", refund_method: "CASH", idempotency_key: "r1" };
    expect(returnSchema.safeParse({ ...base, items: [] }).success).toBe(false);
    expect(returnSchema.safeParse({
      ...base,
      items: [{ sale_item_id: ID, product_id: ID, variant_id: ID, qty: 1, unit_price: 100, unit_cogs: 60 }],
    }).success).toBe(true);
  });
});

describe("adjustSchema", () => {
  it("requires a positive qty and a reason", () => {
    expect(adjustSchema.safeParse({ variant_id: ID, product_id: ID, direction: "add", qty: 1, reason: "found" }).success).toBe(true);
    expect(adjustSchema.safeParse({ variant_id: ID, product_id: ID, direction: "add", qty: 0, reason: "x" }).success).toBe(false);
    expect(adjustSchema.safeParse({ variant_id: ID, product_id: ID, direction: "add", qty: 1, reason: "" }).success).toBe(false);
  });
});

describe("productInputSchema", () => {
  it("requires a name and at least one variant with a SKU", () => {
    const ok = {
      name: "Tea", base_price: 100, has_variants: false, options: [],
      variants: [{ sku: "TEA-1", sale_price: 100, cost: 70, reorder_point: 3, option_values: [] }],
    };
    expect(productInputSchema.safeParse(ok).success).toBe(true);
    expect(productInputSchema.safeParse({ ...ok, name: "" }).success).toBe(false);
    expect(productInputSchema.safeParse({ ...ok, variants: [] }).success).toBe(false);
    expect(productInputSchema.safeParse({ ...ok, variants: [{ ...ok.variants[0], sku: "" }] }).success).toBe(false);
  });
});
