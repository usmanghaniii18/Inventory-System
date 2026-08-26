/**
 * The catalogue reconcile, and the one property that matters at a till: a
 * refresh that finds NOTHING NEW must cost nothing.
 *
 * The refresh runs on a 60-second interval and again on every window focus and
 * visibilitychange. Rebuilding the index and notifying React on each of those
 * re-rendered the POS product grid — over two thousand unvirtualised cards —
 * whether or not the shop had touched anything, and that re-render is what
 * blocked the main thread while a barcode was mid-flight.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { CatalogItem } from "./catalog-cache";

function item(id: string, code: string, updatedAt = "2026-08-01T00:00:00Z", available = 5): CatalogItem {
  return {
    variant_id: id, product_id: `p-${id}`, product_name: `Product ${id}`, brand: null,
    has_variants: false, is_variable_weight: false, sku: id, label: id,
    barcode: code, barcodes: [code], price: 100, cost: 60, disc_type: null, disc_value: 0,
    reorder_point: 0, category_id: null, image_url: null, unit: "Pcs",
    available, avg_cost: 60, active: true, updated_at: updatedAt,
  };
}

/** A fresh module instance per test — the cache is deliberately module-global. */
async function load(items: CatalogItem[]) {
  vi.resetModules();
  let served = items;
  const fetches: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async () => {
    fetches.push(Date.now());
    return { ok: true, json: async () => ({ items: served }) } as unknown as Response;
  }));
  const mod = await import("./catalog-cache");
  return {
    mod,
    fetches,
    serve: (next: CatalogItem[]) => { served = next; },
  };
}

beforeEach(() => { vi.stubGlobal("indexedDB", undefined); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("an unchanged catalogue costs nothing", () => {
  it("does not replace the snapshot when the server returns the same rows", async () => {
    const rows = [item("a", "8961100001019"), item("b", "258256")];
    const { mod } = await load(rows);

    await mod.ensureCatalog();
    const first = mod.getSnapshot();
    expect(first).not.toBeNull();

    let notified = 0;
    mod.subscribe(() => { notified++; });

    // Force the reconcile the interval/focus handlers would run.
    await mod.ensureCatalog({ force: true });

    expect(notified, "subscribers must not be woken for a no-op").toBe(0);
    expect(mod.getSnapshot(), "the snapshot object must be reused").toBe(first);
    expect(mod.getSnapshot()!.byBarcode).toBe(first!.byBarcode);
  });

  it("still records that the check happened, so the next tick does not re-fetch", async () => {
    const { mod } = await load([item("a", "8961100001019")]);
    await mod.ensureCatalog();
    const before = mod.getSnapshot()!.fetchedAt;
    await new Promise((r) => setTimeout(r, 2));
    await mod.ensureCatalog({ force: true });
    expect(mod.getSnapshot()!.fetchedAt).toBeGreaterThan(before);
    expect(mod.getSnapshot()!.fresh).toBe(true);
  });
});

describe("a changed catalogue is picked up", () => {
  it("rebuilds and notifies when a barcode is added", async () => {
    const { mod, serve } = await load([item("a", "8961100001019")]);
    await mod.ensureCatalog();
    expect(mod.isKnownBarcode("258256")).toBe(false);

    let notified = 0;
    mod.subscribe(() => { notified++; });

    serve([item("a", "8961100001019"), item("b", "258256")]);
    await mod.ensureCatalog({ force: true });

    expect(notified).toBe(1);
    expect(mod.isKnownBarcode("258256")).toBe(true);
    expect(mod.lookupByBarcode("258256")?.variant_id).toBe("b");
  });

  it("rebuilds when only stock moved", async () => {
    const { mod, serve } = await load([item("a", "8961100001019", "2026-08-01T00:00:00Z", 5)]);
    await mod.ensureCatalog();
    serve([item("a", "8961100001019", "2026-08-01T00:00:00Z", 4)]);
    await mod.ensureCatalog({ force: true });
    expect(mod.lookupByBarcode("8961100001019")?.available).toBe(4);
  });

  it("rebuilds when a row is edited in place", async () => {
    const { mod, serve } = await load([item("a", "8961100001019", "2026-08-01T00:00:00Z")]);
    await mod.ensureCatalog();
    const changed = item("a", "8961100001019", "2026-08-26T09:00:00Z");
    changed.price = 250;
    serve([changed]);
    await mod.ensureCatalog({ force: true });
    expect(mod.lookupByBarcode("8961100001019")?.price).toBe(250);
  });
});

describe("concurrent refreshes share one request", () => {
  it("focus, visibilitychange and the interval do not stack up fetches", async () => {
    const { mod, fetches } = await load([item("a", "8961100001019")]);
    await mod.ensureCatalog();
    const afterFirst = fetches.length;

    // What returning to the till actually fires: several triggers at once.
    await Promise.all([
      mod.ensureCatalog({ force: true }),
      mod.ensureCatalog({ force: true }),
      mod.ensureCatalog({ force: true }),
    ]);

    expect(fetches.length - afterFirst).toBe(1);
  });
});
