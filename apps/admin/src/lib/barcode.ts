// Barcode utilities shared by the universal scan layer (Section 2).
//
// Covers three needs:
//   1. parseScan()        — normalise any scanned string, detecting
//                           weight/price-embedded EAN-13 (variable-weight items)
//                           and producing a stable lookupKey for the catalogue.
//   2. internal code gen  — GS1 prefix-2 EAN-13 for items with no manufacturer
//                           barcode, and weight templates for variable-weight.
//   3. barcodeSvg()       — dependency-free label renderer: a real EAN-13
//                           symbol for a valid 13-digit EAN, Code-128 (with
//                           automatic B/C subset switching) for anything
//                           else. Both emit ISO-spec quiet zones.
//
// In-store GS1 "prefix 2" convention used here (configurable):
//   - WEIGHT_PREFIXES ("20","21") => weight/price embedded:
//       [PP][IIIII][VVVVV][C]  = 2-digit prefix, 5-digit item ref,
//                                5-digit value, 1 check digit.
//       The scale fills VVVVV per package; we zero it to get the lookup key.
//   - Any other prefix-2 code we generate ("29…") is a plain internal code.

export const WEIGHT_PREFIXES = ["20", "21"];
/** Value field divisor: grams -> kg (1000). Price-mode stores can set 100. */
export const WEIGHT_DIVISOR = 1000;

/** EAN-13 check digit for the first 12 digits. */
export function ean13Check(d12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

/** True if a 12/13-digit numeric string is a valid EAN-13 (or completes one). */
export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  return ean13Check(code.slice(0, 12)) === Number(code[12]);
}

export interface ParsedScan {
  raw: string;
  /** Normalised code as scanned. */
  barcode: string;
  /** What to match against product_barcodes (weight template if embedded). */
  lookupKey: string;
  isWeightEmbedded: boolean;
  /** Decoded quantity in base units (kg) when weight-embedded. */
  weight?: number;
  itemRef?: string;
}

/**
 * Normalise a raw scan. For weight/price-embedded EAN-13 it returns the decoded
 * weight plus a `lookupKey` with the value field zeroed (the template stored on
 * the variant), so a different weight on every package still resolves.
 */
export function parseScan(raw: string): ParsedScan {
  const code = raw.trim();
  if (/^\d{13}$/.test(code) && WEIGHT_PREFIXES.includes(code.slice(0, 2))) {
    const prefix = code.slice(0, 2);
    const itemRef = code.slice(2, 7);
    const value = Number(code.slice(7, 12));
    const template12 = `${prefix}${itemRef}00000`;
    const lookupKey = template12 + ean13Check(template12);
    return {
      raw,
      barcode: code,
      lookupKey,
      isWeightEmbedded: true,
      weight: value / WEIGHT_DIVISOR,
      itemRef,
    };
  }
  return { raw, barcode: code, lookupKey: code, isWeightEmbedded: false };
}

/**
 * Does this text look like MACHINE input (a scanned or hand-typed code) rather
 * than a product search?
 *
 * Used at the till to decide whether a term that matched no barcode is a failed
 * scan (report it) or a search (fuzzy-match it). Three or more bare digits is
 * the line: nobody searches the catalogue by typing bare digits, while every
 * barcode — and every FRAGMENT of one left behind by a half-read scan — is
 * exactly that. Getting this wrong in the permissive direction is what let a
 * fragment resolve to an unrelated product and bill it.
 */
export function looksLikeCode(text: string): boolean {
  return /^\d{3,}$/.test(text.trim());
}

function pad(n: number | string, len: number) {
  return String(n).replace(/\D/g, "").padStart(len, "0").slice(-len);
}

/** Widest sequence value {@link generateWeightTemplateEan13} can encode safely. */
export const MAX_WEIGHT_ITEM_REF = 99_999;

/** Widest sequence value {@link generateInternalEan13} can encode safely. */
export const MAX_INTERNAL_SEQ = 9_999_999_999;

