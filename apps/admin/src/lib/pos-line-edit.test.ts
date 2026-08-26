/**
 * F8 flow: type a quantity, Enter, type a discount, Enter.
 *
 * The bug these pin down: commitQty() used to clamp the typed quantity to the
 * stock figure and carry on —
 *
 *     const capped = Math.min(n, entry.p.available);   // 10 typed, 3 billed
 *
 * so the line was billed a quantity the cashier never typed, with only a
 * 2.2-second flash to say so, and the flow advanced to the discount step as
 * though it had worked. The discount path clamped just as silently, with no
 * message at all.
 *
 * The rule asserted throughout: what is accepted is EXACTLY what was typed, and
 * anything that cannot be accepted is refused outright rather than substituted.
 */
import { describe, it, expect } from "vitest";
import { resolveQtyEdit, resolveDiscountEdit, formatQty } from "./pos-line-edit";

describe("F8 quantity — the typed value is the applied value", () => {
  it("applies exactly what was typed", () => {
    expect(resolveQtyEdit("3", 1, 10)).toEqual({ kind: "set", qty: 3 });
    expect(resolveQtyEdit("7", 1, 10)).toEqual({ kind: "set", qty: 7 });
    expect(resolveQtyEdit("12", 1, 50)).toEqual({ kind: "set", qty: 12 });
  });

  it("applies a quantity equal to the whole of stock", () => {
    expect(resolveQtyEdit("10", 1, 10)).toEqual({ kind: "set", qty: 10 });
  });

  it("keeps a fractional weight intact — no rounding to whole units", () => {
    expect(resolveQtyEdit("2.5", 1, 10)).toEqual({ kind: "set", qty: 2.5 });
    expect(resolveQtyEdit("0.375", 1, 10)).toEqual({ kind: "set", qty: 0.375 });
  });

  it("treats a blank box as 'leave the quantity alone'", () => {
    expect(resolveQtyEdit("", 4, 10)).toEqual({ kind: "unchanged" });
    expect(resolveQtyEdit("   ", 4, 10)).toEqual({ kind: "unchanged" });
  });

  it("treats zero as removing the line", () => {
    expect(resolveQtyEdit("0", 4, 10)).toEqual({ kind: "remove" });
  });

  it("refuses a negative or non-numeric quantity", () => {
    expect(resolveQtyEdit("-2", 1, 10)).toEqual({ kind: "invalid" });
    expect(resolveQtyEdit("abc", 1, 10)).toEqual({ kind: "invalid" });
  });
});

describe("F8 quantity — over-stock is REFUSED, never silently reduced", () => {
  it("refuses 10 when 3 are on hand, and reports the real figure", () => {
    const res = resolveQtyEdit("10", 1, 3);
    expect(res).toEqual({ kind: "overstock", typed: 10, available: 3 });
    // the old behaviour, pinned as what must NOT happen:
    expect(res).not.toEqual({ kind: "set", qty: 3 });
  });

  it("refuses one more than stock", () => {
    expect(resolveQtyEdit("11", 1, 10)).toEqual({ kind: "overstock", typed: 11, available: 10 });
  });

  it("refuses anything at all when stock is zero", () => {
    expect(resolveQtyEdit("1", 0, 0)).toEqual({ kind: "overstock", typed: 1, available: 0 });
  });

  it("refuses an over-stock weight", () => {
    expect(resolveQtyEdit("2.5", 1, 2)).toEqual({ kind: "overstock", typed: 2.5, available: 2 });
  });

  it("never returns a quantity different from the one typed", () => {
    // The whole point: for every input, the result is either the typed number
    // or a refusal — there is no third outcome that bills something else.
    for (const typed of [1, 2, 3, 5, 8, 13, 100]) {
      for (const available of [0, 1, 3, 10, 100]) {
        const res = resolveQtyEdit(String(typed), 1, available);
        if (res.kind === "set") expect(res.qty).toBe(typed);
        else expect(res.kind).toBe("overstock");
      }
    }
  });
});

