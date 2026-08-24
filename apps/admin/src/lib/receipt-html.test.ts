import { describe, it, expect } from "vitest";
import {
  receiptHtml, RECEIPT_WIDTH_MM, RECEIPT_FALLBACK_HEIGHT_MM, RECEIPT_MAX_HEIGHT_MM,
  RECEIPT_PROMO_FOOTER, DEFAULT_RECEIPT_DISCLAIMER,
} from "./receipt-html";
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
  it("declares a VALID two-length page size, never `<length> auto` (Phase E)", () => {
    const html = receiptHtml(base);
    expect(RECEIPT_WIDTH_MM).toBe(80);
    // `size: 80mm auto` is invalid CSS — the declaration would be dropped and
    // the page would fall back to A4, which is what split long bills in two.
    expect(html).not.toMatch(/@page\s*\{[^}]*size:\s*\d+mm\s+auto/);
    expect(html).toContain(`@page { size: ${RECEIPT_WIDTH_MM}mm ${RECEIPT_FALLBACK_HEIGHT_MM}mm; margin: 0; }`);
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

  it("re-sizes the page to the measured content height before printing", () => {
    const html = receiptHtml(base);
    expect(html).toContain("sizePageToContent");
    // px -> mm conversion and the clamp must both be present in the print script
    expect(html).toContain("25.4 / 96");
    expect(html).toContain(String(RECEIPT_MAX_HEIGHT_MM));
    expect(html).toContain(`"@page { size: ${RECEIPT_WIDTH_MM}mm " + mm + "mm; margin: 0; }"`);
  });

  it("forbids any element from introducing its own page break", () => {
    const html = receiptHtml(base);
    expect(html).toMatch(/tr,[^{]*\{[^}]*break-inside: avoid/);
    // The column header must NOT repeat — a receipt is one continuous document.
    expect(html).toContain("thead { display: table-row-group; }");
  });

  it("keeps a 200-line bill on a single page declaration", () => {
    const html = receiptHtml({
      ...base,
      items: Array.from({ length: 200 }, (_, i) => ({ name: `Item ${i}`, qty: 1, unit: "Pcs", unit_price: 50, line_total: 50 })),
    });
    // exactly one @page rule in the stylesheet (the other occurrence is the
    // runtime override the print script injects), and it is not `auto`-height
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
    expect(style.match(/@page \{/g)?.length).toBe(1);
    expect(/@page \{([^}]*)\}/.exec(style)![1]).not.toContain("auto");
    expect(html).toContain("Item 199");
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

describe("receipt footers (Phase F)", () => {
  it("prints the default disclaimer when the store has not set one", () => {
    const html = receiptHtml(base);
    expect(html).toContain(DEFAULT_RECEIPT_DISCLAIMER);
    expect(DEFAULT_RECEIPT_DISCLAIMER).toBe("No exchange or claim without bill");
  });

  it("prints the store's own disclaimer when set, instead of the default", () => {
    const html = receiptHtml({ ...base, store: { ...base.store, disclaimer: "Goods once sold are not returnable" } });
    expect(html).toContain("Goods once sold are not returnable");
    expect(html).not.toContain(DEFAULT_RECEIPT_DISCLAIMER);
  });

  it("always prints the fixed promotional footer last", () => {
    const html = receiptHtml(base);
    for (const line of RECEIPT_PROMO_FOOTER) expect(html).toContain(line);
    expect(html).toContain("Powered by Usman Ghani");
    expect(html).toContain("0301-1325560");
    expect(html).toContain("this.usmanghani@gmail.com");
    // and it sits after the store's own footer + disclaimer
    expect(html.indexOf("Powered by Usman Ghani")).toBeGreaterThan(html.indexOf(DEFAULT_RECEIPT_DISCLAIMER));
    expect(html.indexOf(DEFAULT_RECEIPT_DISCLAIMER)).toBeGreaterThan(html.indexOf("Thank you!"));
  });

  it("keeps every promo line short enough for 80mm paper", () => {
    for (const line of RECEIPT_PROMO_FOOTER) expect(line.length).toBeLessThanOrEqual(30);
  });

  it("escapes a disclaimer containing HTML", () => {
    const html = receiptHtml({ ...base, store: { ...base.store, disclaimer: '<script>x</script>' } });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