/**
 * Plain internal EAN-13 (prefix "29") for an item with no manufacturer code.
 * Guarded against the same 10-digit truncation-into-collision as the weight
 * template above — see {@link generateWeightTemplateEan13}.
 */
export function generateInternalEan13(seq: number, prefix = "29"): string {
  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_INTERNAL_SEQ) {
    throw new RangeError(`internal barcode seq ${seq} does not fit the 10-digit field`);
  }
  const d12 = `${prefix}${pad(seq, 10)}`;
  return d12 + ean13Check(d12);
}

/**
 * Weight-template EAN-13 (value field zeroed) to store on a variable-weight
 * variant.
 *
 * The item ref field is only 5 digits wide, and `pad` truncates to the LAST 5 —
 * so a sequence value above 99999 used to silently wrap and mint a code already
 * assigned to another product. The DB's unique constraint would then reject the
 * insert, the caller swallowed the error, and the item shipped with no barcode
 * at all. Throwing here surfaces the exhaustion instead of corrupting the range.
 */
export function generateWeightTemplateEan13(itemRef: number, prefix = WEIGHT_PREFIXES[0]): string {
  if (!Number.isInteger(itemRef) || itemRef < 0 || itemRef > MAX_WEIGHT_ITEM_REF) {
    throw new RangeError(
      `weight item ref ${itemRef} does not fit the 5-digit field (0-${MAX_WEIGHT_ITEM_REF})`,
    );
  }
  const d12 = `${prefix}${pad(itemRef, 5)}00000`;
  return d12 + ean13Check(d12);
}

/** Build a concrete weight-embedded code (e.g. for a label preview at a weight). */
export function encodeWeightEan13(itemRef: number, weightKg: number, prefix = WEIGHT_PREFIXES[0]): string {
  const value = Math.round(weightKg * WEIGHT_DIVISOR);
  const d12 = `${prefix}${pad(itemRef, 5)}${pad(value, 5)}`;
  return d12 + ean13Check(d12);
}

// ---- Code-128 (dependency-free, auto subset B/C) --------------------------
// Canonical 107-entry module-width pattern table (index 106 = stop).
const C128 = [
  "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213",
  "221312","231212","112232","122132","122231","113222","123122","123221","223211","221132",
  "221231","213212","223112","312131","311222","321122","321221","312212","322112","322211",
  "212123","212321","232121","111323","131123","131321","112313","132113","132311","211313",
  "231113","231311","112133","112331","132131","113123","113321","133121","313121","211331",
  "231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
  "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214",
  "112412","122114","122411","142112","142211","241211","221114","413111","241112","134111",
  "111242","121142","121241","114212","124112","124211","411212","421112","421211","212141",
  "214121","412121","111143","111341","131141","114113","114311","411113","411311","113141",
  "114131","311141","411131","211412","211214","211232","2331112",
];
const CODE_C = 99;  // switch to subset C (from B)
const CODE_B = 100; // switch to subset B (from C)
const START_B = 104;
const START_C = 105;
const STOP = 106;

const isDigitAt = (s: string, i: number) => i >= 0 && i < s.length && s[i] >= "0" && s[i] <= "9";
function digitRun(s: string, i: number) {
  let n = 0;
  while (isDigitAt(s, i + n)) n++;
  return n;
}

/**
 * Code-128 symbol values with automatic subset switching.
 *
 * Subset C packs TWO digits into one symbol, so a 13-digit code costs 7 symbols
 * instead of 13. This is why generated labels used to come out roughly twice as
 * wide as they needed to be: everything was encoded in subset B, one symbol per
 * character, regardless of the code being pure digits. Switching rules follow
 * the ISO/IEC 15417 recommendation (start in C on 4+ leading digits; hop into C
 * for a run of 6+ digits mid-string, or a trailing even run of 4+).
 */
