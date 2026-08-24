import { describe, it, expect } from "vitest";
import { productSlug, slugify } from "./product-slug";
import {
  generateInternalEan13, generateWeightTemplateEan13, isValidEan13,
  barcodeLabelSvg, labelWidthMm, symbologyOf,
} from "./barcode";

/**
 * "Every product gets a working, short barcode regardless of its name."
 *
 * The barcode VALUE is drawn from a database sequence and never touches the
 * product name, so name-independence is true by construction. The place a name
 * could still break things is one step earlier: if creating the product FAILS,
 * ensureVariantBarcodes() never runs and the item reaches the till with nothing
 * to scan. `store_listings.slug` is UNIQUE NOT NULL and the slugifier keeps only
 * [a-z0-9], so a name in Urdu, Arabic, emoji or pure punctuation slugifies to
 * "" — and two such products would collide.
 *
 * These names are the ones a Pakistani general store actually types.
 */
const NAMES: { label: string; name: string; sku: string }[] = [
  { label: "single character",        name: "A",                                            sku: "A1" },
  { label: "two characters",          name: "Ab",                                           sku: "AB2" },
  { label: "very long (45 chars)",    name: "Dollar Pointer Blue Ball Pen Fine Tip Pack 10", sku: "DPB-FINE-10" },
  { label: "very long (70 chars)",    name: "Imported Premium Quality Stainless Steel Vacuum Insulated Water Bottle", sku: "BOTL-VAC-750" },
  { label: "special characters",      name: "Café ☕ — 50% off!",                            sku: "CAFE-50" },
  { label: "punctuation only",        name: "!!!",                                          sku: "PUNCT-1" },
  { label: "purely numeric",          name: "12345",                                        sku: "NUM-12345" },
  { label: "numeric with symbols",    name: "1+1=2",                                        sku: "MATH-1" },
  { label: "Urdu",                    name: "صابن نیلا",                                     sku: "SOAP-BLUE" },
  { label: "Arabic",                  name: "قلم أزرق",                                      sku: "PEN-BLUE" },
  { label: "Urdu + Latin mix",        name: "چائے Tea 250g",                                 sku: "TEA-250" },
  { label: "emoji only",              name: "🧼",                                            sku: "EMOJI-1" },
  { label: "leading/trailing space",  name: "  Sugar  ",                                    sku: "  SUG-1  " },
  { label: "slashes and quotes",      name: 'Rice 5kg / "Basmati"',                         sku: "RICE-5" },
];

describe("product creation is never blocked by the product name", () => {
  it.each(NAMES)("$label — produces a non-empty listing slug", ({ name, sku }) => {
    const slug = productSlug(name, sku);
    expect(slug).toBeTruthy();
    expect(slug.length).toBeGreaterThan(0);
    // Must be URL-safe: the storefront routes on it.
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("gives every one of them a DISTINCT slug (no unique-constraint collision)", () => {
    const slugs = NAMES.map(({ name, sku }) => productSlug(name, sku));
    expect(new Set(slugs).size).toBe(NAMES.length);
  });

  it("keeps ordinary Latin names on their existing, readable slug", () => {
    // No random suffix for normal products — storefront URLs must not churn.
    expect(productSlug("Dollar Pointer Blue", "DPB-1")).toBe("dollar-pointer-blue-dpb-1");
    expect(productSlug("Sugar", "SUG-1")).toBe("sugar-sug-1");
  });

  it("falls back only when there is genuinely nothing printable", () => {
    // Urdu name + Urdu-digit SKU: both slugify to "" — the exact case that used
    // to let the first product through and reject every one after it.
    expect(slugify("صابن")).toBe("");
    expect(slugify("١٢٣")).toBe("");
    const a = productSlug("صابن", "١٢٣");
    const b = productSlug("قلم", "٤٥٦");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b); // would have collided before
  });
});

describe("the barcode itself is identical in shape for every name", () => {
  // Simulate the sequence the database hands out, one per product created.
  const codes = NAMES.map((_, i) => generateInternalEan13(1000 + i));

  it.each(NAMES.map((n, i) => ({ ...n, code: codes[i] })))(
    "$label — valid 13-digit EAN-13 ($code)",
    ({ code }) => {
      expect(code).toMatch(/^\d{13}$/);
      expect(isValidEan13(code)).toBe(true);
      expect(code.startsWith("29")).toBe(true); // GS1 internal prefix
    },
  );

  it("every generated code is exactly 13 digits — never long, never malformed", () => {
    const lengths = new Set(codes.map((c) => c.length));
    expect([...lengths]).toEqual([13]);
  });

  it("every code is unique", () => {
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("renders every one as an EAN-13 symbol of the SAME printed width", () => {
    const widths = new Set(codes.map((c) => labelWidthMm(c).toFixed(2)));
    expect(widths.size).toBe(1);                     // name has zero influence
    expect(Number([...widths][0])).toBeCloseTo(42.4, 1); // 113 modules x 0.375mm
    for (const c of codes) expect(symbologyOf(c)).toBe("EAN-13");
  });

  it("produces a printable label for every one, with no exceptions thrown", () => {
    for (const c of codes) {
      const svg = barcodeLabelSvg(c);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain("mm");
    }
  });

  it("holds across a large sequence range, not just the first few", () => {
    for (const seq of [1, 2, 99, 1000, 54321, 999999, 9999999999]) {
      const code = generateInternalEan13(seq);
      expect(code).toMatch(/^\d{13}$/);
      expect(isValidEan13(code)).toBe(true);
    }
  });

  it("variable-weight templates are equally well-formed", () => {
    for (const seq of [1, 42, 99999]) {
      const t = generateWeightTemplateEan13(seq);
      expect(t).toMatch(/^\d{13}$/);
      expect(isValidEan13(t)).toBe(true);
    }
  });
});
