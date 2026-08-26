/**
 * The printed shelf label carries the product NAME and the BARCODE — no price —
 * and the symbol is as large as the stock allows, on whole printer dots.
 *
 * The price was previously rendered as `<div class="pr">` on every label, so any
 * change that reintroduces a currency figure anywhere fails here. The geometry
 * assertions guard the other half: a symbol that is silently smaller, or whose
 * module is a fractional number of dots, is the classic "scans sometimes" fault.
 */
import { describe, it, expect } from "vitest";
import {
  labelHtml, labelDocument, labelPageCss, fitLabel, symbolModules,
  nameCharsPerLine, STOCK, MAX_SKU_LENGTH, DEFAULT_DPI, fittedBarcodeSvg,
  type LabelStock,
} from "./label-print";
import { formatPKR } from "@hamza/shared/utils";
import { isValidEan13 } from "./barcode";

const NAME = "Areeba Sugar 1kg";
// A REAL production barcode with a valid check digit. The old fixture
// 2900000010005 has a WRONG check digit, so it silently rendered as Code-128
// and the EAN-13 geometry below was never actually being exercised.
const CODE = "2900000010024";
const SKU_CODE = "GRO-SUG-1"; // alphanumeric -> Code-128
const STOCKS: LabelStock[] = ["sheet", "roll", "2x2"];

/** Every way a rupee figure could show up on a label. */
const MONEY_MARKERS = [formatPKR(250), "PKR", "Rs", "Rs.", "₨", 'class="pr"', ".pr{"];

const fit2x2 = fitLabel(CODE, "2x2");
const fitRoll = fitLabel(CODE, "roll");

/** A real spread of the shop's live code lengths, 1 char to 13 digits. */
const REAL_CODES = [
  "M", "AB", "3DX", "411", "604B", "LINER",
  "BREMOD30", "GRO-SUG-1", "PARTYPOPPER", "2900000010024", "2900000010192",
];

describe("no price, ever", () => {
  it("is absent from one label", () => {
    const html = labelHtml(NAME, CODE, fit2x2);
    for (const m of MONEY_MARKERS) expect(html).not.toContain(m);
  });

  it("is absent from the print document on every stock", () => {
    for (const stock of STOCKS) {
      const doc = labelDocument({ name: NAME, code: CODE, copies: 3, stock, title: "GRO-SUG-1" });
      for (const m of MONEY_MARKERS) expect(doc).not.toContain(m);
    }
  });

  it("carries nothing beyond the name and the symbol", () => {
    // Strip the symbol and the name; what remains must be the two wrappers and
    // nothing else — a price row would show up here as extra markup or a digit.
    const rest = labelHtml("Cooking Oil", CODE, fit2x2)
      .replace(/<svg[\s\S]*<\/svg>/, "")
      .replace("Cooking Oil", "");
    expect(rest).toBe(
      '<div class="lbl"><div class="nm"></div>' +
      `<div class="bc" style="width:${fit2x2.targetWidthMm}mm"></div></div>`,
    );
    // the only number left is the box width, which is geometry, not content
    expect(rest.replace(`width:${fit2x2.targetWidthMm}mm`, "")).not.toMatch(/\d/);
  });

  it("escapes a name containing markup", () => {
    expect(labelHtml('A & B <script>x</script> "q"', CODE, fit2x2))
      .toContain("A &amp; B &lt;script&gt;x&lt;/script&gt; &quot;q&quot;");
  });
});

