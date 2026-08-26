/**
 * The app and the maintenance scripts must mint identical internal barcodes.
 *
 * apps/admin/src/lib/barcode.ts is what assignInternalBarcode() uses from the
 * admin UI; scripts/lib/internal-barcode.mjs is what the direct-to-Postgres
 * scripts use, because those cannot import TypeScript or reach a Supabase
 * client. Two implementations of one numbering scheme is a standing risk of a
 * silent fork in the barcode range, so it is asserted here rather than trusted.
 */
import { describe, it, expect } from "vitest";
import {
  ean13Check as tsCheck,
  generateInternalEan13 as tsInternal,
  generateWeightTemplateEan13 as tsWeight,
  MAX_INTERNAL_SEQ as TS_MAX_SEQ,
  MAX_WEIGHT_ITEM_REF as TS_MAX_REF,
} from "./barcode";
import {
  ean13Check as jsCheck,
  generateInternalEan13 as jsInternal,
  generateWeightTemplateEan13 as jsWeight,
  MAX_INTERNAL_SEQ as JS_MAX_SEQ,
  MAX_WEIGHT_ITEM_REF as JS_MAX_REF,
} from "../../../../scripts/lib/internal-barcode.mjs";

describe("scripts/lib/internal-barcode.mjs matches lib/barcode.ts", () => {
  it("agrees on the check digit for every 12-digit pattern tried", () => {
    const samples = [
      "290000000100", "290000099999", "200100000000",
      "000000000000", "999999999999", "123456789012",
    ];
    for (const d12 of samples) expect(jsCheck(d12)).toBe(tsCheck(d12));
  });

  it("agrees on internal codes across the sequence range", () => {
    const seeds = [0, 1, 999, 1000, 1001, 1002, 12345, 99999, 100000, 1e6, 123456789, MAX_SAFE()];
    for (const n of seeds) expect(jsInternal(n)).toBe(tsInternal(n));
  });

  it("agrees on weight templates across the item-ref range", () => {
    for (const n of [0, 1, 999, 1000, 12345, 99998, 99999]) {
      expect(jsWeight(n)).toBe(tsWeight(n));
    }
  });

  it("agrees on a dense sweep around the live sequence position", () => {
    // Production sequence sat at 1001 when the 18 missing barcodes were minted.
    for (let n = 990; n <= 1100; n++) expect(jsInternal(n)).toBe(tsInternal(n));
  });

  it("shares the same range limits", () => {
    expect(JS_MAX_SEQ).toBe(TS_MAX_SEQ);
    expect(JS_MAX_REF).toBe(TS_MAX_REF);
  });

  it("rejects an out-of-range value in both", () => {
    expect(() => jsInternal(TS_MAX_SEQ + 1)).toThrow(RangeError);
    expect(() => tsInternal(TS_MAX_SEQ + 1)).toThrow(RangeError);
    expect(() => jsWeight(TS_MAX_REF + 1)).toThrow(RangeError);
    expect(() => tsWeight(TS_MAX_REF + 1)).toThrow(RangeError);
  });

  it("produces valid EAN-13s", () => {
    for (const n of [1001, 1002, 1018, 50000]) {
      const code = jsInternal(n);
      expect(code).toMatch(/^29\d{11}$/);
      expect(tsCheck(code.slice(0, 12))).toBe(Number(code[12]));
    }
  });
});

function MAX_SAFE() {
  return 9_999_999_999;
}
