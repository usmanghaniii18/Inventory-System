import { describe, it, expect } from "vitest";
import { computeTotals, changeDue, paymentsSettle, netUnitPaid, splitUdhaarRefund, round2 } from "./pricing";

describe("computeTotals", () => {
  it("sums a plain cart with no discount or tax", () => {
    const t = computeTotals([{ qty: 2, unit_price: 160 }, { qty: 1, unit_price: 1850 }], 0, 0);
    expect(t.subtotal).toBe(2170);
    expect(t.discount).toBe(0);
    expect(t.total).toBe(2170);
  });

  it("applies per-line and whole-bill discounts", () => {
    const t = computeTotals([{ qty: 2, unit_price: 100, discount: 30 }], 20, 0);
    expect(t.subtotal).toBe(200);
    expect(t.discount).toBe(50); // 30 line + 20 bill
    expect(t.total).toBe(150);
  });

  it("clamps a line discount to the line total", () => {
    const t = computeTotals([{ qty: 1, unit_price: 100, discount: 999 }], 0, 0);
    expect(t.discount).toBe(100);
    expect(t.total).toBe(0);
  });

  it("applies tax on the discounted amount", () => {
    const t = computeTotals([{ qty: 1, unit_price: 1000 }], 0, 17);
    expect(t.tax).toBe(170);
    expect(t.total).toBe(1170);
  });
});

describe("netUnitPaid (refund basis — actual amount paid, not list price)", () => {
  // The reported bug: item listed 600, sold for 550 after a Rs 50 line discount.
  // line_total = 550, qty 1, only line on the bill so saleTotal = sumLineTotals = 550.
  it("refunds the net paid (550), never the pre-discount price (600)", () => {
    const u = netUnitPaid(550, 1, 550, 550);
    expect(round2(u)).toBe(550);
    expect(round2(u)).not.toBe(600);
  });

  it("a full return of a profitable sale nets to zero (no negative sales)", () => {
    const saleTotal = 550; // what was collected
    const refund = round2(1 * netUnitPaid(550, 1, 550, saleTotal));
    expect(round2(saleTotal - refund)).toBe(0);
  });

  it("spreads a bill-level discount proportionally across lines", () => {
    // Two lines net of their own discounts: 600 and 400 (sum 1000); Rs 100 bill
    // discount → saleTotal 900. Each line's net paid scales by 900/1000 = 0.9.
    const a = netUnitPaid(600, 1, 1000, 900); // 540
    const b = netUnitPaid(400, 1, 1000, 900); // 360
    expect(round2(a)).toBe(540);
    expect(round2(b)).toBe(360);
    expect(round2(a + b)).toBe(900); // sums back to the bill total
  });

  it("partial return refunds only the returned units' net share", () => {
    // 3 units, line_total 300 (100/unit net), no bill discount, saleTotal 300.
    const perUnit = netUnitPaid(300, 3, 300, 300); // 100
    expect(round2(2 * perUnit)).toBe(200); // return 2 of 3
    expect(round2(3 * perUnit)).toBe(300); // full return = full net, never more
  });

  it("returns 0 when nothing was collected (free/fully-discounted)", () => {
    expect(netUnitPaid(0, 1, 0, 0)).toBe(0);
    expect(netUnitPaid(100, 0, 100, 100)).toBe(0);
  });
});