export function code128Values(text: string): number[] {
  const vals: number[] = [];
  let mode: "B" | "C";
  let i = 0;
  const lead = digitRun(text, 0);
  if (lead >= 4 || (lead === text.length && lead >= 2 && lead % 2 === 0)) {
    mode = "C";
    vals.push(START_C);
  } else {
    mode = "B";
    vals.push(START_B);
  }

  while (i < text.length) {
    if (mode === "C") {
      if (isDigitAt(text, i) && isDigitAt(text, i + 1)) {
        vals.push(Number(text.slice(i, i + 2)));
        i += 2;
      } else {
        vals.push(CODE_B);
        mode = "B";
      }
      continue;
    }
    const run = digitRun(text, i);
    const trailing = i + run === text.length;
    if (run >= 6 || (trailing && run >= 4)) {
      // Align onto an even boundary before switching (subset C needs pairs).
      if (run % 2 === 1) {
        vals.push(text.charCodeAt(i) - 32);
        i++;
      }
      vals.push(CODE_C);
      mode = "C";
      continue;
    }
    const c = text.charCodeAt(i);
    i++;
    if (c < 32 || c > 127) continue; // not representable in subset B — skip it
    vals.push(c - 32);
  }

  // Modulo-103 checksum: start value + Σ(value × position), position from 1.
  let sum = vals[0];
  for (let k = 1; k < vals.length; k++) sum += vals[k] * k;
  vals.push(sum % 103);
  vals.push(STOP);
  return vals;
}

/** Code-128 module-width sequence (bars/spaces, starting with a bar). */
export function code128Pattern(text: string): number[] {
  const widths: number[] = [];
  for (const v of code128Values(text)) for (const ch of C128[v]) widths.push(Number(ch));
  return widths;
}

export interface Code128Opts {
  height?: number;
  moduleWidth?: number;
  margin?: number;
  showText?: boolean;
  color?: string;
  /**
   * Unit stamped on the SVG's width/height (the viewBox stays unitless, so the
   * drawing scales with it). Pass "mm" and a millimetre moduleWidth to get a
   * symbol whose PRINTED module width is exact — the only way to guarantee the
   * bars land on the spec'd width rather than on whatever a CSS box squeezes
   * them to. Default "" keeps the historic px behaviour.
   */
  unit?: "" | "mm" | "px";
}

/**
 * Render a Code-128 barcode as a standalone SVG string.
 *
 * Quiet zone: ISO/IEC 15417 requires a clear margin of at least 10X (ten module
 * widths) on BOTH sides of the symbol. The margin therefore scales with
 * moduleWidth and is floored at 10X — a fixed 10px margin (5X at the default
 * 2px module) was below spec and is a classic cause of a scanner refusing the
 * first sweep across a label.
 */
export function code128Svg(text: string, opts: Code128Opts = {}): string {
  const { height = 56, moduleWidth = 2, showText = true, color = "#111", unit = "" } = opts;
  const margin = Math.max(opts.margin ?? 0, moduleWidth * 10);
  const widths = code128Pattern(text);
  const totalModules = widths.reduce((a, b) => a + b, 0);
  const w = totalModules * moduleWidth + margin * 2;
  const fsFor = unit === "mm" ? moduleWidth * 6 : 13;
  // Baseline sits at margin + height + fs; reserve a descender past it rather
  // than a second full quiet-zone margin, which is what used to be added and
  // cost several millimetres of bar height on a small label.
  const textH = showText ? fsFor * 1.35 : 0;
  const h = margin + height + textH;

  let x = margin;
  let bar = true; // patterns start with a bar
  let rects = "";
  for (const width of widths) {
    const px = width * moduleWidth;
    if (bar) rects += `<rect x="${x}" y="${margin}" width="${px}" height="${height}" fill="${color}"/>`;
    x += px;
    bar = !bar;
  }
  const fs = fsFor;
  const label = showText
    ? `<text x="${w / 2}" y="${margin + height + fs}" font-family="monospace" font-size="${fs}" text-anchor="middle" fill="${color}">${text}</text>`
    : "";
  return svgWrap(w, h, unit, rects + label);
}

