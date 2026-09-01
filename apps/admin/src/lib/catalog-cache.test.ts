/**
 * The catalogue reconcile, and the two properties that matter at a till: a
 * refresh that finds NOTHING NEW must cost nothing, and a change must never be
 * missed.
 *
 * "Cost nothing" now has a second, harder meaning than when these tests were
 * written. It used to mean only that React was not woken: the payload had
 * already been downloaded by the time the no-op was detected. Polling every
 * open screen every minute at ~1.22 MB a time is what exhausted the Supabase
 * egress quota and 402'd the whole project — auth included — so the refresh
 * now revalidates with If-None-Match and an unchanged catalogue comes back 304
 * with no body at all. See api/catalog/route.ts and catalog-server-cache.ts.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { WireRow } from "./catalog-payload";

function item(id: string, code: string, updatedAt = "2026-08-01T00:00:00Z", available = 5): WireRow {
  return {
    variant_id: id, product_id: `p-${id}`, product_name: `Product ${id}`, brand: null,
    has_variants: false, is_variable_weight: false, sku: id, label: id,
    barcode: code, price: 100, cost: 60, disc_type: null, disc_value: 0,
    reorder_point: 0, category_id: null, unit: "Pcs",
    available, updated_at: updatedAt,
  };
}

/** A fresh module instance per test — the cache is deliberately module-global. */
async function load(items: WireRow[], opts: { etag?: string | null } = {}) {
  vi.resetModules();
  let served = items;
  let tag: string | null = opts.etag === undefined ? 'W/"v1"' : opts.etag;
  const fetches: { ifNoneMatch: string | null; status: number }[] = [];

  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const sent = (init?.headers as Record<string, string> | undefined)?.["If-None-Match"] ?? null;
    // Exactly what the route does: matching validator -> 304, no body.
    const notModified = tag !== null && sent === tag;
    fetches.push({ ifNoneMatch: sent, status: notModified ? 304 : 200 });
    return {
      ok: true,
      status: notModified ? 304 : 200,
      headers: { get: (h: string) => (h.toLowerCase() === "etag" ? tag : null) },
      json: async () => ({ items: served }),
    } as unknown as Response;
  }));

  const mod = await import("./catalog-cache");
  return {
    mod,
    fetches,
    /** Serve a different catalogue under a new validator, as the server would. */
    serve: (next: WireRow[], nextTag: string | null = `W/"${Math.random()}"`) => {
      served = next;
      tag = nextTag;
    },
  };
}

