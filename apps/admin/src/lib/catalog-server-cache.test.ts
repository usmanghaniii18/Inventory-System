/**
 * The half of the fix that protects the SUPABASE bill.
 *
 * The ETag in the route saves Railway -> browser bytes; it cannot save Supabase
 * egress, because you cannot fingerprint data you have not fetched. These tests
 * pin the property that does: past the TTL the cache asks catalog_fingerprint()
 * — ~40 bytes — and only re-reads the ~1.22 MB catalogue when that answer
 * actually moved.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { load, reset, weakHash, TTL_MS, type Loaders } from "./catalog-server-cache";
import type { WireRow } from "./catalog-payload";

function row(id: string, updated = "2026-08-01T00:00:00Z", available = 5): WireRow {
  return {
    variant_id: id, product_id: `p-${id}`, product_name: `P ${id}`, brand: null,
    has_variants: false, is_variable_weight: false, sku: id, label: id,
    barcode: `bc-${id}`, price: 100, cost: 60, disc_type: null, disc_value: 0,
    reorder_point: 0, category_id: null, unit: "Pcs", available, updated_at: updated,
  };
}

function loaders(fp: string | null, rows: WireRow[]) {
  const l = {
    fpCalls: 0,
    rowCalls: 0,
    fp,
    rows_: rows,
    fingerprint: async () => { l.fpCalls++; return l.fp; },
    rows: async () => { l.rowCalls++; return l.rows_; },
  };
  return l satisfies Loaders & Record<string, unknown>;
}

beforeEach(() => reset());

describe("inside the TTL nothing is asked of Supabase", () => {
  it("serves the held payload without even the fingerprint probe", async () => {
    const l = loaders("1:aaa", [row("a")]);
    const t = 1_000_000;
    await load(l, t);
    expect(l.fpCalls).toBe(1);
    expect(l.rowCalls).toBe(1);

    // Four more tills poll within the window.
    for (const dt of [1, 100, 2_000, TTL_MS - 1]) await load(l, t + dt);

    expect(l.fpCalls, "one probe for the whole window").toBe(1);
    expect(l.rowCalls, "one full read for the whole window").toBe(1);
  });
});

describe("past the TTL an unchanged catalogue costs one fingerprint", () => {
  it("re-probes but does not re-read the rows", async () => {
    const l = loaders("1:aaa", [row("a")]);
    await load(l, 1_000_000);
    const held = await load(l, 1_000_000 + TTL_MS + 1);

    expect(l.fpCalls).toBe(2);
    expect(l.rowCalls, "the 1.22 MB read is what must NOT happen").toBe(1);
    expect(held.rows).toHaveLength(1);
  });

  it("re-reads only when the fingerprint moves", async () => {
    const l = loaders("1:aaa", [row("a")]);
    await load(l, 1_000_000);

    l.fp = "2:bbb";
    l.rows_ = [row("a"), row("b")];
    const held = await load(l, 1_000_000 + TTL_MS + 1);

    expect(l.rowCalls).toBe(2);
    expect(held.rows).toHaveLength(2);
    expect(held.fingerprint).toBe("2:bbb");
  });
});

describe("a stampede is collapsed into one refresh", () => {
  it("several tills arriving together share a single read", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const l = loaders("1:aaa", [row("a")]);
    const slow: Loaders = {
      fingerprint: async () => { await gate; return l.fingerprint(); },
      rows: () => l.rows(),
    };

    const all = Promise.all([load(slow, 1), load(slow, 1), load(slow, 1), load(slow, 1)]);
    release!();
    const results = await all;

    expect(l.fpCalls).toBe(1);
    expect(l.rowCalls).toBe(1);
    expect(new Set(results).size, "every caller gets the same held object").toBe(1);
  });
});

describe("the fallback when migration 0032 is not applied yet", () => {
  it("hashes the rows it read, so the ETag still works", async () => {
    const rows = [row("a"), row("b")];
    const l = loaders(null, rows);
    const held = await load(l, 1_000_000);

    expect(held.fingerprint).toBe(weakHash(rows));
    expect(held.fingerprint).toMatch(/^2:[0-9a-f]+$/);
  });

  it("without a probe it must re-read past the TTL — correctness over thrift", async () => {
    const l = loaders(null, [row("a")]);
    await load(l, 1_000_000);
    await load(l, 1_000_000 + TTL_MS + 1);
    expect(l.rowCalls).toBe(2);
  });
});

describe("weakHash tracks exactly what migration 0032 hashes", () => {
  it("moves when stock moves, even though updated_at did not", () => {
    // The bug this guards: `available` comes from variant_availability, so a
    // sale changes it without touching updated_at. A fingerprint blind to it
    // would let a till keep selling stock that is already gone.
    expect(weakHash([row("a", "2026-08-01T00:00:00Z", 5)]))
      .not.toBe(weakHash([row("a", "2026-08-01T00:00:00Z", 4)]));
  });

  it("moves when a row is edited, and when one is added or removed", () => {
    const base = [row("a")];
    expect(weakHash(base)).not.toBe(weakHash([row("a", "2026-08-26T09:00:00Z")]));
    expect(weakHash(base)).not.toBe(weakHash([row("a"), row("b")]));
    expect(weakHash(base)).not.toBe(weakHash([]));
  });

  it("is stable for identical input", () => {
    expect(weakHash([row("a"), row("b")])).toBe(weakHash([row("a"), row("b")]));
  });
});
