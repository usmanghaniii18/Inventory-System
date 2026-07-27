import { describe, it, expect } from "vitest";
import { resolveRange } from "@hamza/shared/dates";
import { formatNumber, formatPKR } from "@hamza/shared/utils";
import { buildReport } from "./queries";

const ZERO_NUM = formatNumber(0);
const ZERO_PKR = formatPKR(0, { compact: true });

// A fully-returned sale: one variant sold qty 2 for Rs 200, then all 2 returned
// (refund Rs 200). Every reports tab must net this to ~0 — matching the Sales tab.
const NOW = new Date().toISOString();
const TABLES: Record<string, unknown[]> = {
  sales: [{ id: "s1", total: 200, subtotal: 200, discount: 0, tax: 0, cogs_total: 120, profit: 80, created_at: NOW, cashier_id: "cash1", customer_id: "cust1" }],
  sale_items: [{ sale_id: "s1", variant_id: "v1", product_id: "p1", qty: 2, unit_price: 100, unit_cogs: 60, line_total: 200 }],
  sale_returns: [{ id: "r1", created_at: NOW, sales: { customer_id: "cust1", cashier_id: "cash1" } }],
  sale_return_items: [{ return_id: "r1", variant_id: "v1", qty: 2, line_total: 200, unit_cogs: 60 }],
  product_variants: [{ id: "v1", product_id: "p1", sku: "SKU1", cost: 60, sale_price: 100, is_default: true, active: true }],
  products: [{ id: "p1", name: "Test Item", brand: null, category_id: "cat1", has_variants: false, active: true }],
  product_barcodes: [],
  product_option_values: [],
  variant_option_values: [],
  variant_availability: [{ variant_id: "v1", on_hand: 5 }],
  customers: [{ id: "cust1", name: "Ali", credit_balance: 0 }],
  customer_ledger: [],
};

// Minimal chainable, thenable query builder that ignores filters and resolves to
// the canned rows for its table — enough to exercise the netting logic offline.
function makeClient(tables: Record<string, unknown[]>) {
  const builder = (rows: unknown[]) => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ["select", "eq", "gte", "lte", "in", "order", "not", "range"]) b[m] = chain;
    b.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
    b.single = () => Promise.resolve({ data: rows[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, count: rows.length, error: null });
    return b;
  };
  return { from: (table: string) => builder(tables[table] ?? []) } as never;
}

const range = resolveRange("this_year", "", "");

// A single-line sale where a bill-level discount brings a Rs 2000 list price
// down to Rs 1400 actually paid (cost Rs 1000). `sale_items.line_total` is
// still 2000 (no LINE discount was given — the discount was applied at the
// bill level), so any report reading it directly would overstate revenue at
// list price and show profit 1000 / margin 50% instead of the correct
// profit 400 / margin ~28.6% on the Rs 1400 actually paid.
const DISCOUNTED_TABLES: Record<string, unknown[]> = {
  sales: [{ id: "s2", total: 1400, subtotal: 2000, discount: 600, tax: 0, cogs_total: 1000, profit: 400, created_at: NOW, cashier_id: "cash1", customer_id: null }],
  sale_items: [{ sale_id: "s2", variant_id: "v1", product_id: "p1", qty: 1, unit_price: 2000, unit_cogs: 1000, line_total: 2000 }],
  sale_returns: [],
  sale_return_items: [],
  product_variants: [{ id: "v1", product_id: "p1", sku: "SKU1", cost: 1000, sale_price: 2000, is_default: true, active: true }],
  products: [{ id: "p1", name: "Test Item", brand: null, category_id: "cat1", has_variants: false, active: true }],
  product_barcodes: [],
  product_option_values: [],
  variant_option_values: [],
  variant_availability: [{ variant_id: "v1", on_hand: 5 }],
  customers: [],
  customer_ledger: [],
};

// Same single sale, no return, and no bill-level discount — the pre-existing
// happy path that must keep working unchanged.
const NO_DISCOUNT_TABLES: Record<string, unknown[]> = {
  ...TABLES,
  sales: [{ id: "s1", total: 200, subtotal: 200, discount: 0, tax: 0, cogs_total: 120, profit: 80, created_at: NOW, cashier_id: "cash1", customer_id: "cust1" }],
  sale_returns: [],
  sale_return_items: [],
};

const VARIANT_NAME = "Test Item · Default"; // is_default true, no option links -> label "Default"