/** Wrap rendered bars in an SVG root, optionally sized in physical units. */
function svgWrap(w: number, h: number, unit: string, body: string): string {
  const rw = Math.round(w * 1000) / 1000;
  const rh = Math.round(h * 1000) / 1000;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${rw}${unit}" height="${rh}${unit}" viewBox="0 0 ${rw} ${rh}" shape-rendering="crispEdges">` +
    `<rect width="${rw}" height="${rh}" fill="#fff"/>${body}</svg>`;
}

// ---- EAN-13 (dependency-free) --------------------------------------------
// The internal codes this system generates ARE valid EAN-13s, so the printed
// label should be a real EAN-13 symbol: 95 modules of symbol vs ~101 in
// Code-128 subset C and 178 in subset B — the shortest, most universally
// readable retail symbology, and the one every supermarket scanner is tuned for.
//
// Geometry follows ISO/IEC 15420 at the nominal (SC2, 100%) magnification:
//   module X            0.33 mm
//   symbol              95X          (3 + 42 + 5 + 42 + 3)
//   left quiet zone     11X   right quiet zone 7X
//   bar height          22.85 mm; guard bars run 5X deeper for the digit row.
const EAN_L = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
const EAN_G = ["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
const EAN_R = ["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"];
/** Which of the six left-hand digits use G (even) parity, per the first digit. */
const EAN_PARITY = ["000000","001011","001101","001110","010011","011001","011100","010101","010110","011010"];

/** EAN-13 module bitmap (1 = bar) — 95 modules, no quiet zones. */
export function ean13Bits(code: string): string {
  const d = code.split("").map(Number);
  const parity = EAN_PARITY[d[0]];
  let bits = "101"; // start guard
  for (let i = 1; i <= 6; i++) bits += parity[i - 1] === "0" ? EAN_L[d[i]] : EAN_G[d[i]];
  bits += "01010"; // centre guard
  for (let i = 7; i <= 12; i++) bits += EAN_R[d[i]];
  bits += "101"; // end guard
  return bits;
}

export interface Ean13Opts {
  /** Module (narrowest bar) width. Nominal (SC2 / 100%) is 0.33mm. */
  moduleWidth?: number;
  /** Bar height, excluding the guard-bar extension. Nominal is 22.85mm. */
  height?: number;
  showText?: boolean;
  color?: string;
  /** See {@link Code128Opts.unit} — pass "mm" for an exact printed size. */
  unit?: "" | "mm" | "px";
}

/**
 * Render a valid 13-digit EAN-13 as an SVG, to spec: 11X left and 7X right
 * quiet zones, guard bars extended 5X below the data bars, and the leading
 * digit printed in the left quiet zone (which is also what reserves it).
 */
export function ean13Svg(code: string, opts: Ean13Opts = {}): string {
  const { moduleWidth = 2, height = 60, showText = true, color = "#111", unit = "" } = opts;
  const X = moduleWidth;
  const QZ_LEFT = 11 * X;
  const QZ_RIGHT = 7 * X;
  const bits = ean13Bits(code);
  const guardDrop = showText ? 5 * X : 0;
  const textH = showText ? (unit === "mm" ? X * 7 : Math.max(10, X * 7)) : 0;
  const padTop = 2 * X;
  const w = QZ_LEFT + bits.length * X + QZ_RIGHT;
  // Space below the guard bars for the digit row. The `textH * 0.35` term
  // already covers the descender: the baseline sits at padTop + height +
  // guardDrop - 0.5X, so the glyphs reach only ~0.1X past the guard bars while
  // this reserves 2.45X. The trailing constant that used to be added here was
  // written for pixels and was being applied VERBATIM in millimetre mode, where
  // it silently ate 4mm off every printed label - about a quarter of the bar
  // height available on a 50x30mm sticker. It is kept for the px preview, where
  // 4px is what it always meant, and dropped for mm.
  const h = padTop + height + guardDrop + (showText ? textH * 0.35 : 0) + (showText && unit !== "mm" ? 4 : 0);

  // Guard-bar module positions (start 0-2, centre 45-49, end 92-94) run deeper.
  const isGuard = (i: number) => (i >= 0 && i <= 2) || (i >= 45 && i <= 49) || (i >= 92 && i <= 94);
  let rects = "";
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] !== "1") continue;
    const x = QZ_LEFT + i * X;
    const barH = height + (isGuard(i) ? guardDrop : 0);
    rects += `<rect x="${x}" y="${padTop}" width="${X}" height="${barH}" fill="${color}"/>`;
  }

  let text = "";
  if (showText) {
    const fs = unit === "mm" ? X * 6 : Math.max(8, X * 6);
    const baseline = padTop + height + guardDrop - X * 0.5;
    const mid = (from: number, to: number) => QZ_LEFT + ((from + to) / 2) * X;
    const t = (x: number, s: string, anchor = "middle") =>
      `<text x="${x}" y="${baseline}" font-family="Arial, Helvetica, sans-serif" font-size="${fs}" text-anchor="${anchor}" fill="${color}">${s}</text>`;
    text += t(QZ_LEFT - X * 1.5, code[0], "end");                  // leading digit, in the quiet zone
    text += t(mid(3, 45), code.slice(1, 7));                        // left group
    text += t(mid(50, 92), code.slice(7, 13));                      // right group
  }

  return svgWrap(w, h, unit, rects + text);
}