describe("splitUdhaarRefund (a return of an udhaar sale must reduce the khata)", () => {
  it("a bill with no original udhaar refunds entirely as the remainder — non-udhaar returns unaffected", () => {
    const s = splitUdhaarRefund({ refundTotal: 550, saleTotal: 550, originalUdhaar: 0, alreadyRefundedUdhaar: 0 });
    expect(s.udhaarPortion).toBe(0);
    expect(s.remainder).toBe(550);
  });

  it("a full return of a 100%-udhaar bill reverses the whole charge off the khata", () => {
    // Bill fully on udhaar: sold 550, all on credit.
    const s = splitUdhaarRefund({ refundTotal: 550, saleTotal: 550, originalUdhaar: 550, alreadyRefundedUdhaar: 0 });
    expect(s.udhaarPortion).toBe(550);
    expect(s.remainder).toBe(0);
  });

  it("a partial return with a discount deducts only the returned lines' net-paid share from udhaar", () => {
    // Two lines net 600 + 400 = 1000 collected, Rs 100 bill discount → saleTotal 900,
    // all on udhaar. Returning the line that net-paid 540 (per netUnitPaid) should
    // pull exactly 540 off the khata, never the pre-discount 600.
    const refundTotal = round2(netUnitPaid(600, 1, 1000, 900));
    expect(refundTotal).toBe(540);
    const s = splitUdhaarRefund({ refundTotal, saleTotal: 900, originalUdhaar: 900, alreadyRefundedUdhaar: 0 });
    expect(s.udhaarPortion).toBe(540);
    expect(s.remainder).toBe(0);
  });

  it("split-tender (udhaar + cash) deducts the proportional udhaar share; the rest is the remainder", () => {
    // Rs 1000 bill: 600 cash + 400 udhaar (40% udhaar). A Rs 200 net-paid refund
    // should pull Rs 80 off the khata and leave Rs 120 as the ordinary remainder.
    const s = splitUdhaarRefund({ refundTotal: 200, saleTotal: 1000, originalUdhaar: 400, alreadyRefundedUdhaar: 0 });
    expect(s.udhaarPortion).toBe(80);
    expect(s.remainder).toBe(120);
    expect(round2(s.udhaarPortion + s.remainder)).toBe(200); // always sums back to the refund total
  });

  it("caps at what's still outstanding — a return can never push the khata past what the bill charged", () => {
    // 400 was charged to udhaar; a prior return already reversed 350 of it.
    // A further raw share of 80 must be capped to the remaining 50, not 80.
    const s = splitUdhaarRefund({ refundTotal: 200, saleTotal: 1000, originalUdhaar: 400, alreadyRefundedUdhaar: 350 });
    expect(s.udhaarPortion).toBe(50);
    expect(s.remainder).toBe(150); // the rest still flows through the normal refund path, nothing is lost
  });

  it("once a bill's full udhaar charge has already been refunded, further returns take nothing more off the khata", () => {
    const s = splitUdhaarRefund({ refundTotal: 100, saleTotal: 1000, originalUdhaar: 400, alreadyRefundedUdhaar: 400 });
    expect(s.udhaarPortion).toBe(0);
    expect(s.remainder).toBe(100);
  });

  it("cumulative partial returns of a split-tender bill never exceed the original udhaar amount", () => {
    // 1000 bill, 400 udhaar (40%). Three sequential partial returns of 300 each
    // (900 total, i.e. the whole bill in parts) — the udhaar side must sum to
    // exactly 400, never more, across the sequence.
    let refunded = 0;
    let total = 0;
    for (const chunk of [300, 300, 300]) {
      const s = splitUdhaarRefund({ refundTotal: chunk, saleTotal: 1000, originalUdhaar: 400, alreadyRefundedUdhaar: refunded });
      refunded = round2(refunded + s.udhaarPortion);
      total += chunk;
    }
    expect(total).toBe(900);
    expect(refunded).toBe(360); // 40% of 900 returned so far — under the 400 cap, cap never bites
    expect(refunded).toBeLessThanOrEqual(400);
  });
});

describe("changeDue", () => {
  it("returns tendered minus applied cash, never negative", () => {
    expect(changeDue(1000, 850)).toBe(150);
    expect(changeDue(850, 850)).toBe(0);
    expect(changeDue(500, 850)).toBe(0);
  });
});

describe("paymentsSettle (split payments)", () => {
  it("accepts payments that sum to the total", () => {
    expect(paymentsSettle(850, [{ amount: 500 }, { amount: 350 }])).toBe(true);
  });
  it("rejects an under/over payment", () => {
    expect(paymentsSettle(850, [{ amount: 500 }])).toBe(false);
    expect(paymentsSettle(850, [{ amount: 500 }, { amount: 400 }])).toBe(false);
  });
  it("tolerates sub-paisa rounding", () => {
    expect(paymentsSettle(100.0, [{ amount: 99.7 }])).toBe(true);
  });
});
