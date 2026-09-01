/**
 * The wire format must be a smaller ENCODING of the catalogue, never a smaller
 * catalogue. Everything packRow drops, unpackRow has to put back exactly — and
 * the one field where getting this wrong is dangerous is `barcodes`, because
 * the scan index is built from it and a dropped code is a product that stops
 * scanning at the till.
 */
import { describe, it, expect } from "vitest";
import { packRow, unpackRow, type DbRow } from "./catalog-payload";

function db(over: Partial<DbRow> = {}): DbRow {
  return {
    variant_id: "v1", product_id: "p1", product_name: "Sooper Biscuit", brand: "EBM",
    has_variants: false, is_variable_weight: false, sku: "SKU1", label: "Default",
    barcode: "8961100001019", barcodes: ["8961100001019"],
    price: 120, cost: 90, avg_cost: 95, disc_type: null, disc_value: 0,
    reorder_point: 5, category_id: "c1", image_url: null, unit: "Pcs",
    available: 12, active: true, updated_at: "2026-08-01T00:00:00Z", ...over,
  };
}

describe("what is dropped is reconstructible", () => {
  it("round-trips a plain row unchanged", () => {
    const item = unpackRow(packRow(db()));
    expect(item.barcodes).toEqual(["8961100001019"]);
    expect(item.image_url).toBeNull();
    expect(item.active).toBe(true);
    expect(item.product_name).toBe("Sooper Biscuit");
    expect(item.unit).toBe("Pcs");
  });

  it("omits barcodes only when it says nothing the primary code does not", () => {
    expect(packRow(db()).barcodes).toBeUndefined();
    expect(packRow(db({ barcodes: [] })).barcodes).toBeUndefined();
  });

  it("KEEPS every alternate code — a manufacturer EAN beside a shelf sticker", () => {
    const packed = packRow(db({ barcode: "8961100001019", barcodes: ["8961100001019", "258256"] }));
    expect(packed.barcodes).toEqual(["8961100001019", "258256"]);
    expect(unpackRow(packed).barcodes).toEqual(["8961100001019", "258256"]);
  });

  it("keeps a barcodes array that disagrees with the primary code", () => {
    const packed = packRow(db({ barcode: "111", barcodes: ["222"] }));
    expect(packed.barcodes).toEqual(["222"]);
  });

  it("restores an empty array — never undefined — for a variant with no code", () => {
    expect(unpackRow(packRow(db({ barcode: null, barcodes: null }))).barcodes).toEqual([]);
  });

  it("carries an image only when there is one", () => {
    expect(packRow(db()).image_url).toBeUndefined();
    const withPhoto = packRow(db({ image_url: "https://x/y.jpg" }));
    expect(withPhoto.image_url).toBe("https://x/y.jpg");
    expect(unpackRow(withPhoto).image_url).toBe("https://x/y.jpg");
  });
});

describe("cost is resolved once, server-side", () => {
  it("prefers the moving average, which is what the till computed itself", () => {
    // The POS read `avg_cost || cost`; sending both was 45 kB per payload to
    // let the client redo one fallback.
    const item = unpackRow(packRow(db({ cost: 90, avg_cost: 95 })));
    expect(item.cost).toBe(95);
    expect(item.avg_cost).toBe(95);
  });

  it("falls back to the entered cost when no average exists yet", () => {
    const item = unpackRow(packRow(db({ cost: 90, avg_cost: 0 })));
    expect(item.cost).toBe(90);
    expect(item.avg_cost).toBe(90);
  });
});

describe("numeric columns arrive as numbers", () => {
  it("coerces the numerics PostgREST hands back as strings", () => {
    const packed = packRow(db({
      price: "120.50" as unknown as number,
      available: "12.000" as unknown as number,
      disc_value: null as unknown as number,
      reorder_point: null as unknown as number,
    }));
    expect(packed.price).toBe(120.5);
    expect(packed.available).toBe(12);
    expect(packed.disc_value).toBe(0);
    expect(packed.reorder_point).toBe(0);
  });
});
