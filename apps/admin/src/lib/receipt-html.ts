// Thermal SALES INVOICE — the single invoice template in the system. It backs
// BOTH the POS "Sale complete" preview (rendered passively in an <iframe>) and
// the Print action, which prints an 80mm-wide roll receipt whose height is
// exactly the content (no A4 trailing paper). All client-side: no server-side
// PDF generation.
//
// Why HTML and not a PDF for printing: a PDF page can't be resized by CSS, so
// the browser prints it onto the printer's default paper (A4) and ejects a full
// blank sheet on a roll. An HTML document can declare the page size itself.
//
// PHASE E — why long bills used to print as TWO pieces
// ---------------------------------------------------
// This file used to declare `@page { size: 80mm auto; margin: 0 }`. That is
// INVALID CSS. The `size` property (CSS Paged Media 3) accepts
//     <length>{1,2} | auto | [ <page-size> || [portrait|landscape] ]
// — one or two lengths, or the bare keyword `auto`. It does NOT accept a length
// followed by `auto`. So the whole declaration was dropped and the page silently
// fell back to the printer's default paper (A4). Short receipts fitted on that
// one A4 page and looked fine; as soon as a bill grew past ~297mm of content it
// paginated, and the tail printed as a separate second piece — exactly the
// reported fault, and exactly why it only showed up on bills with many items.
//
// The fix: emit a VALID two-length page size whose height is the receipt's own
// measured content height. printReceiptHtml() measures the rendered slip after
// load (so the logo image is included) and rewrites @page to
// `size: 80mm <content>mm` before printing — one page, exactly as long as the
// bill, no split and no trailing blank paper.
import { type ReceiptData, receiptItemName } from "./receipt";
import { amountToWords } from "./number-to-words";

// Thermal roll width. Default 80mm (printable ≈ 72mm). Switch to 58 for a 58mm
// roll later without touching anything else — page + container both read this.
export const RECEIPT_WIDTH_MM = 80;
// Fallback page height used before the content is measured (and if measuring
// ever fails). Deliberately generous: too tall only wastes a little paper on a
// roll, whereas too short would reintroduce the split this phase fixes.
export const RECEIPT_FALLBACK_HEIGHT_MM = 600;
// Printer drivers refuse a page beyond a few metres. A bill long enough to hit
// this is far past any real counter sale, but clamping keeps the job printable
// instead of failing outright.
export const RECEIPT_MAX_HEIGHT_MM = 3000;
// Side padding so ink stays off the edge; content width ≈ width − 2×padding.
const SIDE_PAD_MM = 3.5;

/**
 * PHASE F — fixed promotional footer, printed at the very end of every receipt.
 * Not editable from the admin portal (unlike the store's own disclaimer and
 * footer lines, which are settings). Split across three short centred lines
 * because 80mm thermal paper only fits roughly 40 characters at this size —
 * the wording itself is unchanged, just wrapped so nothing is clipped.
 */
export const RECEIPT_PROMO_FOOTER = [
  "Powered by Usman Ghani",
  "WhatsApp: 0301-1325560",
  "this.usmanghani@gmail.com",
];

/** Default disclaimer if the store admin has not set one. */
export const DEFAULT_RECEIPT_DISCLAIMER = "No exchange or claim without bill";

const PKR = (n: number) => "Rs " + Math.round(n).toLocaleString("en-PK");
const NUM = (n: number) => Math.round(n).toLocaleString("en-PK");

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Render the receipt as a self-contained HTML document sized for the roll.
 *
 * `autoPrint` (default true) injects the load→print→close script used by the
 * Print action's pop-up window. Pass `false` to render the very same invoice as
 * a passive preview (e.g. inside an <iframe srcDoc>) without triggering print.
 */
/**
 * Is there enough here to actually print?
 *
 * Every print entry point (F9, Ctrl+P, the Receipt dialog's Print button)
 * checks this BEFORE opening a window, so a missing or half-built receipt
 * produces a small message instead of a TypeError deep inside the renderer —
 * which, thrown during an event handler, took out the whole POS screen behind
 * the route error boundary.
 */
export function isPrintableReceipt(d: ReceiptData | null | undefined): d is ReceiptData {
  return !!d && Array.isArray(d.items) && d.items.length > 0;
}

