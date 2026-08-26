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

/**
 * Narrowest module a 203dpi thermal head can put down and still be read.
 *
 * Two dots is 25.4/203 x 2 = 0.250mm, which is the X-dimension floor GS1
 * specifies for Code-128 in general distribution. One dot (0.125mm) is below
 * every published minimum and prints as a smear. Nothing here is ever allowed
 * below this, even if that means a symbol wider than its target.
 */
const MIN_DOTS = 2;

/**
 * Widest module worth using, as a PHYSICAL width.
 *
 * Without a cap, a two-character code prints bars a third of a millimetre
 * thicker than the 13-digit EAN-13 next to it on the shelf, for no scanning
 * benefit — past roughly half a millimetre, extra thickness stops buying
 * anything a hand scanner can use. Capping also narrows the spread of bar
 * HEIGHTS, since the chrome around the bars scales with the module.
 *
 * Expressed in MILLIMETRES, not dots, deliberately: a dot count means different
 * physical widths at different resolutions, so a 4-dot cap would have made a
 * 300dpi head print a NARROWER symbol than a 203dpi one — the opposite of what
 * a finer printer should buy you.
 */
const MAX_MODULE_MM = 0.55;

/**
 * Name block: font size and how many lines it may occupy, per stock.
 *
 * The 50x30 roll gets TWO lines, not three. Every line reserved for the name is
 * a line the bars cannot have, and on a 30mm-tall sticker the third line costs
 * 2.8mm of bar height - which matters more to a scanner than the tail of a long
 * product name does to a person holding the item.
 */
function nameMetrics(stock: LabelStock) {
  return stock === "2x2"
    ? { fontMm: 3, lines: 3, lineHeight: 1.15 }
    : { fontMm: 2.4, lines: 2, lineHeight: 1.15 };
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
  /**
   * Width of the box the symbol is centred in. IDENTICAL for every product on a
   * given stock, so the barcode occupies the same footprint on every label
   * whatever it encodes.
   */
  targetWidthMm: number;
  /**
   * The symbol could not be squeezed into the box without going under
   * MIN_DOTS, so it is printing at the floor and overhanging the target. The
   * label is still scannable; it just is not uniform. Surfaced in the UI
   * rather than silently produced.
   */
  tooWide: boolean;
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
 * an angled sweep. It is the cheapest first-pass-read improvement available.
 *
 * UNIFORM WIDTH, AND WHY IT IS THE BOX AND NOT THE MODULE
 * ------------------------------------------------------
 * Every label should show the barcode at the same width whatever it encodes.
 * The obvious way — divide the target width by the module count and use the
 * quotient — produces a FRACTIONAL module (2.7 dots, 3.4 dots), and a printer
 * cannot lay down a fraction of a dot. It rounds each bar independently, so
 * nominally equal bars come out at different widths depending on where they
 * land, which is the "scans from some angles but not others" fault we are
 * trying to eliminate. Fractional modules would trade a real scanning property
 * for a cosmetic one.
 *
 * So the module stays a whole number of dots, and UNIFORMITY IS ACHIEVED BY
 * FOOTPRINT: every symbol is centred in a box of `targetWidthMm`, identical for
 * every product on the stock. The barcode occupies the same width and sits in
 * the same place on every sticker; what differs is bar THICKNESS, and that
 * difference is in the right direction — a short code gets fatter bars, which
 * reads more easily, and the leftover space becomes extra quiet zone, which
 * also reads more easily. On the 50x30 roll the symbols land between about 36
 * and 44mm inside a 48mm box.
 *
 * The one case that cannot be satisfied is a code so long that even MIN_DOTS
 * overflows the box. Rather than shrink below what a print head can resolve,
 * `tooWide` is set and the caller warns; the label still scans, it just is not
 * uniform. MAX_SKU_LENGTH exists partly to keep Code-128 out of that territory.
 */
export function fitLabel(code: string, stock: LabelStock, dpi: LabelDpi = DEFAULT_DPI): Fitted {
  const size = STOCK[stock];
  const dotMm = 25.4 / dpi;
  const modules = symbolModules(code);

  // The box every symbol is centred in, identical for all products on this
  // stock. See the note on UNIFORM WIDTH below.
  const targetWidthMm = size.widthMm - EDGE_MM * 2;

  // +1e-9 so a module that lands exactly on a dot boundary is not lost to
  // floating-point (at 300dpi, 5 dots is exact and would otherwise floor to 4).
  const maxDots = Math.max(MIN_DOTS, Math.floor(MAX_MODULE_MM / dotMm + 1e-9));
  const wanted = Math.floor(targetWidthMm / modules / dotMm + 1e-9);
  const dots = Math.min(maxDots, Math.max(MIN_DOTS, wanted));
  const moduleMm = dots * dotMm;
  const symbolWidthMm = moduleMm * modules;
  const tooWide = symbolWidthMm > targetWidthMm + 1e-9;

  // Vertical budget, worst case (a name using every line it is allowed).
  const nm = nameMetrics(stock);
  const nameBlockMm = nm.fontMm * nm.lineHeight * nm.lines;
  const gapMm = 1;
  // Chrome the symbol adds around the bars themselves — see ean13Svg: 2X of top
  // padding, 5X of guard-bar overhang, and 2.45X for the digit row. (The extra
  // 4 that used to be added here was a pixel constant being applied as
  // millimetres; removing it from the renderer is most of why the bars on a
  // 50x30 sticker roughly doubled.)
  const chromeMm = moduleMm * (2 + 5 + 7 * 0.35);
  const available = size.heightMm - EDGE_MM * 2 - nameBlockMm - gapMm - chromeMm;

  // EAN-13's nominal height is 22.85mm; taller is allowed and scans better, but
  // past ~30mm it only wastes stock, and the floor keeps a truncated symbol
  // readable if a name somehow eats the label.
  const barHeightMm = Math.max(10, Math.min(30, Math.round(available * 10) / 10));

  return { moduleMm, dots, barHeightMm, symbolWidthMm, targetWidthMm, tooWide, dpi };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The symbol at an explicit fitted size. */
export function fittedBarcodeSvg(code: string, fit: Fitted): string {
  const opts = { moduleWidth: fit.moduleMm, height: fit.barHeightMm, unit: "mm" as const };
  return isValidEan13(code) ? ean13Svg(code, opts) : code128Svg(code, opts);
}

/**
 * One label: the product name, then the barcode centred in its fixed-width box.
 *
 * The box is what makes every label's barcode the same width. The SVG inside is
 * never scaled to fit it — `svg{width:auto!important}` in the stylesheet is
 * load-bearing, because squeezing the symbol is exactly what drops the module
 * below what a scanner can resolve.
 */
export function labelHtml(name: string, code: string, fit: Fitted): string {
  return (
    `<div class="lbl">` +
    `<div class="nm">${escapeHtml(name)}</div>` +
    `<div class="bc" style="width:${fit.targetWidthMm}mm">${fittedBarcodeSvg(code, fit)}</div>` +
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
    // The uniform-width box: same width on every label, symbol centred in it.
    // overflow:visible so an over-long code (fit.tooWide) still prints in full
    // rather than being silently clipped to look like a shorter barcode.
    `.bc{display:flex;justify-content:center;align-items:center;flex:none;overflow:visible}` +
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