beforeEach(() => { vi.stubGlobal("indexedDB", undefined); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("an unchanged catalogue is not downloaded at all", () => {
  it("sends If-None-Match once it holds a validator, and takes the 304", async () => {
    const { mod, fetches } = await load([item("a", "8961100001019")]);
    await mod.ensureCatalog();

    // First contact: nothing to revalidate against, so a full 200.
    expect(fetches[0]).toEqual({ ifNoneMatch: null, status: 200 });

    await mod.ensureCatalog({ force: true });
    expect(fetches[1], "the held ETag must be offered back").toEqual({
      ifNoneMatch: 'W/"v1"', status: 304,
    });
  });

  it("keeps the cached rows through a 304 — a body-less reply is not an empty catalogue", async () => {
    const { mod } = await load([item("a", "8961100001019"), item("b", "258256")]);
    await mod.ensureCatalog();

    let notified = 0;
    mod.subscribe(() => { notified++; });
    await mod.ensureCatalog({ force: true });

    expect(notified, "a 304 must not wake subscribers").toBe(0);
    expect(mod.getSnapshot()!.items).toHaveLength(2);
    expect(mod.lookupByBarcode("258256")?.variant_id).toBe("b");
    expect(mod.getSnapshot()!.fresh).toBe(true);
  });

  it("still records the check, so the next tick does not re-fetch", async () => {
    const { mod } = await load([item("a", "8961100001019")]);
    await mod.ensureCatalog();
    const before = mod.getSnapshot()!.fetchedAt;
    await new Promise((r) => setTimeout(r, 2));
    await mod.ensureCatalog({ force: true });
    expect(mod.getSnapshot()!.fetchedAt).toBeGreaterThan(before);
  });

  it("falls back to the payload signature when the server sends no ETag", async () => {
    // The window before migration 0032 is applied. The saving is smaller — the
    // body still travels — but the till must still not re-render for a no-op.
    const { mod } = await load([item("a", "8961100001019")], { etag: null });
    await mod.ensureCatalog();
    const first = mod.getSnapshot();

    let notified = 0;
    mod.subscribe(() => { notified++; });
    await mod.ensureCatalog({ force: true });

    expect(notified).toBe(0);
    expect(mod.getSnapshot()).toBe(first);
  });
});

describe("a change still gets through", () => {
  it("rebuilds when the validator moves", async () => {
    const { mod, serve } = await load([item("a", "8961100001019")]);
    await mod.ensureCatalog();
    expect(mod.isKnownBarcode("258256")).toBe(false);

    serve([item("a", "8961100001019"), item("b", "258256")]);
    await mod.ensureCatalog({ force: true });

    expect(mod.isKnownBarcode("258256")).toBe(true);
    expect(mod.lookupByBarcode("258256")?.variant_id).toBe("b");
  });

  it("picks up a stock move even though updated_at did not change", async () => {
    // The reason `available` is fingerprinted separately, server-side and here:
    // it comes from variant_availability, and a sale moves it without touching
    // either updated_at column.
    const { mod, serve } = await load([item("a", "8961100001019", "2026-08-01T00:00:00Z", 5)]);
    await mod.ensureCatalog();
    serve([item("a", "8961100001019", "2026-08-01T00:00:00Z", 4)]);
    await mod.ensureCatalog({ force: true });
    expect(mod.lookupByBarcode("8961100001019")?.available).toBe(4);
  });
});

describe("a sale patches stock locally instead of re-downloading the catalogue", () => {
  it("decrements what was sold and wakes the grid once", async () => {
    const { mod, fetches } = await load([
      item("a", "8961100001019", "2026-08-01T00:00:00Z", 10),
      item("b", "258256", "2026-08-01T00:00:00Z", 3),
    ]);
    await mod.ensureCatalog();
    const before = fetches.length;

    let notified = 0;
    mod.subscribe(() => { notified++; });
    mod.applyStockDelta([{ variant_id: "a", qty: 2 }, { variant_id: "b", qty: 1 }]);

    expect(fetches.length, "no network round trip for a sale").toBe(before);
    expect(notified, "one re-render for the whole sale, not one per line").toBe(1);
    expect(mod.lookupByBarcode("8961100001019")?.available).toBe(8);
    expect(mod.lookupByBarcode("258256")?.available).toBe(2);
  });

  it("clamps at zero rather than showing negative stock", async () => {
    const { mod } = await load([item("a", "8961100001019", "2026-08-01T00:00:00Z", 2)]);
    await mod.ensureCatalog();
    mod.applyStockDelta([{ variant_id: "a", qty: 5 }]);
    expect(mod.lookupByBarcode("8961100001019")?.available).toBe(0);
  });

  it("ignores unknown variants and no-op deltas without waking the grid", async () => {
    const { mod } = await load([item("a", "8961100001019", "2026-08-01T00:00:00Z", 4)]);
    await mod.ensureCatalog();
    let notified = 0;
    mod.subscribe(() => { notified++; });
    mod.applyStockDelta([{ variant_id: "nope", qty: 1 }, { variant_id: "a", qty: 0 }]);
    expect(notified).toBe(0);
    expect(mod.lookupByBarcode("8961100001019")?.available).toBe(4);
  });

  it("drops the validator, so the next poll cannot be told 'nothing changed'", async () => {
    // The held rows no longer match what the ETag describes. Offering it back
    // would earn a 304 and strand the local guess as if it were authoritative.
    const { mod, fetches, serve } = await load([item("a", "8961100001019", "2026-08-01T00:00:00Z", 10)]);
    await mod.ensureCatalog();
    mod.applyStockDelta([{ variant_id: "a", qty: 2 }]);

    serve([item("a", "8961100001019", "2026-08-01T00:00:00Z", 7)], 'W/"v2"');
    await mod.ensureCatalog({ force: true });

    expect(fetches.at(-1)!.ifNoneMatch).toBeNull();
    expect(mod.lookupByBarcode("8961100001019")?.available, "server wins over the local guess").toBe(7);
  });
});

describe("concurrent refreshes share one request", () => {
  it("focus, visibilitychange and the interval do not stack up fetches", async () => {
    const { mod, fetches } = await load([item("a", "8961100001019")]);
    await mod.ensureCatalog();
    const afterFirst = fetches.length;

    await Promise.all([
      mod.ensureCatalog({ force: true }),
      mod.ensureCatalog({ force: true }),
      mod.ensureCatalog({ force: true }),
    ]);

    expect(fetches.length - afterFirst).toBe(1);
  });
});