describe("the symbol is as large as the stock allows", () => {
  it("2x2 gives the bars roughly double the old 14mm height", () => {
    expect(fit2x2.barHeightMm).toBeGreaterThan(24);
    // EAN-13's nominal height is 22.85mm; we exceed it, which scans better.
    expect(fit2x2.barHeightMm).toBeGreaterThanOrEqual(22.85);
  });

  it("never overflows the stock it is printed on", () => {
    for (const stock of STOCKS) {
      for (const code of [CODE, SKU_CODE]) {
        const f = fitLabel(code, stock);
        expect(f.symbolWidthMm).toBeLessThanOrEqual(STOCK[stock].widthMm);
      }
    }
  });

  it("uses a WHOLE number of printer dots for the module", () => {
    for (const stock of STOCKS) {
      for (const dpi of [203, 300] as const) {
        const f = fitLabel(CODE, stock, dpi);
        const dotMm = 25.4 / dpi;
        expect(f.moduleMm / dotMm).toBeCloseTo(Math.round(f.moduleMm / dotMm), 9);
        // Below two dots a thermal head cannot hold a bar edge.
        expect(f.dots).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("a finer print head buys a wider symbol, not a narrower one", () => {
    const at203 = fitLabel(CODE, "2x2", 203);
    const at300 = fitLabel(CODE, "2x2", 300);
    expect(at300.dots).toBeGreaterThan(at203.dots);
    expect(at300.symbolWidthMm).toBeGreaterThanOrEqual(at203.symbolWidthMm);
  });

  it("the 2x2 stock still has more room than the 50x30 roll", () => {
    expect(fit2x2.barHeightMm).toBeGreaterThan(fitRoll.barHeightMm);
  });

  it("the roll stock's bars are far taller than the 11.2mm they used to be", () => {
    // Two changes bought this: the pixel constant that was being applied as
    // millimetres in the renderer, and dropping the name block to two lines.
    expect(fitRoll.barHeightMm).toBeGreaterThan(15);
  });

  it("counts quiet zones inside the symbol width", () => {
    // EAN-13: 11 left + 95 symbol + 7 right, per ISO/IEC 15420.
    expect(symbolModules(CODE)).toBe(113);
    expect(isValidEan13(CODE)).toBe(true);
    // Code-128: 10 modules of quiet zone each side, per ISO/IEC 15417.
    expect(symbolModules(SKU_CODE)).toBeGreaterThan(20);
  });

  it("keeps the spec quiet zones in the rendered SVG", () => {
    const svg = labelHtml(NAME, CODE, fit2x2);
    // The first bar cannot start before 11 modules of white.
    const firstX = Number(/<rect x="([\d.]+)"[^>]*fill="#111"/.exec(svg)?.[1] ?? 0);
    expect(firstX).toBeGreaterThanOrEqual(11 * fit2x2.moduleMm - 1e-6);
  });
});

describe("the print document", () => {
  it("repeats the label once per copy and clamps the count", () => {
    const at = (copies: number) =>
      labelDocument({ name: NAME, code: CODE, copies, stock: "2x2", title: "X" })
        .split('<div class="lbl">').length - 1;
    expect(at(4)).toBe(4);
    expect(at(0)).toBe(1);
    expect(at(-5)).toBe(1);
    expect(at(1000)).toBe(200);
  });

  it("never lets the layout resize the symbol", () => {
    const doc = labelDocument({ name: NAME, code: CODE, copies: 1, stock: "2x2", title: "X" });
    expect(doc).toContain("width:auto!important");
    expect(doc).toContain("max-width:none!important");
    expect(doc).toContain("flex:none");
  });

  it("sets the page to the physical stock size", () => {
    expect(labelPageCss("2x2")).toContain("size:50.8mm 50.8mm");
    expect(labelPageCss("roll")).toContain("size:50mm 30mm");
    expect(labelPageCss("sheet")).toContain("size:A4");
  });

  it("centres on both axes so no gap is left where the price was", () => {
    for (const stock of STOCKS) {
      expect(labelPageCss(stock)).toContain("align-items:center");
      expect(labelPageCss(stock)).toContain("justify-content:center");
    }
  });

  it("bounds the name block so a long name cannot push the symbol off", () => {
    const doc = labelDocument({ name: NAME, code: CODE, copies: 1, stock: "2x2", title: "X" });
    expect(doc).toMatch(/-webkit-line-clamp:\d/);
    expect(doc).toMatch(/max-height:[\d.]+mm/);
  });
});

describe("SKU length limit for the 2x2 label", () => {
  it("a SKU at the limit fits on one line of the name block", () => {
    expect(MAX_SKU_LENGTH).toBeLessThanOrEqual(nameCharsPerLine("2x2") - 3); // " · "
  });

  it("the longest allowed SKU still renders name + symbol, nothing dropped", () => {
    const longest = "A".repeat(MAX_SKU_LENGTH);
    const doc = labelDocument({
      name: `SOME PRODUCT · ${longest}`, code: CODE, copies: 1, stock: "2x2", title: longest,
    });
    expect(doc).toContain(longest);
    expect(doc).toContain("<svg");
    // and the label still fits: the name block is clamped, not the symbol
    expect(doc).toMatch(/-webkit-line-clamp:3/);
  });

  it("a short SKU produces the same symbol geometry as the longest one", () => {
    const a = labelDocument({ name: "X · AB", code: CODE, copies: 1, stock: "2x2", title: "AB" });
    const b = labelDocument({ name: `X · ${"A".repeat(MAX_SKU_LENGTH)}`, code: CODE, copies: 1, stock: "2x2", title: "L" });
    const svgOf = (d: string) => /<svg[\s\S]*?<\/svg>/.exec(d)?.[0] ?? "";
    expect(svgOf(a)).toBe(svgOf(b));
  });
});


describe("every barcode occupies the same width, whatever it encodes", () => {
  it("gives every code an identical box on the roll stock", () => {
    const boxes = new Set(REAL_CODES.map((c) => fitLabel(c, "roll").targetWidthMm));
    expect(boxes.size).toBe(1);
    expect([...boxes][0]).toBe(48); // 50mm stock less 1mm of edge each side
  });

  it("renders that box at a fixed width in the markup", () => {
    const widths = new Set(
      REAL_CODES.map((c) => {
        const doc = labelDocument({ name: "X", code: c, copies: 1, stock: "roll", title: "X" });
        return /<div class="bc" style="width:([\d.]+)mm"/.exec(doc)?.[1];
      }),
    );
    expect(widths.size).toBe(1);
    expect([...widths][0]).toBe("48");
  });

  it("keeps every symbol inside that box", () => {
    for (const c of REAL_CODES) {
      const f = fitLabel(c, "roll");
      expect(f.tooWide).toBe(false);
      expect(f.symbolWidthMm).toBeLessThanOrEqual(f.targetWidthMm);
    }
  });

  it("never prints a module below the 203dpi safe minimum", () => {
    // 2 dots = 0.250mm, the GS1 X-dimension floor for Code-128.
    for (const c of REAL_CODES) {
      const f = fitLabel(c, "roll");
      expect(f.dots).toBeGreaterThanOrEqual(2);
      expect(f.moduleMm).toBeGreaterThanOrEqual(25.4 / 203 * 2 - 1e-9);
    }
  });

  it("keeps every module a whole number of dots across the whole spread", () => {
    for (const c of REAL_CODES) {
      const f = fitLabel(c, "roll");
      const ratio = f.moduleMm / (25.4 / 203);
      expect(ratio).toBeCloseTo(Math.round(ratio), 9);
    }
  });

  it("centres the symbol in the box rather than stretching it", () => {
    const doc = labelDocument({ name: "X", code: "AB", copies: 1, stock: "roll", title: "X" });
    expect(doc).toContain("justify-content:center");
    // the symbol itself must never be resized to fill the box
    expect(doc).toContain("width:auto!important");
  });
});

describe("a code too long for the stock is reported, not silently shrunk", () => {
  const longest = "A".repeat(MAX_SKU_LENGTH);

  it("flags it instead of going under the safe module width", () => {
    const f = fitLabel(longest, "roll");
    expect(f.tooWide).toBe(true);
    expect(f.dots).toBe(2);                       // pinned at the floor, not below
    expect(f.symbolWidthMm).toBeGreaterThan(f.targetWidthMm);
  });

  it("still prints in full rather than being clipped to look like a shorter code", () => {
    const doc = labelDocument({ name: "X", code: longest, copies: 1, stock: "roll", title: "X" });
    expect(doc).toContain("overflow:visible");
  });

  it("a 13-digit EAN-13 — the normal worst case — fits comfortably", () => {
    expect(fitLabel("2900000010024", "roll").tooWide).toBe(false);
  });
});

/**
 * The physical output, measured off the rendered SVG rather than trusted from
 * the fitting maths.
 *
 * A label that "passes its own tests" while printing wrong is exactly what was
 * suspected when the shop's printed codes stopped scanning, so these assertions
 * deliberately do not reuse fitLabel's arithmetic: they read the bar rectangles
 * out of the finished symbol and measure the white space either side of them.
 * (The scanning fault turned out to be in the wedge detector, not here — see
 * useHardwareScanner.regression.test.ts — and these exist so that conclusion
 * stays checkable.)
 */
describe("the printed symbol, measured off the rendered SVG", () => {
  /** Left and right quiet zones, in modules, as actually drawn. */
  function quietZones(svg: string, moduleMm: number) {
    const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
    const width = Number(vb![1]);
    // The first rect is the white background; the bars are the rest.
    const bars = [...svg.matchAll(/<rect x="([\d.]+)"[^>]*width="([\d.]+)"/g)]
      .map((m) => ({ x: Number(m[1]), w: Number(m[2]) }));
    const first = Math.min(...bars.map((b) => b.x));
    const last = Math.max(...bars.map((b) => b.x + b.w));
    return { left: first / moduleMm, right: (width - last) / moduleMm, width, bars };
  }

  // Real codes from the live catalogue, across the length spread the shop
  // actually prints — including the 6-digit sticker the client photographed.
  const LIVE = [
    "M", "3DX", "411", "25717", "258256", "2586700",
    "29000000", "2900000010024", "8961100001019", "PARTYPOPPER",
  ];

  for (const dpi of [203, 300] as const) {
    describe(`on the 50 x 30mm roll at ${dpi}dpi`, () => {
      it("every module is a WHOLE number of printer dots", () => {
        const dotMm = 25.4 / dpi;
        for (const code of LIVE) {
          const f = fitLabel(code, "roll", dpi);
          const dots = f.moduleMm / dotMm;
          expect(Math.abs(dots - Math.round(dots)), `${code}: ${dots} dots`).toBeLessThan(1e-9);
          expect(f.dots).toBeGreaterThanOrEqual(2); // GS1 X-dimension floor
        }
      });

      it("both quiet zones are to spec — the centring never eats one side", () => {
        for (const code of LIVE) {
          const f = fitLabel(code, "roll", dpi);
          const qz = quietZones(fittedBarcodeSvg(code, f), f.moduleMm);
          // EAN-13: 11X left / 7X right (ISO/IEC 15420). Code-128: 10X both.
          const [minL, minR] = isValidEan13(code) ? [11, 7] : [10, 10];
          // The svg's width attribute is written to 3 decimal places, so the
          // right-hand zone measures up to a thousandth of a millimetre short of
          // nominal. A hundredth of a MODULE of slack absorbs that and nothing
          // else: at the narrowest module here it is under half a micrometre,
          // while a real centring fault would cost whole modules.
          const ROUNDING = 0.01;
          expect(qz.left, `${code} left quiet zone`).toBeGreaterThanOrEqual(minL - ROUNDING);
          expect(qz.right, `${code} right quiet zone`).toBeGreaterThanOrEqual(minR - ROUNDING);
        }
      });

      it("the drawn width matches the fitted width, and fits the box", () => {
        for (const code of LIVE) {
          const f = fitLabel(code, "roll", dpi);
          const qz = quietZones(fittedBarcodeSvg(code, f), f.moduleMm);
          expect(qz.width).toBeCloseTo(f.symbolWidthMm, 2);
          expect(f.tooWide, `${code} should fit the box`).toBe(false);
          expect(f.symbolWidthMm).toBeLessThanOrEqual(f.targetWidthMm + 1e-9);
        }
      });

      it("the symbol never overhangs the physical edge of the sticker", () => {
        for (const code of LIVE) {
          const f = fitLabel(code, "roll", dpi);
          expect(f.symbolWidthMm, `${code}`).toBeLessThanOrEqual(STOCK.roll.widthMm);
        }
      });

      it("bars stay tall enough for a hand-held sweep", () => {
        for (const code of LIVE) {
          expect(fitLabel(code, "roll", dpi).barHeightMm, `${code}`).toBeGreaterThanOrEqual(10);
        }
      });

      it("the SVG carries explicit millimetre units, so nothing prints at px scale", () => {
        for (const code of LIVE) {
          const svg = fittedBarcodeSvg(code, fitLabel(code, "roll", dpi));
          expect(svg, code).toMatch(/<svg[^>]*width="[\d.]+mm"[^>]*height="[\d.]+mm"/);
        }
      });
    });
  }

  it("the dialog's default DPI is the one the roll is laid out for", () => {
    expect(DEFAULT_DPI).toBe(203);
  });

  it("every code length the shop can generate fits the roll", () => {
    // Digits only: this is the range internal/shelf codes are drawn from.
    for (let len = 1; len <= 13; len++) {
      const f = fitLabel("1".repeat(len), "roll", DEFAULT_DPI);
      expect(f.tooWide, `${len} digits`).toBe(false);
      expect(f.dots, `${len} digits`).toBeGreaterThanOrEqual(2);
    }
  });
});