/**
 * Render whatever symbology suits the code: a real EAN-13 symbol for a valid
 * 13-digit EAN (every internally generated code), Code-128 with automatic
 * subset switching for anything else (alphanumeric SKUs, supplier codes).
 * Both paths emit spec quiet zones, so a label prints scannable either way.
 */
export function barcodeSvg(code: string, opts: Code128Opts & Ean13Opts = {}): string {
  return isValidEan13(code) ? ean13Svg(code, opts) : code128Svg(code, opts);
}

/**
 * Print geometry for the shelf-label printer.
 *
 * A 203 dpi thermal head puts down one dot every 25.4/203 = 0.1251mm. Choosing
 * a module width that is a WHOLE number of dots is what keeps every bar the
 * same printed width — a fractional module makes the printer round some bars up
 * and some down, and an uneven symbol is a classic "scans sometimes" fault.
 *
 *   EAN-13   3 dots = 0.375mm  (above the 0.33mm nominal, so >100% magnification)
 *            symbol 95X + 18X quiet zones = 113X = 42.4mm wide
 *   Code-128 2 dots = 0.250mm  (comfortably above the 0.19mm practical minimum)
 *            quiet zone 10X each side, enforced by code128Svg
 */
export const LABEL_DPI = 203;
export const LABEL_DOT_MM = 25.4 / LABEL_DPI;
export const EAN13_MODULE_MM = LABEL_DOT_MM * 3;
export const CODE128_MODULE_MM = LABEL_DOT_MM * 2;
/** Bar height in mm. EAN-13's nominal is 22.85mm; shelf labels run truncated. */
export const LABEL_BAR_HEIGHT_MM = 14;

/** Millimetre-accurate label symbol, ready to drop into a print stylesheet. */
export function barcodeLabelSvg(code: string, barHeightMm = LABEL_BAR_HEIGHT_MM): string {
  return isValidEan13(code)
    ? ean13Svg(code, { moduleWidth: EAN13_MODULE_MM, height: barHeightMm, unit: "mm" })
    : code128Svg(code, { moduleWidth: CODE128_MODULE_MM, height: barHeightMm, unit: "mm" });
}

/** Printed width in mm of {@link barcodeLabelSvg}, quiet zones included. */
export function labelWidthMm(code: string): number {
  if (isValidEan13(code)) return (11 + 95 + 7) * EAN13_MODULE_MM;
  const modules = code128Pattern(code).reduce((a, b) => a + b, 0);
  return (modules + 20) * CODE128_MODULE_MM;
}

/** Which symbology {@link barcodeSvg} will use — for label copy / diagnostics. */
export function symbologyOf(code: string): "EAN-13" | "Code-128" {
  return isValidEan13(code) ? "EAN-13" : "Code-128";
}