describe("F8 quantity — a line can always be corrected downwards", () => {
  it("lets a line be reduced even after stock has moved below it", () => {
    // 5 already on the bill, stock has since dropped to 2. Reducing to 3 must
    // stay possible: locking the cashier out of the one edit that always helps
    // would be a worse bug than the clamp this replaces.
    expect(resolveQtyEdit("3", 5, 2)).toEqual({ kind: "set", qty: 3 });
  });

  it("lets a line be left exactly where it is", () => {
    expect(resolveQtyEdit("5", 5, 2)).toEqual({ kind: "set", qty: 5 });
  });

  it("still refuses an INCREASE past stock", () => {
    expect(resolveQtyEdit("6", 5, 2)).toEqual({ kind: "overstock", typed: 6, available: 2 });
  });
});

describe("F8 discount — the typed value is the applied value", () => {
  it("applies exactly what was typed", () => {
    expect(resolveDiscountEdit("50", 500)).toEqual({ kind: "set", discount: 50 });
    expect(resolveDiscountEdit("12.5", 500)).toEqual({ kind: "set", discount: 12.5 });
  });

  it("accepts a discount equal to the whole line", () => {
    expect(resolveDiscountEdit("500", 500)).toEqual({ kind: "set", discount: 500 });
  });

  it("treats blank or zero as removing the discount", () => {
    expect(resolveDiscountEdit("", 500)).toEqual({ kind: "clear" });
    expect(resolveDiscountEdit("0", 500)).toEqual({ kind: "clear" });
  });

  it("refuses a discount larger than the line instead of clamping it", () => {
    const res = resolveDiscountEdit("600", 500);
    expect(res).toEqual({ kind: "exceedsLine", typed: 600, max: 500 });
    // clampDisc() used to return this, with no message at all:
    expect(res).not.toEqual({ kind: "set", discount: 500 });
  });

  it("refuses a negative or non-numeric discount", () => {
    expect(resolveDiscountEdit("-5", 500)).toEqual({ kind: "invalid" });
    expect(resolveDiscountEdit("x", 500)).toEqual({ kind: "invalid" });
  });

  it("is not tripped by floating-point gross totals", () => {
    // 3 x 33.33 = 99.99000000000001 in binary floating point.
    const gross = 3 * 33.33;
    expect(resolveDiscountEdit("99.99", gross)).toEqual({ kind: "set", discount: 99.99 });
  });
});

describe("the full F8 sequence", () => {
  /** Type a quantity, then a discount, exactly as the cashier does. */
  function run(qtyTyped: string, discTyped: string, opts: { qty: number; price: number; available: number }) {
    const q = resolveQtyEdit(qtyTyped, opts.qty, opts.available);
    if (q.kind !== "set" && q.kind !== "unchanged") return { blockedAt: "qty" as const, q };
    const finalQty = q.kind === "set" ? q.qty : opts.qty;
    const d = resolveDiscountEdit(discTyped, finalQty * opts.price);
    if (d.kind !== "set" && d.kind !== "clear") return { blockedAt: "disc" as const, q, d };
    return { qty: finalQty, discount: d.kind === "set" ? d.discount : 0 };
  }

  it("bills exactly the typed quantity and the typed discount", () => {
    expect(run("4", "100", { qty: 1, price: 250, available: 20 }))
      .toEqual({ qty: 4, discount: 100 });
  });

  it("blocks at the quantity step when stock is short — nothing is applied", () => {
    const r = run("10", "100", { qty: 1, price: 250, available: 3 });
    expect(r.blockedAt).toBe("qty");
    expect(r).not.toHaveProperty("qty", 3);
  });

  it("blocks at the discount step when the discount exceeds the new line total", () => {
    // qty 2 x 250 = 500, so 600 is refused — and the ceiling reflects the
    // quantity the cashier just entered, not the one the line started with.
    const r = run("2", "600", { qty: 1, price: 250, available: 20 });
    expect(r.blockedAt).toBe("disc");
  });

  it("accepts a discount that only fits because of the new quantity", () => {
    expect(run("4", "900", { qty: 1, price: 250, available: 20 }))
      .toEqual({ qty: 4, discount: 900 });
  });
});

describe("formatQty", () => {
  it("keeps whole numbers whole and weights readable", () => {
    expect(formatQty(3)).toBe("3");
    expect(formatQty(2.5)).toBe("2.5");
    expect(formatQty(0.375)).toBe("0.375");
  });
});