export function receiptHtml(d: ReceiptData, { autoPrint = true }: { autoPrint?: boolean } = {}): string {
  // Defensive normalisation. The renderer is reached from the live POS, from a
  // reprint of a historical sale and from the offline queue, so it must not
  // assume every optional collection survived the round trip: `.map` on an
  // undefined items array is an unrecoverable throw, whereas an empty section
  // is merely an ugly receipt.
  const items = Array.isArray(d.items) ? d.items : [];
  const payments = Array.isArray(d.payments) ? d.payments : [];
  const store = d.store ?? ({ name: "" } as ReceiptData["store"]);
  d = { ...d, items, payments, store };

  const rows = d.items
    .map((it, i) => {
      const name = esc(receiptItemName(it));
      const qty = esc(`${it.qty} ${(it.unit || "Pcs").trim()}`.trim());
      // Rate   = actual pre-discount unit price (R).
      // Disc   = total discount for the line across its qty (d×q) — a money amount.
      // D.Rate = discounted unit price actually charged (R − d).
      // Total  = (R − d) × q = after-discount line total (what the customer pays).
      // Derived from unit_price / discount / qty so Total is correct whether the
      // source line_total is gross (POS receipt) or net (saved bill) — DISPLAY
      // ONLY, no pricing/discount calculation is changed.
      const lineDisc = Number(it.discount) || 0;
      const dRate = it.qty > 0 ? it.unit_price - lineDisc / it.qty : it.unit_price;
      const lineNet = it.unit_price * it.qty - lineDisc;
      return `<tr>
        <td class="c">${i + 1}</td>
        <td>${name}</td>
        <td>${qty}</td>
        <td class="r">${esc(NUM(it.unit_price))}</td>
        <td class="r">${esc(NUM(lineDisc))}</td>
        <td class="r">${esc(NUM(dRate))}</td>
        <td class="r">${esc(NUM(lineNet))}</td>
      </tr>`;
    })
    .join("");

  // Totals come from the bill's own figures so bill-level (cart) discounts are
  // included and the identity holds: Total − Total Discount = Net Total.
  //   Total          = subtotal (Σ Rate×Qty, pre-discount grand total)
  //   Total Discount = discount (all line + bill discounts)
  //   Net Total      = total    (final payable after discount)
  const grandTotal = d.subtotal;
  const totalDiscount = d.discount;
  const netTotal = d.total;

  const taxRow = d.tax > 0 ? `<div class="ln r">Tax (${esc(d.tax_percent)}%): ${esc(PKR(d.tax))}</div>` : "";
  const payRow = d.payments.length
    ? `<div class="ln s7">Payment: ${esc(d.payments.map((p) => p.method).join(", "))}</div>`
    : "";
  const logo = d.store.logo_url
    ? `<div class="center"><img class="logo" src="${esc(d.store.logo_url)}" alt="" /></div>`
    : "";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Invoice ${esc(d.receipt_no)}</title>
<style>
  /* A VALID two-length page size (see the Phase E note at the top of this
     file). The height here is only the pre-measurement fallback — the print
     script replaces it with the receipt's exact content height, so one bill
     always prints as ONE continuous slip however many lines it has. */
  @page { size: ${RECEIPT_WIDTH_MM}mm ${RECEIPT_FALLBACK_HEIGHT_MM}mm; margin: 0; }
  /* Pure black ink everywhere (dark + legible on thermal) — but plain, no faux
     bolding: a clean sans-serif at a light bold weight, not a heavy/hashed look. */
  * { box-sizing: border-box; color: #000; }
  html, body {
    margin: 0; padding: 0; background: #fff; color: #000;
    width: ${RECEIPT_WIDTH_MM}mm;            /* page is the roll width; height follows content */
    /* Stop the browser lightening near-black ink when printing to thermal. */
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  /* The receipt is the only flow content — width = roll, height = content (no A4),
     no fixed/min height or trailing space. */
  .receipt {
    width: ${RECEIPT_WIDTH_MM}mm;
    /* No top OR bottom padding so the slip starts at the very top (above the
       logo/name) and ends right after the footer — paper height = content only,
       no leading or trailing blank band. */
    padding: 0 ${SIDE_PAD_MM}mm 0;
    /* A simple, clean sans-serif — NOT a fixed-width typewriter (dotted/hashed)
       face. Crisp and easy to read on the thermal head. */
    font-family: Arial, Helvetica, "Segoe UI", "Liberation Sans", sans-serif;
    color: #000;
    /* Slightly larger than before (was 8pt) so it reads more easily on the 80mm
       thermal head; still comfortably within the roll width. */
    font-size: 9pt;
    line-height: 1.25;
    /* Light bold: clearly readable but not heavy/thick. No faux-bold glyph
       thickening — the real font weight carries it, so glyphs stay crisp. */
    font-weight: 500;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  /* Nothing in the slip may introduce a page break of its own. */
  .receipt, table, tbody, .totals { page-break-inside: auto; break-inside: auto; }
  /* A row may not be sliced in half across a break. */
  tr, .row, .ln, .words, .footer { page-break-inside: avoid; break-inside: avoid; }
  /* Do NOT repeat the column header — a receipt is one continuous document. */
  thead { display: table-row-group; }
  .center { text-align: center; }
  .r { text-align: right; }
  .c { text-align: center; }
  .logo { max-width: 34mm; max-height: 18mm; object-fit: contain; }
  .shop { font-weight: 600; font-size: 12pt; }
  .s7 { font-size: 8pt; }
  .title { font-weight: 600; font-size: 13pt; margin-top: 2mm; }
  .ln { margin: 0; }
  .row { display: flex; justify-content: space-between; gap: 4mm; }
  .gap { height: 2mm; }
  table { width: 100%; border-collapse: collapse; font-size: 8pt; margin-top: 1mm; table-layout: fixed; }
  th, td { border: 0.4pt solid #000; padding: 0.6mm 0.5mm; vertical-align: top; word-wrap: break-word; overflow-wrap: anywhere; }
  th { font-weight: 600; }
  col.sr { width: 4mm; } col.qty { width: 8mm; } col.rate { width: 10mm; } col.disc { width: 10mm; } col.drate { width: 11mm; } col.tot { width: 11mm; }
  .total { font-weight: 600; font-size: 12pt; margin-top: 1.5mm; }
  .words { font-size: 8pt; margin-top: 0.5mm; }
  .footer { font-size: 8pt; margin-top: 2mm; }
  .disclaimer { font-size: 8pt; font-weight: 600; margin-top: 2mm; }
  .promo { font-size: 7pt; margin-top: 2mm; padding-top: 1mm; border-top: 0.4pt solid #000; line-height: 1.3; }
  /* Bottom breathing room so the tear-off never clips the last line. */
  .tail { height: 4mm; }
</style>
</head>
<body>
  <div class="receipt">
    ${logo}
    <div class="center shop">${esc(d.store.name)}</div>
    ${d.store.address ? `<div class="center s7">${esc(d.store.address)}</div>` : ""}
    ${d.store.phone ? `<div class="center s7">${esc(d.store.phone)}</div>` : ""}

    <div class="center title">SALES INVOICE</div>
    <div class="center s7">${esc(d.date)}</div>
    <div class="gap"></div>

    <div class="ln">Customer: ${esc(d.customer || "Walk-in customer")}</div>
    <div class="ln">Address: ${esc(d.customer_address || "-")}</div>
    <div class="row"><span>Invoice No: ${esc(d.receipt_no)}</span><span>Page 1 of 1</span></div>

    <table>
      <colgroup><col class="sr" /><col /><col class="qty" /><col class="rate" /><col class="disc" /><col class="drate" /><col class="tot" /></colgroup>
      <thead>
        <tr><th class="c">Sr</th><th>Item</th><th>Qty</th><th class="r">Rate</th><th class="r">Disc</th><th class="r">D.Rate</th><th class="r">Total</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="row"><span>Total:</span><span>${esc(PKR(grandTotal))}</span></div>
    <div class="row"><span>Total Discount:</span><span>${totalDiscount > 0 ? `-${esc(PKR(totalDiscount))}` : esc(PKR(0))}</span></div>
    ${taxRow}
    <div class="row total"><span>Net Total:</span><span>${esc(PKR(netTotal))}</span></div>
    <div class="words">${esc(amountToWords(netTotal))}</div>
    ${payRow}
    ${d.store.footer ? `<div class="center footer">${esc(d.store.footer)}</div>` : ""}
    <div class="center disclaimer">${esc(d.store.disclaimer || DEFAULT_RECEIPT_DISCLAIMER)}</div>
    <div class="center promo">${RECEIPT_PROMO_FOOTER.map((l) => esc(l)).join("<br/>")}</div>
    <div class="tail"></div>
  </div>
  ${autoPrint ? `<script>
    // Size the PAGE to the receipt's own height, then print. Runs on 'load' so
    // the logo image is already laid out and the measurement includes it.
    // Without this the page keeps the fallback height and a long bill would
    // paginate — the Phase E split. One measured page = one continuous slip.
    function sizePageToContent() {
      try {
        var el = document.querySelector(".receipt");
        if (!el) return;
        var px = Math.max(el.getBoundingClientRect().height, el.scrollHeight);
        var mm = px * 25.4 / 96; // CSS px are 1/96in by definition
        mm = Math.min(Math.ceil(mm) + 2, ${RECEIPT_MAX_HEIGHT_MM});
        var st = document.createElement("style");
        st.textContent = "@page { size: ${RECEIPT_WIDTH_MM}mm " + mm + "mm; margin: 0; }";
        document.head.appendChild(st);
      } catch (e) { /* keep the fallback height */ }
    }
    window.addEventListener("load", function () {
      sizePageToContent();
      setTimeout(function () { window.focus(); window.print(); }, 60);
    });
    window.addEventListener("afterprint", function () { window.close(); });
  </script>` : ""}
</body>
</html>`;
}

/**
 * Open the receipt in a new window and trigger the browser print dialog. The
 * document is sized for the thermal roll (RECEIPT_WIDTH_MM, content height), so
 * the printout is a compact 80mm receipt — not a full A4 page.
 */
export function printReceiptHtml(d: ReceiptData): void {
  const w = window.open("", "_blank", "width=380,height=640");
  if (!w) throw new Error("Allow pop-ups to print the receipt.");
  w.document.open();
  w.document.write(receiptHtml(d));
  w.document.close();
}
