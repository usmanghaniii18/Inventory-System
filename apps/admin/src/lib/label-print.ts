// The printed shelf label — markup and print stylesheet as pure functions.
//
// Pulled out of LabelDialog so the rules about a label can be asserted in tests
// rather than checked by eye on paper:
//
//   A LABEL CARRIES THE PRODUCT NAME AND THE BARCODE. NOTHING ELSE.
//   THE SYMBOL IS AS LARGE AS THE STOCK ALLOWS, ON WHOLE PRINTER DOTS.
//
// Price used to be on here too, which meant every price change silently
// invalidated a drawer of printed stickers. It is gone.
import { ean13Svg, code128Svg, isValidEan13, code128Pattern } from "./barcode";

/**
 * Label stock.
 *   sheet — many labels flowed onto A4 (office printer)
 *   roll  — 50 x 30mm die-cut, one per page (the original thermal roll)
 *   2x2   — 50.8 x 50.8mm die-cut (2 x 2 inch), the stock the shop moved to
 */
export type LabelStock = "sheet" | "roll" | "2x2";

export interface StockSize {
  widthMm: number;
  heightMm: number;
  label: string;
}

export const STOCK: Record<LabelStock, StockSize> = {
  sheet: { widthMm: 50, heightMm: 30, label: "A4 sheet (many per page)" },
  roll: { widthMm: 50, heightMm: 30, label: "Label roll 50 x 30mm" },
  "2x2": { widthMm: 50.8, heightMm: 50.8, label: "Label roll 2 x 2 inch (50.8mm)" },
};

/** Print head resolutions these labels are laid out for. */
export type LabelDpi = 203 | 300;
export const DEFAULT_DPI: LabelDpi = 203;

/**
 * Outer white margin inside the die-cut edge.
 *
 * Kept small ON PURPOSE. EAN-13 already carries its own quiet zones INSIDE the
 * symbol (11 modules left, 7 right, per ISO/IEC 15420) and Code-128 carries 10
 * modules each side, so this is extra white on top of a margin that is already
 * to spec. Every millimetre spent here is a millimetre the bars cannot use, and
 * on a 2-inch label the difference decides whether a whole extra printer dot
 * fits into the module width.
 */
const EDGE_MM = 1;

/** Name block: font size and how many lines it may occupy, per stock. */
function nameMetrics(stock: LabelStock) {
  return stock === "2x2"
    ? { fontMm: 3, lines: 3, lineHeight: 1.15 }
    : { fontMm: 2.4, lines: 3, lineHeight: 1.15 };
}

/** Total module count across a symbol INCLUDING its own quiet zones. */
export function symbolModules(code: string): number {
  // EAN-13: 11 (left quiet) + 95 (symbol) + 7 (right quiet)
  if (isValidEan13(code)) return 11 + 95 + 7;
  // Code-128: pattern + 10 modules of quiet zone each side
  return code128Pattern(code).reduce((a, b) => a + b, 0) + 20;
}

export interface Fitted {
  /** Module (narrowest bar) width in mm — always a whole number of dots. */
  moduleMm: number;
  /** Whole printer dots per module. Below 2 a thermal head cannot hold a bar. */
  dots: number;
  /** Bar height in mm, filling the space the name does not need. */
  barHeightMm: number;
  /** Printed symbol width in mm, quiet zones included. */
  symbolWidthMm: number;
  dpi: LabelDpi;
}

/**
 * Largest symbol that fits this stock, snapped to whole printer dots.
 *
 * WHY WHOLE DOTS. A 203dpi head puts down one dot every 25.4/203 = 0.1251mm. A
 * module width that is not a whole number of dots forces the printer to round
 * some bars up and some down, and a symbol with uneven bars is the classic
 * "scans sometimes, from some angles" fault. Maximising within that constraint
 * is why this is computed rather than hard-coded: at 203dpi a 2-inch label
 * tops out at 3 dots, but at 300dpi the same label takes 5, and hard-coded
 * millimetres would silently throw that away.
 *
 * HEIGHT MATTERS MORE THAN WIDTH. Width is capped by the stock; height is not,
 * and taller bars are what give a hand-held scanner room to cross the symbol on
 * an angled sweep. Going from the old 14mm to ~28mm is the single biggest
 * first-pass-read improvement available here, and it costs nothing but the
 * white space the price used to occupy.
 */
