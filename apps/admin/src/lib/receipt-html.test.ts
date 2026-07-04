import { describe, it, expect } from "vitest";
import { receiptHtml, RECEIPT_WIDTH_MM } from "./receipt-html";
import type { ReceiptData } from "./receipt";

const base: ReceiptData = {
  store: { name: "Hamza General Store", address: "Main Bazaar", phone: "0300-0000000", footer: "Thank you!" },
  receipt_no: "INV-12345678",
  date: "25 Jun 2026, 3:00 PM",
  cashier: "Owner",
  customer: "Walk-in customer",
  customer_address: "-",
  items: [{ name: "Soap", qty: 1, unit: "Pcs", unit_price: 600, line_total: 550 }],
  subtotal: 600, discount: 50, tax: 0, tax_percent: 0, total: 550,
  payments: [{ method: "CASH", amount: 550 }],
  change: 0,
};

describe("receiptHtml (80mm thermal sizing)", () => {
  it("fixes the page width to the roll and lets height auto-grow (no A4)", () => {
    const html = receiptHtml(base);
    expect(RECEIPT_WIDTH_MM).toBe(80);
    expect(html).toContain(`@page { size: ${RECEIPT_WIDTH_MM}mm auto; margin: 0; }`);
    expect(html).toContain(`width: ${RECEIPT_WIDTH_MM}mm`);
    // No fixed full-page height forcing an A4-length sheet.
    expect(html).not.toMatch(/height:\s*100(vh|%)/);
  });

  it("keeps the invoice content/design (title, items, total, words)", () => {
    const html = receiptHtml(base);
    expect(html).toContain("SALES INVOICE");
    expect(html).toContain("INV-12345678");
    expect(html).toContain("Soap");
    expect(html).toContain("Rs 550"); // Net Total = final payable (incl. bill discount)
    expect(html).toContain("Payment: CASH");
    expect(html).toContain("Thank you!");
  });

  it("has the exact 7-column header order Sr|Item|Qty|Rate|Disc|D.Rate|Total", () => {
    const html = receiptHtml(base);
    expect(html).toMatch(
      /Sr<\/th>\s*<th>Item<\/th>\s*<th>Qty<\/th>\s*<th class="r">Rate<\/th>\s*<th class="r">Disc<\/th>\s*<th class="r">D\.Rate<\/th>\s*<th class="r">Total<\/th>/,
    );
  });

  it("derives Disc, D.Rate and after-discount Total per line (Rate 700, d 300/unit, qty 2)", () => {
    // line_total is GROSS (1400) on purpose — Total must be derived, not copied.
    const html = receiptHtml({
      ...base,
      items: [{ name: "Oil", qty: 2, unit: "Pcs", unit_price: 700, discount: 600, line_total: 1400 }],
      subtotal: 1400, discount: 600, total: 800,
    });
    expect(html).toContain(`<td class="r">700</td>`); // Rate
    expect(html).toContain(`<td class="r">600</td>`); // Disc = d×q
    expect(html).toContain(`<td class="r">400</td>`); // D.Rate = R−d
    expect(html).toContain(`<td class="r">800</td>`); // Total = (R−d)×q (after discount)
    // Totals identity: Total − Total Discount = Net Total (1400 − 600 = 800).
    expect(html).toContain("Total:</span><span>Rs 1,400");
    expect(html).toContain("Total Discount:</span><span>-Rs 600");
    expect(html).toContain("Net Total:</span><span>Rs 800");
  });

  it("hides the synthetic 'Default' variant label but keeps real ones", () => {
    const html = receiptHtml({
      ...base,
      items: [
        { name: "Soap", label: "Default", qty: 1, unit: "Pcs", unit_price: 600, line_total: 600 },
        { name: "Tea", label: "200g", qty: 1, unit: "Pcs", unit_price: 540, line_total: 540 },
      ],
    });
    expect(html).not.toContain("Default");
    expect(html).toContain("Soap"); // bare product name, no "(Default)"
    expect(html).toContain("Tea (200g)"); // real label preserved
  });

  it("injects the auto-print script by default and omits it for a passive preview", () => {
    expect(receiptHtml(base)).toContain("window.print()"); // Print pop-up
    const preview = receiptHtml(base, { autoPrint: false });
    expect(preview).not.toContain("window.print()"); // iframe preview must not auto-print
    expect(preview).toContain("SALES INVOICE"); // still the full invoice
  });

  it("starts at the very top and has no top/bottom padding band", () => {
    const html = receiptHtml(base);
    expect(html).toMatch(/padding:\s*0\s+3\.5mm\s+0;/); // .receipt: no top/bottom pad
    expect(html).toMatch(/print-color-adjust:\s*exact/);
  });

  it("uses a clean sans-serif font at a light bold weight (no monospace / faux-bold)", () => {
    const html = receiptHtml(base);
    expect(html).toMatch(/font-family:\s*Arial[^;]*sans-serif/); // clean sans-serif
    expect(html).not.toContain("monospace"); // no typewriter/dotted look
    expect(html).not.toContain("-webkit-text-stroke"); // no heavy faux weight
    expect(html).not.toContain("text-shadow"); // no faux-bold thickening
    expect(html).toContain("font-weight: 500"); // light bold body
  });

  it("grows with more items (multi-item taller than 1-item)", () => {
    const one = receiptHtml(base).length;
    const many = receiptHtml({
      ...base,
      items: Array.from({ length: 8 }, (_, i) => ({ name: `Item ${i}`, qty: 2, unit: "Pcs", unit_price: 100, line_total: 200 })),
    }).length;
    expect(many).toBeGreaterThan(one);
  });
});
