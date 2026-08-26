/**
 * The printed shelf label — markup and print stylesheet as pure functions.
 *
 * Pulled out of LabelDialog so the one rule that matters about a label can
 * actually be asserted in a test rather than only checked by eye on paper:
 *
 *   A LABEL CARRIES THE PRODUCT NAME AND THE BARCODE. NOTHING ELSE.
 *
 * It used to carry the sale price too, which meant every price change silently
 * invalidated a drawer full of already-printed stickers. Price belongs on the
 * shelf edge and in the POS, both of which are cheap to change; a printed
 * sticker is not.
 */
import { barcodeLabelSvg, LABEL_BAR_HEIGHT_MM } from "./barcode";

/**
 * Label stock. "roll" prints ONE label per page sized to the die-cut label (a
 * dedicated barcode/label printer); "sheet" lays labels out on A4.
 */
export type LabelStock = "sheet" | "roll";

export const LABEL_W_MM = 50;
export const LABEL_H_MM = 30;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** One label: the product name, then the barcode symbol at its exact mm size. */
export function labelHtml(name: string, code: string): string {
  return (
    `<div class="lbl">` +
    `<div class="nm">${escapeHtml(name)}</div>` +
    // The symbol must NOT be scaled by the surrounding CSS box: squeezing it is
    // what drops the module width below what a scanner can resolve.
    barcodeLabelSvg(code, LABEL_BAR_HEIGHT_MM) +
    `</div>`
  );
}

/** Page + label geometry for the chosen stock. */
export function labelPageCss(stock: LabelStock): string {
  // Both stocks centre their children, so the label reads the same whether it
  // holds two elements or three — removing the price row re-centres name and
  // symbol in the same space rather than leaving a gap at the bottom.
  return stock === "roll"
    ? `@page{size:${LABEL_W_MM}mm ${LABEL_H_MM}mm;margin:0}` +
      `.lbl{width:${LABEL_W_MM}mm;height:${LABEL_H_MM}mm;page-break-after:always;` +
      `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1mm;border:0}` +
      `.grid{display:block}`
    : `@page{size:A4;margin:8mm}` +
      `.grid{display:flex;flex-wrap:wrap;gap:3mm}` +
      `.lbl{width:${LABEL_W_MM}mm;border:0.2mm solid #eee;border-radius:1mm;padding:1.5mm;` +
      `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1mm;page-break-inside:avoid}`;
}

/** The complete print document: `copies` identical labels, ready to window.print(). */
export function labelDocument(opts: {
  name: string;
  code: string;
  copies: number;
  stock: LabelStock;
  /** Shown in the print window's title bar — the variant SKU. */
  title: string;
}): string {
  const n = Math.max(1, Math.min(200, Math.floor(opts.copies) || 1));
  const one = labelHtml(opts.name, opts.code);
  return (
    `<html><head><title>Labels — ${escapeHtml(opts.title)}</title><style>` +
    `*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;margin:0;color:#000;background:#fff;` +
    `-webkit-print-color-adjust:exact;print-color-adjust:exact}` +
    labelPageCss(opts.stock) +
    // The name may run to three lines: it no longer shares the label with a
    // price, and a longer name is more useful than empty space.
    `.nm{font-size:2.4mm;font-weight:600;line-height:1.15;text-align:center;max-width:100%;` +
    `overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}` +
    // Critical: never let the layout resize the symbol.
    `svg{width:auto!important;max-width:none!important;height:auto!important;display:block}` +
    `</style></head><body><div class="grid">${Array(n).fill(one).join("")}</div>` +
    `<script>window.onload=function(){window.print()}</script></body></html>`
  );
}