export function fitLabel(code: string, stock: LabelStock, dpi: LabelDpi = DEFAULT_DPI): Fitted {
  const size = STOCK[stock];
  const dotMm = 25.4 / dpi;
  const modules = symbolModules(code);

  const usableWidth = size.widthMm - EDGE_MM * 2;
  // +1e-9 so a module that lands exactly on a dot boundary is not lost to
  // floating-point (at 300dpi, 5 dots is exact and would otherwise floor to 4).
  const dots = Math.max(2, Math.floor(usableWidth / modules / dotMm + 1e-9));
  const moduleMm = dots * dotMm;
  const symbolWidthMm = moduleMm * modules;

  // Vertical budget, worst case (a name using every line it is allowed).
  const nm = nameMetrics(stock);
  const nameBlockMm = nm.fontMm * nm.lineHeight * nm.lines;
  const gapMm = 1;
  // Chrome the symbol adds around the bars themselves — see ean13Svg: 2X of top
  // padding, 5X of guard-bar overhang, and the human-readable digit row.
  const chromeMm = moduleMm * 2 + moduleMm * 5 + moduleMm * 7 * 0.35 + 4;
  const available = size.heightMm - EDGE_MM * 2 - nameBlockMm - gapMm - chromeMm;

  // EAN-13's nominal height is 22.85mm; taller is allowed and scans better, but
  // past ~30mm it only wastes stock, and the floor keeps a truncated symbol
  // readable if a name somehow eats the label.
  const barHeightMm = Math.max(10, Math.min(30, Math.round(available * 10) / 10));

  return { moduleMm, dots, barHeightMm, symbolWidthMm, dpi };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The symbol at an explicit fitted size. */
export function fittedBarcodeSvg(code: string, fit: Fitted): string {
  const opts = { moduleWidth: fit.moduleMm, height: fit.barHeightMm, unit: "mm" as const };
  return isValidEan13(code) ? ean13Svg(code, opts) : code128Svg(code, opts);
}

/** One label: the product name, then the barcode symbol at its fitted size. */
export function labelHtml(name: string, code: string, fit: Fitted): string {
  return (
    `<div class="lbl">` +
    `<div class="nm">${escapeHtml(name)}</div>` +
    // The symbol must NOT be scaled by the surrounding CSS box: squeezing it is
    // what drops the module width below what a scanner can resolve.
    fittedBarcodeSvg(code, fit) +
    `</div>`
  );
}

/** Page + label geometry for the chosen stock. */
export function labelPageCss(stock: LabelStock): string {
  const { widthMm, heightMm } = STOCK[stock];
  // Both stocks centre their children, so the label reads the same whether the
  // name runs to one line or three.
  const common =
    `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1mm`;
  return stock === "sheet"
    ? `@page{size:A4;margin:8mm}` +
      `.grid{display:flex;flex-wrap:wrap;gap:3mm}` +
      `.lbl{width:${widthMm}mm;border:0.2mm solid #eee;border-radius:1mm;padding:${EDGE_MM}mm;` +
      `${common};page-break-inside:avoid}`
    : `@page{size:${widthMm}mm ${heightMm}mm;margin:0}` +
      `.lbl{width:${widthMm}mm;height:${heightMm}mm;padding:${EDGE_MM}mm;page-break-after:always;` +
      `${common};border:0}` +
      `.grid{display:block}`;
}

/** The complete print document: `copies` identical labels, ready to print. */
export function labelDocument(opts: {
  name: string;
  code: string;
  copies: number;
  stock: LabelStock;
  dpi?: LabelDpi;
  /** Shown in the print window's title bar — the variant SKU. */
  title: string;
}): string {
  const n = Math.max(1, Math.min(200, Math.floor(opts.copies) || 1));
  const fit = fitLabel(opts.code, opts.stock, opts.dpi ?? DEFAULT_DPI);
  const nm = nameMetrics(opts.stock);
  const one = labelHtml(opts.name, opts.code, fit);
  return (
    `<html><head><title>Labels — ${escapeHtml(opts.title)}</title><style>` +
    `*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;margin:0;color:#000;background:#fff;` +
    `-webkit-print-color-adjust:exact;print-color-adjust:exact}` +
    labelPageCss(opts.stock) +
    // The name is bounded to a fixed number of lines so a long one can never
    // push the symbol off a fixed-height die-cut label.
    `.nm{font-size:${nm.fontMm}mm;font-weight:600;line-height:${nm.lineHeight};text-align:center;` +
    `max-width:100%;max-height:${(nm.fontMm * nm.lineHeight * nm.lines).toFixed(2)}mm;` +
    `overflow:hidden;display:-webkit-box;-webkit-line-clamp:${nm.lines};-webkit-box-orient:vertical}` +
    // Critical: never let the layout resize the symbol.
    `svg{width:auto!important;max-width:none!important;height:auto!important;display:block;flex:none}` +
    `</style></head><body><div class="grid">${Array(n).fill(one).join("")}</div>` +
    `<script>window.onload=function(){window.print()}</script></body></html>`
  );
}

// ---- SKU length -----------------------------------------------------------
//
// The SKU reaches the label through the variant label: a variant with no option
// values falls back to its SKU, and the label prints "<product name> · <label>".
// So an over-long SKU eats the name block, and on a fixed-height die-cut label
// what overflows is clipped.
//
// Budget on the 2x2 stock, which is the tightest case that matters:
//   usable width      50.8 - 2 x 1mm edge          = 48.8mm
//   name font                                       = 3mm
//   Arial advance, uppercase, conservative          = 0.60 em -> 1.8mm/char
//   characters per line   48.8 / 1.8                = 27
//   minus the " · " separator the label inserts     = 24
//
// 24 therefore fits on one line with the separator, at the largest name font any
// stock uses. It is a limit on the SKU alone; the product name has the other two
// lines. Anything longer is refused at the point of entry rather than silently
// clipped, because a clipped SKU on a shelf label is indistinguishable from a
// different SKU.
export { MAX_SKU_LENGTH } from "@hamza/shared/validation";

/** Characters per line of the name block, for the stock given. */
export function nameCharsPerLine(stock: LabelStock): number {
  const nm = nameMetrics(stock);
  const usable = STOCK[stock].widthMm - EDGE_MM * 2;
  return Math.floor(usable / (nm.fontMm * 0.6));
}
