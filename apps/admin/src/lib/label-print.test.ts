/**
 * The printed shelf label carries the product NAME and the BARCODE — and no
 * price. These tests are the guard on that: the price was previously rendered
 * as `<div class="pr">` on every label, so any change that reintroduces a
 * currency figure anywhere in the print document fails here.
 */
import { describe, it, expect } from "vitest";
import { labelHtml, labelDocument, labelPageCss, LABEL_W_MM, LABEL_H_MM } from "./label-print";
import { formatPKR } from "@hamza/shared/utils";

const NAME = "Areeba Sugar 1kg";
const CODE = "2900000010005";

/** Every way a rupee figure could show up on a label. */
const MONEY_MARKERS = [
  formatPKR(250),          // whatever Intl produces for en-PK / PKR
  "PKR", "Rs", "Rs.", "₨", "₨",
  'class="pr"', "class='pr'", ".pr{",
];

describe("one label", () => {
  const html = labelHtml(NAME, CODE);

  it("renders the product name", () => {
    expect(html).toContain(NAME);
  });

  it("renders the barcode symbol and its human-readable digits", () => {
    expect(html).toContain("<svg");
    expect(html).toContain(CODE); // printed under the bars by the EAN-13 renderer
  });

  it("renders NO price", () => {
    for (const marker of MONEY_MARKERS) expect(html).not.toContain(marker);
  });

  it("carries nothing beyond the name and the symbol", () => {
    // Strip the symbol and the name; what is left must be bare markup with no
    // number in it — a price row would show up here as a digit run.
    const text = labelHtml("Cooking Oil", CODE)
      .replace(/<svg[\s\S]*<\/svg>/, "")
      .replace("Cooking Oil", "");
    expect(text).not.toMatch(/\d/);
    expect(text).toBe('<div class="lbl"><div class="nm"></div></div>');
  });

  it("escapes a name that contains markup", () => {
    expect(labelHtml('A & B <script>x</script> "q"', CODE))
      .toContain("A &amp; B &lt;script&gt;x&lt;/script&gt; &quot;q&quot;");
  });
});

describe("the print document", () => {
  it("has no price on any stock", () => {
    for (const stock of ["sheet", "roll"] as const) {
      const doc = labelDocument({ name: NAME, code: CODE, copies: 3, stock, title: "GRO-SUG-1" });
      for (const marker of MONEY_MARKERS) expect(doc).not.toContain(marker);
    }
  });

  it("repeats the label once per copy", () => {
    const doc = labelDocument({ name: NAME, code: CODE, copies: 4, stock: "sheet", title: "X" });
    expect(doc.split('<div class="lbl">').length - 1).toBe(4);
  });

  it("clamps the copy count to a sane range", () => {
    const at = (copies: number) =>
      labelDocument({ name: NAME, code: CODE, copies, stock: "sheet", title: "X" })
        .split('<div class="lbl">').length - 1;
    expect(at(0)).toBe(1);
    expect(at(-5)).toBe(1);
    expect(at(1000)).toBe(200);
  });

  it("keeps the name and the symbol on every copy", () => {
    const doc = labelDocument({ name: NAME, code: CODE, copies: 2, stock: "roll", title: "X" });
    expect(doc.split(NAME).length - 1).toBe(2);
    expect(doc.split("<svg").length - 1).toBe(2);
  });

  it("never lets the layout resize the barcode symbol", () => {
    const doc = labelDocument({ name: NAME, code: CODE, copies: 1, stock: "sheet", title: "X" });
    expect(doc).toContain("width:auto!important");
    expect(doc).toContain("max-width:none!important");
  });
});

describe("layout after the price row was removed", () => {
  it("centres the remaining two elements on both axes, so no gap is left", () => {
    for (const stock of ["sheet", "roll"] as const) {
      const css = labelPageCss(stock);
      expect(css).toContain("align-items:center");
      expect(css).toContain("justify-content:center");
    }
  });

  it("keeps the die-cut label at its physical size on a roll", () => {
    const css = labelPageCss("roll");
    expect(css).toContain(`size:${LABEL_W_MM}mm ${LABEL_H_MM}mm`);
    expect(css).toContain(`width:${LABEL_W_MM}mm;height:${LABEL_H_MM}mm`);
  });

  it("gives the name the room the price used to take", () => {
    const doc = labelDocument({ name: NAME, code: CODE, copies: 1, stock: "roll", title: "X" });
    expect(doc).toContain("-webkit-line-clamp:3");
  });
});
