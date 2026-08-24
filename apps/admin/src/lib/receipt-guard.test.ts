import { describe, it, expect } from "vitest";
import { isPrintableReceipt, receiptHtml } from "./receipt-html";
import type { ReceiptData } from "./receipt";

/**
 * The print path is reached from a keydown handler (F9 / Ctrl+P / Enter in the
 * receipt dialog). An exception thrown there is NOT caught by React's event
 * machinery — it escapes to the route error boundary and replaces the entire POS
 * screen with "Something went wrong". So no receipt shape, however degenerate,
 * may be allowed to throw.
 */

const good: ReceiptData = {
  store: { name: "Hamza General Store" },
  receipt_no: "INV-1", date: "24 Aug 2026", cashier: "Owner",
  customer: "Walk-in customer", customer_address: "-",
  items: [{ name: "Soap", qty: 1, unit: "Pcs", unit_price: 100, line_total: 100 }],
  subtotal: 100, discount: 0, tax: 0, tax_percent: 0, total: 100,
  payments: [{ method: "CASH", amount: 100 }], change: 0,
};

describe("isPrintableReceipt — the gate every print entry point uses", () => {
  it("rejects the no-sale-yet case that F9 hits on a fresh till", () => {
    expect(isPrintableReceipt(null)).toBe(false);
    expect(isPrintableReceipt(undefined)).toBe(false);
  });

  it("rejects a receipt whose lines are missing or empty", () => {
    expect(isPrintableReceipt({ ...good, items: [] })).toBe(false);
    expect(isPrintableReceipt({ ...good, items: undefined as never })).toBe(false);
    expect(isPrintableReceipt({ ...good, items: null as never })).toBe(false);
  });

  it("accepts a real completed sale", () => {
    expect(isPrintableReceipt(good)).toBe(true);
  });
});

describe("receiptHtml never throws on a partial receipt", () => {
  it("survives a missing payments array", () => {
    expect(() => receiptHtml({ ...good, payments: undefined as never })).not.toThrow();
  });

  it("survives a missing store object", () => {
    expect(() => receiptHtml({ ...good, store: undefined as never })).not.toThrow();
  });

  it("survives a missing items array", () => {
    expect(() => receiptHtml({ ...good, items: undefined as never })).not.toThrow();
  });

  it("still renders a correct receipt for good data", () => {
    const html = receiptHtml(good);
    expect(html).toContain("Soap");
    expect(html).toContain("SALES INVOICE");
    expect(html).toContain("Payment: CASH");
  });
});