describe("profit/margin use the net amount actually paid, not the list price", () => {
  it("Profit & Margin tab: bill-level discount nets to actual paid, not list price", async () => {
    const r = await buildReport(makeClient(DISCOUNTED_TABLES), "profit", range, new URLSearchParams());
    const kpi = (label: string) => r.kpis.find((k) => k.label === label)?.value;
    expect(kpi("Revenue")).toBe(formatPKR(1400, { compact: true }));
    expect(kpi("Gross Profit")).toBe(formatPKR(400, { compact: true }));
    expect(kpi("Margin")).toBe("28.6%");
    // per-product row must reconcile to the same net-paid basis, not list price
    const row = r.rows.find((row) => row.name === VARIANT_NAME);
    expect(Math.round(Number(row?.revenue))).toBe(1400);
    expect(Math.round(Number(row?.profit))).toBe(400);
    expect(Number(row?.margin)).toBeCloseTo(28.6, 1);
  });

  it("Product Performance: per-variant revenue/profit use net-paid, not list price", async () => {
    const r = await buildReport(makeClient(DISCOUNTED_TABLES), "products", range, new URLSearchParams());
    const row = r.rows.find((row) => row.name === VARIANT_NAME);
    expect(Math.round(Number(row?.revenue))).toBe(1400);
    expect(Math.round(Number(row?.profit))).toBe(400);
  });

  it("Sales report by-product view: revenue/profit use net-paid, not list price", async () => {
    const r = await buildReport(makeClient(DISCOUNTED_TABLES), "sales", range, new URLSearchParams({ view: "product" }));
    const row = r.rows.find((row) => row.name === VARIANT_NAME);
    expect(Math.round(Number(row?.revenue))).toBe(1400);
    expect(Math.round(Number(row?.profit))).toBe(400);
  });

  it("Full System: category mix uses net-paid, not list price", async () => {
    const r = await buildReport(makeClient(DISCOUNTED_TABLES), "system", range, new URLSearchParams());
    const donut = r.charts.find((c) => c.title === "Sales by category");
    const total = donut?.data.reduce((s, d) => s + Number(d.value), 0) ?? 0;
    expect(total).toBe(1400);
  });

  it("no-discount sale still computes correctly (regression guard)", async () => {
    const r = await buildReport(makeClient(NO_DISCOUNT_TABLES), "profit", range, new URLSearchParams());
    const kpi = (label: string) => r.kpis.find((k) => k.label === label)?.value;
    expect(kpi("Revenue")).toBe(formatPKR(200, { compact: true }));
    expect(kpi("Gross Profit")).toBe(formatPKR(80, { compact: true }));
    const row = r.rows.find((row) => row.name === VARIANT_NAME);
    expect(Math.round(Number(row?.revenue))).toBe(200);
    expect(Math.round(Number(row?.profit))).toBe(80);
  });
});

describe("Net/Gross toggle", () => {
  it("Net (default, no mode param) is unaffected — same as today", async () => {
    const r = await buildReport(makeClient(DISCOUNTED_TABLES), "profit", range, new URLSearchParams());
    expect(r.kpis.find((k) => k.label === "Revenue")?.value).toBe(formatPKR(1400, { compact: true }));
  });

  it("Profit & Margin: Gross revenue is list price (pre-discount), not net-paid", async () => {
    const r = await buildReport(makeClient(DISCOUNTED_TABLES), "profit", range, new URLSearchParams({ mode: "gross" }));
    const kpi = (label: string) => r.kpis.find((k) => k.label === label)?.value;
    expect(kpi("Revenue (Gross)")).toBe(formatPKR(2000, { compact: true }));
    // Gross COGS is the same cogs_total (discount doesn't touch cost) — never a
    // Net-revenue-with-Gross-cogs (or vice versa) mismatch.
    expect(kpi("COGS")).toBe(formatPKR(1000, { compact: true }));
    expect(kpi("Gross Profit")).toBe(formatPKR(1000, { compact: true }));
    expect(kpi("Margin")).toBe("50.0%");
    const row = r.rows.find((row) => row.name === VARIANT_NAME);
    expect(Math.round(Number(row?.revenue))).toBe(2000);
    expect(Math.round(Number(row?.profit))).toBe(1000);
  });

  it("Product Performance: Gross revenue/profit use list price", async () => {
    const r = await buildReport(makeClient(DISCOUNTED_TABLES), "products", range, new URLSearchParams({ mode: "gross" }));
    const row = r.rows.find((row) => row.name === VARIANT_NAME);
    expect(Math.round(Number(row?.revenue))).toBe(2000);
    expect(Math.round(Number(row?.profit))).toBe(1000);
  });

  it("Sales report: Gross headline uses list price, unaffected by the bill discount", async () => {
    const r = await buildReport(makeClient(DISCOUNTED_TABLES), "sales", range, new URLSearchParams({ mode: "gross" }));
    expect(r.kpis.find((k) => k.label === "Total Sales (Gross)")?.value).toBe(formatPKR(2000, { compact: true }));
  });

  it("Full System: Gross category mix uses list price", async () => {
    const r = await buildReport(makeClient(DISCOUNTED_TABLES), "system", range, new URLSearchParams({ mode: "gross" }));
    const donut = r.charts.find((c) => c.title === "Sales by category");
    const total = donut?.data.reduce((s, d) => s + Number(d.value), 0) ?? 0;
    expect(total).toBe(2000);
  });

  it("Gross mode does NOT net out returns — a fully-returned sale still counts", async () => {
    // TABLES: qty 2 @ Rs100 sold, then fully returned. Net mode nets this to 0
    // (already covered below); Gross must keep showing the un-netted Rs 200.
    const r = await buildReport(makeClient(TABLES), "profit", range, new URLSearchParams({ mode: "gross" }));
    expect(r.kpis.find((k) => k.label === "Revenue (Gross)")?.value).toBe(formatPKR(200, { compact: true }));
  });
});

describe("reports net returns consistently", () => {
  it("Product Performance nets returned units/revenue to zero (Dead stock untouched)", async () => {
    const r = await buildReport(makeClient(TABLES), "products", range, new URLSearchParams());
    const kpi = (label: string) => r.kpis.find((k) => k.label === label)?.value;
    expect(kpi("Units sold")).toBe(ZERO_NUM);      // 2 sold − 2 returned
    expect(kpi("Variants sold")).toBe(ZERO_NUM);   // net qty 0 → not a net seller
    expect(kpi("Revenue")).toBe(ZERO_PKR);         // 200 − 200
    expect(kpi("Dead stock")).toBe(ZERO_NUM);      // it DID sell gross, so not dead
  });

  it("Customers & Udhaar nets the period sales to zero", async () => {
    const r = await buildReport(makeClient(TABLES), "customers", range, new URLSearchParams());
    expect(r.kpis.find((k) => k.label === "Sales (period)")?.value).toBe(ZERO_PKR);
    const ali = r.rows.find((row) => row.name === "Ali");
    expect(Math.abs(Number(ali?.sales))).toBe(0); // 200 sold − 200 returned
  });
});
