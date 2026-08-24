import { describe, it, expect } from "vitest";
import {
  code128Values, code128Pattern, code128Svg,
  ean13Bits, ean13Svg, barcodeSvg, symbologyOf,
  generateInternalEan13, isValidEan13,
} from "./barcode";

// These guard the two properties the store actually depends on: the symbol is
// SHORT (so a label fits and stays above the minimum module width) and it is
// STRUCTURALLY VALID for its symbology (so a scanner reads it first sweep).

describe("Code-128 auto subset", () => {
  it("packs digit pairs into subset C (start C + 6 pairs + check + stop)", () => {
    const vals = code128Values("2900000010005"); // 13 digits
    expect(vals[0]).toBe(105); // START_C
    // START_C, 6 pairs (12 digits), CODE_B, last digit, checksum, STOP
    expect(vals.length).toBe(11);
    expect(vals.slice(1, 7)).toEqual([29, 0, 0, 0, 10, 0]); // 29 00 00 00 10 00
    expect(vals[7]).toBe(100); // CODE_B for the odd trailing digit
    expect(vals[8]).toBe("5".charCodeAt(0) - 32);
  });

  it("is far shorter than the all-subset-B encoding it replaces", () => {
    const modules = code128Pattern("2900000010005").reduce((a, b) => a + b, 0);
    // subset B would be 11 symbols of data + start + check = 178 + stop bar
    expect(modules).toBeLessThan(140);
  });

  it("keeps a pure-alphanumeric SKU in subset B", () => {
    const vals = code128Values("GRO-SUG-1");
    expect(vals[0]).toBe(104); // START_B
  });

  it("computes the modulo-103 checksum correctly for 'ABC'", () => {
    // start B(104) + A(33)*1 + B(34)*2 + C(35)*3 = 104+33+68+105 = 310; 310%103 = 1
    const vals = code128Values("ABC");
    expect(vals[vals.length - 2]).toBe(1);
    expect(vals[vals.length - 1]).toBe(106); // STOP
  });

  it("emits a quiet zone of at least 10 modules on each side", () => {
    const svg = code128Svg("ABC", { moduleWidth: 3, margin: 4, showText: false });
    // first bar must start at >= 30px (10 x 3px), never at the 4px asked for
    const firstX = Number(/<rect x="(\d+(?:\.\d+)?)"/.exec(svg.slice(svg.indexOf("<rect x=")))![1]);
    expect(firstX).toBeGreaterThanOrEqual(30);
  });
});

describe("EAN-13 symbol", () => {
  const COKE = "5449000000996";

  it("builds a 95-module symbol with the correct guard bars", () => {
    const bits = ean13Bits(COKE);
    expect(bits.length).toBe(95);
    expect(bits.slice(0, 3)).toBe("101");
    expect(bits.slice(45, 50)).toBe("01010");
    expect(bits.slice(92)).toBe("101");
  });

  it("encodes the left group with the parity pattern of the first digit", () => {
    // First digit 5 -> LGGLLG. Left digit 1 is '4' -> L(4) = 0100011.
    expect(ean13Bits(COKE).slice(3, 10)).toBe("0100011");
    // Left digit 2 is '4' with G parity -> G(4) = 0011101.
    expect(ean13Bits(COKE).slice(10, 17)).toBe("0011101");
  });

  it("encodes the right group with R patterns", () => {
    // Right digit 1 is '0' -> R(0) = 1110010.
    expect(ean13Bits(COKE).slice(50, 57)).toBe("1110010");
  });

  it("renders 11X left / 7X right quiet zones", () => {
    const X = 2;
    const svg = ean13Svg(COKE, { moduleWidth: X, showText: false });
    const width = Number(/width="(\d+(?:\.\d+)?)"/.exec(svg)![1]);
    expect(width).toBe((11 + 95 + 7) * X); // 113X total
    const firstX = Number(/<rect x="(\d+(?:\.\d+)?)"/.exec(svg.slice(svg.indexOf("<rect x=")))![1]);
    expect(firstX).toBe(11 * X);
  });

  it("prints the leading digit outside the symbol and both digit groups", () => {
    const svg = ean13Svg(COKE);
    expect(svg).toContain(">5</text>");        // number-system digit
    expect(svg).toContain(">449000</text>");   // left group
    expect(svg).toContain(">000996</text>");   // right group
  });
});

describe("symbology routing", () => {
  it("renders every internally generated code as a true EAN-13", () => {
    const code = generateInternalEan13(1234);
    expect(isValidEan13(code)).toBe(true);
    expect(symbologyOf(code)).toBe("EAN-13");
    expect(barcodeSvg(code, { showText: false })).toBe(ean13Svg(code, { showText: false }));
  });

  it("falls back to Code-128 for a non-EAN SKU", () => {
    expect(symbologyOf("GRO-SUG-1")).toBe("Code-128");
    expect(barcodeSvg("GRO-SUG-1")).toContain("<svg");
  });

  it("produces the same symbol width for a 1-letter and a 40-letter product", () => {
    // Barcode length depends only on the CODE, never on the product name.
    const a = barcodeSvg(generateInternalEan13(1), { showText: false });
    const b = barcodeSvg(generateInternalEan13(999999), { showText: false });
    const w = (s: string) => /width="(\d+(?:\.\d+)?)"/.exec(s)![1];
    expect(w(a)).toBe(w(b));
  });
});
