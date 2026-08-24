import type { createClient } from "@hamza/shared/supabase/server";
import type { Accent } from "@hamza/shared/ui/accent";
import type { DimensionFilter } from "@hamza/shared/ui/FilterBar";
import { getVariantOptions, getVariantNames } from "@/lib/catalog";
import { fetchAll, selectAll, fetchAllByIds } from "@/lib/fetch-all";
import { expandCategorySelection } from "@/lib/categories";
import { formatPKR, formatNumber } from "@hamza/shared/utils";
import { bucketKey, bucketOf, formatKarachiDateTime, type DateRange } from "@hamza/shared/dates";
import { netLineRevenue } from "@hamza/shared/pricing";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type ColKind = "text" | "pkr" | "num" | "pct" | "pill";
export interface ReportColumn { key: string; header: string; align?: "left" | "right"; kind?: ColKind }
export interface ReportChart {
  type: "area" | "bar" | "donut";
  title?: string;
  data: Record<string, unknown>[];
  dataKey?: string;
  xKey?: string;
  accent?: Accent;
  centerLabel?: string;
  centerValue?: string;
}
export interface CategoryFilterOption { id: string; name: string; parent_id: string | null }
export interface ReportData {
  key: string;
  title: string;
  subtitle?: string;
  kpis: { label: string; value: string; accent: Accent; sensitive?: boolean; fullValue?: string }[];
  charts: ReportChart[];
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  dimensions: DimensionFilter[];
  /**
   * Multi-select category (main + sub, rollup) filter. Rendered by ReportsClient
   * whenever a report supplies it: Inventory Valuation, Profit & Margin and
   * Stock Additions (Phase I).
   */
  categoryFilter?: { options: CategoryFilterOption[] };
}

export const REPORTS: { key: string; label: string }[] = [
  { key: "sales", label: "Sales" },
  { key: "profit", label: "Profit & Margin" },
  { key: "inventory", label: "Inventory Valuation" },
  { key: "stockin", label: "Stock Additions" },
  { key: "products", label: "Product Performance" },
  { key: "purchases", label: "Purchases & Suppliers" },
  { key: "customers", label: "Customers & Udhaar" },
  { key: "users", label: "Staff Activity" },
  { key: "system", label: "Full System" },
];

const iso = (d: Date) => d.toISOString();

/** Build a trend series (label + value) bucketed across the range. */
function trend(range: DateRange, rows: { created_at: string; value: number }[], accent: Accent, dataKey = "value"): ReportChart {
  const b = bucketOf(range);
  const map = new Map<string, number>();
  for (const r of rows) {
    const k = bucketKey(new Date(r.created_at), b);
    map.set(k, (map.get(k) ?? 0) + r.value);
  }
  return { type: "area", data: [...map.entries()].map(([label, v]) => ({ label, [dataKey]: Math.round(v) })), dataKey, accent };
}

export async function buildReport(supabase: Supabase, key: string, range: DateRange, params: URLSearchParams): Promise<ReportData> {
  switch (key) {
    case "profit": return profitReport(supabase, range, params);
    case "inventory": return inventoryReport(supabase, range, params);
    case "stockin": return stockInReport(supabase, range, params);
    case "products": return productsReport(supabase, range, params);
    case "purchases": return purchasesReport(supabase, range);
    case "customers": return customersReport(supabase, range);
    case "users": return usersReport(supabase, range);
    case "system": return systemReport(supabase, range, params);
    case "sales":
    default: return salesReport(supabase, range, params);
  }
}

/* ---------------- shared fetch ---------------- */
/** "net" (default) nets out bill-level discounts and returns — the actual money
 * collected. "gross" is list-price revenue: no discount and no return netting. */
export type ReportMode = "net" | "gross";
export function parseMode(params: URLSearchParams): ReportMode {
  return params.get("mode") === "gross" ? "gross" : "net";
}

// Both queries are paginated (fetchAll) so no range is silently capped at
// PostgREST's 1000-row default. sale_items is filtered directly on the parent
// sale's date via the FK embed (`sales!inner`) rather than an `.in("sale_id",
// ids)` list — with a few hundred+ sales that id list builds a URL/header long
// enough to blow past PostgREST's/the proxy's size limit and fail outright,
// which is why wide custom ranges previously showed no data at all.
async function fetchSales(supabase: Supabase, range: DateRange) {
  const sales = await fetchAll<{
    id: string; total: number; subtotal: number; discount: number; tax: number; cogs_total: number;
    profit: number; created_at: string; cashier_id: string | null; customer_id: string | null;
  }>((from, to) => supabase
    .from("sales")
    .select("id, total, subtotal, discount, tax, cogs_total, profit, created_at, cashier_id, customer_id")
    .gte("created_at", iso(range.from)).lte("created_at", iso(range.to))
    .order("id").range(from, to));

  const items = await fetchAll<Record<string, unknown>>((from, to) => supabase
    .from("sale_items")
    .select("sale_id, variant_id, product_id, qty, unit_price, unit_cogs, line_total, sales!inner(created_at)")
    .gte("sales.created_at", iso(range.from)).lte("sales.created_at", iso(range.to))
    .order("id").range(from, to));

  // `line_total` is net of only the LINE's own discount — it's stored before the
  // bill-level/promo discount is applied. Spread that bill-level discount (and
  // tax) back across the sale's lines proportionally, same basis as the
  // returns/refund path (netUnitPaid), so every per-product/category/variant
  // revenue and profit figure reconciles to the (already-correct) sale-header
  // `total`/`profit` instead of overstating on the pre-discount line amount.
  // `gross_line_total` is the undiscounted list-price amount (qty × unit_price)
  // for the Gross view — no discount spread needed since nothing is subtracted.
  const saleTotalOf = new Map(sales.map((s) => [s.id, Number(s.total)]));
  const sumLineTotalsOf = new Map<string, number>();
  for (const it of items) {
    const sid = it.sale_id as string;
    sumLineTotalsOf.set(sid, (sumLineTotalsOf.get(sid) ?? 0) + Number(it.line_total));
  }
  for (const it of items) {
    const sid = it.sale_id as string;
    it.net_line_total = netLineRevenue(Number(it.line_total), sumLineTotalsOf.get(sid) ?? 0, saleTotalOf.get(sid) ?? 0);
    it.gross_line_total = Number(it.qty) * Number(it.unit_price);
  }

  return { sales, items };
}

/** Revenue for one in-store sale under the given basis. */
function saleRevenue(s: { total: number; subtotal: number }, mode: ReportMode): number {
  return mode === "gross" ? Number(s.subtotal) : Number(s.total);
}
/** Profit for one in-store sale under the given basis — mirrors the stored
 * `profit` column's shape (revenue − tax − cogs) so Net/Gross only differ by
 * which revenue basis feeds in, never by a different formula. */
function saleProfit(s: { subtotal: number; tax: number; cogs_total: number; profit: number }, mode: ReportMode): number {
  return mode === "gross" ? Number(s.subtotal) - Number(s.tax) - Number(s.cogs_total) : Number(s.profit);
}
/** Revenue/profit for one line item under the given basis. */
function lineRevenue(it: Record<string, unknown>, mode: ReportMode): number {
  return mode === "gross" ? Number(it.gross_line_total) : Number(it.net_line_total);
}
function lineProfit(it: Record<string, unknown>, mode: ReportMode): number {
  return lineRevenue(it, mode) - Number(it.qty) * Number(it.unit_cogs);
}

/**
 * Counter returns in the range, aggregated so reports can be shown NET of returns
 * (a return is not a sale). Recognised by the return's own date. Revenue impact =
 * the refunded line totals; profit impact = revenue minus the original COGS that
 * came back into stock.
 */
interface ReturnsAgg {
  totalRevenue: number;
  totalCogs: number;
  totalProfit: number;
  byDate: { created_at: string; revenue: number; profit: number }[];
  byVariant: Map<string, { qty: number; revenue: number; cogs: number; profit: number }>;
  // Returns attributed to the ORIGINAL sale's customer / cashier, so the customer
  // and staff reports can net refunds exactly like the Sales tab nets its headline.
  byCustomer: Map<string, { revenue: number; profit: number }>;
  byCashier: Map<string, { revenue: number; profit: number }>;
}
async function fetchReturns(supabase: Supabase, range: DateRange): Promise<ReturnsAgg> {
  const returns = await fetchAll<{
    id: string; created_at: string;
    sales: { customer_id: string | null; cashier_id: string | null } | { customer_id: string | null; cashier_id: string | null }[] | null;
  }>((from, to) => supabase
    .from("sale_returns").select("id, created_at, sales(customer_id, cashier_id)")
    .gte("created_at", iso(range.from)).lte("created_at", iso(range.to))
    .order("id").range(from, to));
  // Filtered directly on the parent return's date via the FK embed — same reason
  // as fetchSales/sale_items above, avoids an `.in("return_id", ids)` list that
  // can blow past PostgREST's URL/header limit once returns run into the hundreds.
  const items = await fetchAll<{
    return_id: string; variant_id: string | null; qty: number; line_total: number; unit_cogs: number;
  }>((from, to) => supabase
    .from("sale_return_items")
    .select("return_id, variant_id, qty, line_total, unit_cogs, sale_returns!inner(created_at)")
    .gte("sale_returns.created_at", iso(range.from)).lte("sale_returns.created_at", iso(range.to))
    .order("id").range(from, to));
  const dateOf = new Map(returns.map((r) => [r.id, r.created_at]));
  // each return -> the customer / cashier of the sale it reverses (embedded join)
  const custOf = new Map<string, string | null>();
  const cashOf = new Map<string, string | null>();
  for (const r of returns) {
    const rel = r.sales;
    const s = Array.isArray(rel) ? rel[0] : rel;
    custOf.set(r.id, s?.customer_id ?? null);
    cashOf.set(r.id, s?.cashier_id ?? null);
  }
  const byVariant = new Map<string, { qty: number; revenue: number; cogs: number; profit: number }>();
  const perReturn = new Map<string, { created_at: string; revenue: number; profit: number }>();
  const byCustomer = new Map<string, { revenue: number; profit: number }>();
  const byCashier = new Map<string, { revenue: number; profit: number }>();
  let totalRevenue = 0, totalCogs = 0;
  for (const it of items) {
    const rev = Number(it.line_total); const cogs = Number(it.qty) * Number(it.unit_cogs); const prof = rev - cogs;
    totalRevenue += rev; totalCogs += cogs;
    const vid = it.variant_id as string | null;
    if (vid) {
      const cur = byVariant.get(vid) ?? { qty: 0, revenue: 0, cogs: 0, profit: 0 };
      cur.qty += Number(it.qty); cur.revenue += rev; cur.cogs += cogs; cur.profit += prof;
      byVariant.set(vid, cur);
    }
    const rid = it.return_id as string;
    const pr = perReturn.get(rid) ?? { created_at: dateOf.get(rid) ?? iso(range.from), revenue: 0, profit: 0 };
    pr.revenue += rev; pr.profit += prof; perReturn.set(rid, pr);
    const cid = custOf.get(rid);
    if (cid) { const cur = byCustomer.get(cid) ?? { revenue: 0, profit: 0 }; cur.revenue += rev; cur.profit += prof; byCustomer.set(cid, cur); }
    const kid = cashOf.get(rid);
    if (kid) { const cur = byCashier.get(kid) ?? { revenue: 0, profit: 0 }; cur.revenue += rev; cur.profit += prof; byCashier.set(kid, cur); }
  }
  return { totalRevenue, totalCogs, totalProfit: totalRevenue - totalCogs, byDate: [...perReturn.values()], byVariant, byCustomer, byCashier };
}

/**
 * Fulfilled web orders (shipped onward) as sale-like rows. Revenue = order total;
 * COGS comes from the ledger moves posted when the order shipped, so profit lines
 * up with the inventory cost. Recognised by order created_at (placement).
 */
interface WebTxn { id: string; total: number; subtotal: number; profit: number; grossProfit: number; cogs: number; created_at: string }
async function fetchWebOrders(supabase: Supabase, range: DateRange): Promise<WebTxn[]> {
  const orders = await fetchAll<{ id: string; total: number; subtotal: number; created_at: string }>((from, to) => supabase
    .from("orders")
    .select("id, total, subtotal, created_at")
    .in("status", ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"])
    .gte("created_at", iso(range.from)).lte("created_at", iso(range.to))
    .order("id").range(from, to));
  const ids = orders.map((o) => o.id);
  // stock_moves.reference_id is a polymorphic pointer (no FK — it's reused for
  // PURCHASE/ADJUSTMENT/etc reference types too), so it can't be embed-filtered
  // like sale_items/sale_return_items above. Chunk the id list instead so the
  // `.in()` URL never grows past PostgREST's header-size limit.
  const moves = ids.length
    ? await fetchAllByIds<{ reference_id: string; qty: number; unit_cost: number | null }>(
        ids,
        (chunk, from, to) => supabase.from("stock_moves")
          .select("reference_id, qty, unit_cost")
          .eq("reference_type", "SALE").in("reference_id", chunk)
          .order("id").range(from, to),
      )
    : [];
  const cogs = new Map<string, number>();
  for (const m of moves) cogs.set(m.reference_id, (cogs.get(m.reference_id) ?? 0) + Number(m.qty) * Number(m.unit_cost ?? 0));
  return orders.map((o) => {
    const c = cogs.get(o.id) ?? 0;
    return { id: o.id, total: Number(o.total), subtotal: Number(o.subtotal), cogs: c, profit: Number(o.total) - c, grossProfit: Number(o.subtotal) - c, created_at: o.created_at };
  });
}
/** Revenue for one fulfilled web order under the given basis. */
function webRevenue(w: WebTxn, mode: ReportMode): number {
  return mode === "gross" ? w.subtotal : w.total;
}
function webProfit(w: WebTxn, mode: ReportMode): number {
  return mode === "gross" ? w.grossProfit : w.profit;
}

/* ---------------- 1. Sales ---------------- */
async function salesReport(supabase: Supabase, range: DateRange, params: URLSearchParams): Promise<ReportData> {
  const groupBy = params.get("view") ?? "day";
  const mode = parseMode(params);
  const { sales, items } = await fetchSales(supabase, range);
  const web = await fetchWebOrders(supabase, range);
  const returns = await fetchReturns(supabase, range);
  const variants = await getVariantOptions(supabase);
  const vMap = new Map(variants.map((v) => [v.variant_id, v]));
  const catName = await categoryNames(supabase);

  // headline numbers span both channels (in-store POS + fulfilled web orders).
  // Net nets out counter returns (a return is not a sale) and bill-level
  // discount; Gross is list-price revenue with neither subtracted.
  const retRevenue = mode === "net" ? returns.totalRevenue : 0;
  const retProfit = mode === "net" ? returns.totalProfit : 0;
  const totalSales = sales.reduce((s, x) => s + saleRevenue(x, mode), 0) + web.reduce((s, x) => s + webRevenue(x, mode), 0) - retRevenue;
  const totalProfit = sales.reduce((s, x) => s + saleProfit(x, mode), 0) + web.reduce((s, x) => s + webProfit(x, mode), 0) - retProfit;
  const count = sales.length + web.length;

  const chart = trend(range, [
    ...sales.map((s) => ({ created_at: s.created_at, value: saleRevenue(s, mode) })),
    ...web.map((w) => ({ created_at: w.created_at, value: webRevenue(w, mode) })),
    ...(mode === "net" ? returns.byDate.map((r) => ({ created_at: r.created_at, value: -r.revenue })) : []),
  ], "blue", "sales");

  let columns: ReportColumn[]; let rows: Record<string, unknown>[];
  if (groupBy === "product" || groupBy === "category") {
    const agg = new Map<string, { name: string; qty: number; revenue: number; profit: number }>();
    for (const it of items) {
      const v = vMap.get(it.variant_id as string);
      const k = groupBy === "category" ? (v?.category_id ?? "—") : (it.variant_id as string);
      const name = groupBy === "category" ? (v?.category_id ? (catName.get(v.category_id) ?? "—") : "Uncategorised") : (v ? `${v.product_name} · ${v.label}` : "—");
      const cur = agg.get(k) ?? { name, qty: 0, revenue: 0, profit: 0 };
      cur.qty += Number(it.qty); cur.revenue += lineRevenue(it, mode);
      cur.profit += lineProfit(it, mode);
      agg.set(k, cur);
    }
    // Net out returns per product/category (Net mode only).
    if (mode === "net") for (const [vid, rv] of returns.byVariant) {
      const v = vMap.get(vid);
      const k = groupBy === "category" ? (v?.category_id ?? "—") : vid;
      const cur = agg.get(k);
      if (cur) { cur.qty -= rv.qty; cur.revenue -= rv.revenue; cur.profit -= rv.profit; }
    }
    columns = [
      { key: "name", header: groupBy === "category" ? "Category" : "Product", kind: "text" },
      { key: "qty", header: "Units", align: "right", kind: "num" },
      { key: "revenue", header: "Revenue", align: "right", kind: "pkr" },
      { key: "profit", header: "Profit", align: "right", kind: "pkr" },
    ];
    rows = [...agg.values()].sort((a, b) => b.revenue - a.revenue);
  } else if (groupBy === "cashier") {
    const names = await profileNames(supabase);
    const agg = new Map<string, { name: string; orders: number; sales: number; profit: number }>();
    for (const s of sales) {
      const k = s.cashier_id ?? "—";
      const cur = agg.get(k) ?? { name: s.cashier_id ? (names.get(s.cashier_id) ?? "—") : "—", orders: 0, sales: 0, profit: 0 };
      cur.orders += 1; cur.sales += saleRevenue(s, mode); cur.profit += saleProfit(s, mode);
      agg.set(k, cur);
    }
    columns = [
      { key: "name", header: "Cashier", kind: "text" }, { key: "orders", header: "Orders", align: "right", kind: "num" },
      { key: "sales", header: "Sales", align: "right", kind: "pkr" }, { key: "profit", header: "Profit", align: "right", kind: "pkr" },
    ];
    rows = [...agg.values()].sort((a, b) => b.sales - a.sales);
  } else if (groupBy === "payment") {
    // Actual money collected — always the same figure regardless of Net/Gross
    // (there's no "list price" version of a payment already taken).
    // Filtered directly on the parent sale's date via the FK embed rather than an
    // `.in("sale_id", ids)` list — same URL/header-limit issue as fetchSales above.
    const pays = await fetchAll<{ method: string; amount: number }>((from, to) => supabase
      .from("payments")
      .select("method, amount, sales!inner(created_at)")
      .gte("sales.created_at", iso(range.from)).lte("sales.created_at", iso(range.to))
      .order("id").range(from, to));
    const agg = new Map<string, number>();
    for (const p of pays) agg.set(p.method, (agg.get(p.method) ?? 0) + Number(p.amount));
    columns = [{ key: "name", header: "Payment type", kind: "text" }, { key: "amount", header: "Amount", align: "right", kind: "pkr" }];
    rows = [...agg.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
  } else if (groupBy === "channel") {
    const pos = { name: "In-store (POS)", orders: sales.length, sales: sales.reduce((s, x) => s + saleRevenue(x, mode), 0) - retRevenue, profit: sales.reduce((s, x) => s + saleProfit(x, mode), 0) - retProfit };
    const online = { name: "Online (Web)", orders: web.length, sales: web.reduce((s, x) => s + webRevenue(x, mode), 0), profit: web.reduce((s, x) => s + webProfit(x, mode), 0) };
    columns = [
      { key: "name", header: "Channel", kind: "text" }, { key: "orders", header: "Orders", align: "right", kind: "num" },
      { key: "sales", header: "Sales", align: "right", kind: "pkr" }, { key: "profit", header: "Profit", align: "right", kind: "pkr" },
    ];
    rows = [pos, online];
  } else {
    const b = bucketOf(range);
    const agg = new Map<string, { label: string; orders: number; sales: number; profit: number }>();
    for (const s of sales) {
      const k = bucketKey(new Date(s.created_at), b);
      const cur = agg.get(k) ?? { label: k, orders: 0, sales: 0, profit: 0 };
      cur.orders += 1; cur.sales += saleRevenue(s, mode); cur.profit += saleProfit(s, mode);
      agg.set(k, cur);
    }
    for (const w of web) {
      const k = bucketKey(new Date(w.created_at), b);
      const cur = agg.get(k) ?? { label: k, orders: 0, sales: 0, profit: 0 };
      cur.orders += 1; cur.sales += webRevenue(w, mode); cur.profit += webProfit(w, mode);
      agg.set(k, cur);
    }
    // Net out returns per period (Net mode only; no order count — a return isn't a new order).
    if (mode === "net") for (const r of returns.byDate) {
      const k = bucketKey(new Date(r.created_at), b);
      const cur = agg.get(k) ?? { label: k, orders: 0, sales: 0, profit: 0 };
      cur.sales -= r.revenue; cur.profit -= r.profit;
      agg.set(k, cur);
    }
    columns = [
      { key: "label", header: "Period", kind: "text" }, { key: "orders", header: "Orders", align: "right", kind: "num" },
      { key: "sales", header: "Sales", align: "right", kind: "pkr" }, { key: "profit", header: "Profit", align: "right", kind: "pkr" },
    ];
    rows = [...agg.values()];
  }

  return {
    key: "sales", title: "Sales Report", subtitle: `${range.label} · ${mode === "gross" ? "Gross" : "Net"}`,
    kpis: [
      { label: mode === "gross" ? "Total Sales (Gross)" : "Total Sales", value: formatPKR(totalSales, { compact: true }), fullValue: formatPKR(totalSales), accent: "blue", sensitive: true },
      { label: "Profit", value: formatPKR(totalProfit, { compact: true }), fullValue: formatPKR(totalProfit), accent: "green", sensitive: true },
      { label: "Transactions", value: formatNumber(count), accent: "purple" },
      { label: "Avg Basket", value: formatPKR(count ? totalSales / count : 0), accent: "teal", sensitive: true },
    ],
    charts: [{ ...chart, title: "Sales trend" }],
    columns, rows,
    dimensions: [{ key: "view", label: "Group by: Day", options: [
      { value: "day", label: "By day" }, { value: "channel", label: "By channel" },
      { value: "product", label: "By product" }, { value: "category", label: "By category" },
      { value: "cashier", label: "By cashier" }, { value: "payment", label: "By payment type" },
    ] }],
  };
}

/* ---------------- 2. Profit & margin ---------------- */
async function profitReport(supabase: Supabase, range: DateRange, params: URLSearchParams): Promise<ReportData> {
  const mode = parseMode(params);
  const { sales, items } = await fetchSales(supabase, range);
  const web = await fetchWebOrders(supabase, range);
  const returns = await fetchReturns(supabase, range);
  const variants = await getVariantOptions(supabase);
  const vMap = new Map(variants.map((v) => [v.variant_id, v]));

  // Phase I — multi-select category filter (main category rolls up its subs).
  const { options: cats, scope: catScope } = await categoryScope(supabase, params);
  const inScope = (variantId: string | null | undefined) => {
    if (!catScope) return true;
    const v = variantId ? vMap.get(variantId) : undefined;
    return !!v?.category_id && catScope.has(v.category_id);
  };

  const scopedItems = catScope ? items.filter((it) => inScope(it.variant_id as string)) : items;
  const saleDateOf = new Map(sales.map((x) => [x.id, x.created_at]));

  // Net (default): refunds reduce revenue and COGS returns to stock, and revenue
  // is what was actually paid after the bill-level discount. Gross: list-price
  // revenue, COGS and revenue both left un-netted against returns.
  const retRevenue = mode === "net" ? returns.totalRevenue : 0;
  const retCogs = mode === "net" ? returns.totalCogs : 0;

  // With NO category filter the headline figures come from the sale headers,
  // exactly as before — that path is untouched. With a filter on, they have to
  // be rebuilt from the lines, because a sale header covers every category on
  // the bill and cannot be attributed to one.
  let revenue: number;
  let cogs: number;
  if (catScope) {
    let scopedRetRevenue = 0;
    let scopedRetCogs = 0;
    if (mode === "net") for (const [vid, rv] of returns.byVariant) {
      if (!inScope(vid)) continue;
      scopedRetRevenue += rv.revenue; scopedRetCogs += rv.cogs;
    }
    revenue = scopedItems.reduce((t, it) => t + lineRevenue(it, mode), 0) - scopedRetRevenue;
    cogs = scopedItems.reduce((t, it) => t + Number(it.qty) * Number(it.unit_cogs), 0) - scopedRetCogs;
  } else {
    revenue = sales.reduce((s, x) => s + saleRevenue(x, mode), 0) + web.reduce((s, x) => s + webRevenue(x, mode), 0) - retRevenue;
    cogs = sales.reduce((s, x) => s + Number(x.cogs_total), 0) + web.reduce((s, x) => s + x.cogs, 0) - retCogs;
  }
  const profit = revenue - cogs;
  const margin = revenue ? (profit / revenue) * 100 : 0;

  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const agg = new Map<string, { name: string; category: string; revenue: number; cogs: number; profit: number; margin: number }>();
  for (const it of scopedItems) {
    const v = vMap.get(it.variant_id as string);
    const k = it.variant_id as string;
    const rev = lineRevenue(it, mode); const c = Number(it.qty) * Number(it.unit_cogs);
    const cur = agg.get(k) ?? {
      name: v ? `${v.product_name} · ${v.label}` : "—",
      category: v?.category_id ? (catName.get(v.category_id) ?? "—") : "Uncategorised",
      revenue: 0, cogs: 0, profit: 0, margin: 0,
    };
    cur.revenue += rev; cur.cogs += c; cur.profit += rev - c;
    agg.set(k, cur);
  }
  if (mode === "net") for (const [vid, rv] of returns.byVariant) {
    const cur = agg.get(vid);
    if (cur) { cur.revenue -= rv.revenue; cur.cogs -= rv.cogs; cur.profit -= rv.profit; }
  }
  const rows = [...agg.values()].map((r) => ({ ...r, margin: r.revenue ? (r.profit / r.revenue) * 100 : 0 })).sort((a, b) => b.profit - a.profit);

  return {
    key: "profit", title: "Profit & Margin", subtitle: `${range.label} · ${mode === "gross" ? "Gross" : "Net"}`,
    kpis: [
      { label: mode === "gross" ? "Revenue (Gross)" : "Revenue", value: formatPKR(revenue, { compact: true }), fullValue: formatPKR(revenue), accent: "blue", sensitive: true },
      { label: "COGS", value: formatPKR(cogs, { compact: true }), fullValue: formatPKR(cogs), accent: "amber", sensitive: true },
      { label: "Gross Profit", value: formatPKR(profit, { compact: true }), fullValue: formatPKR(profit), accent: "green", sensitive: true },
      { label: "Margin", value: `${margin.toFixed(1)}%`, accent: "teal", sensitive: true },
    ],
    charts: [{ ...trend(range, catScope
      // Filtered: the trend has to come from the lines too, for the same reason
      // the KPIs do — a sale header spans every category on the bill. Dates come
      // from the already-fetched sale headers, not the PostgREST embed shape.
      ? scopedItems.map((it) => ({ created_at: saleDateOf.get(it.sale_id as string) ?? iso(range.from), value: lineProfit(it, mode) }))
      : [
        ...sales.map((s) => ({ created_at: s.created_at, value: saleProfit(s, mode) })),
        ...web.map((w) => ({ created_at: w.created_at, value: webProfit(w, mode) })),
        ...(mode === "net" ? returns.byDate.map((r) => ({ created_at: r.created_at, value: -r.profit })) : []),
      ], "green", "profit"), title: "Profit trend" }],
    columns: [
      { key: "name", header: "Product", kind: "text" }, { key: "category", header: "Category", kind: "text" },
      { key: "revenue", header: "Revenue", align: "right", kind: "pkr" },
      { key: "cogs", header: "COGS", align: "right", kind: "pkr" }, { key: "profit", header: "Profit", align: "right", kind: "pkr" },
      { key: "margin", header: "Margin", align: "right", kind: "pct" },
    ],
    rows, dimensions: [],
    categoryFilter: { options: cats },
  };
}

/**
 * PHASE I — shared multi-select category scope for a report.
 *
 * Reads the `categories` URL param (written by CategoryMultiSelect) and expands
 * a selected MAIN category to include its sub-categories, using the exact same
 * helper the Stock/Low-Stock filter uses, so a category means the same thing on
 * every screen. Returns null for "no filter", which every caller treats as the
 * unchanged all-categories behaviour.
 */
async function categoryScope(
  supabase: Supabase,
  params: URLSearchParams,
): Promise<{ options: CategoryFilterOption[]; scope: Set<string> | null }> {
  const options = await categoryList(supabase);
  const selected = (params.get("categories") ?? "").split(",").filter(Boolean);
  return { options, scope: selected.length ? expandCategorySelection(selected, options) : null };
}

/* ---------------- 3. Inventory valuation (point-in-time) ---------------- */
async function inventoryReport(supabase: Supabase, range: DateRange, params: URLSearchParams): Promise<ReportData> {
  const variants = await getVariantOptions(supabase);
  const vMap = new Map(variants.map((v) => [v.variant_id, v]));
  const { options: cats, scope: catScope } = await categoryScope(supabase, params);
  const catName = new Map(cats.map((c) => [c.id, c.name]));

  // reconstruct on-hand as of range.to from the ledger (physical legs only)
  const { data: physLocs } = await supabase.from("locations").select("id").eq("type", "PHYSICAL");
  const physIds = new Set((physLocs ?? []).map((l) => l.id));
  // Paged: the whole ledger up to range.to can exceed 1000 moves, and a truncated
  // read would understate reconstructed on-hand.
  const moves = await fetchAll<{ variant_id: string; qty: number; from_location_id: string | null; to_location_id: string | null; created_at: string }>(
    (from, to) => supabase
      .from("stock_moves")
      .select("variant_id, qty, from_location_id, to_location_id, created_at")
      .lte("created_at", iso(range.to))
      .order("id").range(from, to));
  const onHand = new Map<string, number>();
  for (const m of moves ?? []) {
    if (physIds.has(m.to_location_id)) onHand.set(m.variant_id, (onHand.get(m.variant_id) ?? 0) + Number(m.qty));
    if (physIds.has(m.from_location_id)) onHand.set(m.variant_id, (onHand.get(m.variant_id) ?? 0) - Number(m.qty));
  }

  const byCat = new Map<string, number>();
  let totalValue = 0; let totalUnits = 0; let outCount = 0;
  const rows: Record<string, unknown>[] = [];
  for (const [vid, qty] of onHand) {
    const v = vMap.get(vid);
    if (!v) continue;
    if (catScope && (!v.category_id || !catScope.has(v.category_id))) continue;
    const value = qty * v.cost;
    if (qty <= 0) outCount++;
    totalValue += value; totalUnits += qty;
    const cat = v.category_id ? (catName.get(v.category_id) ?? "—") : "Uncategorised";
    byCat.set(cat, (byCat.get(cat) ?? 0) + value);
    rows.push({ name: `${v.product_name} · ${v.label}`, category: cat, units: qty, cost: v.cost, value });
  }
  rows.sort((a, b) => (b.value as number) - (a.value as number));

  return {
    key: "inventory", title: "Inventory Valuation", subtitle: `as of ${range.label}`,
    kpis: [
      { label: "Stock Value", value: formatPKR(totalValue, { compact: true }), fullValue: formatPKR(totalValue), accent: "blue", sensitive: true },
      { label: "Total Units", value: formatNumber(totalUnits), accent: "teal" },
      { label: "Variants", value: formatNumber(rows.length), accent: "purple" },
      { label: "Out of stock", value: formatNumber(outCount), accent: "coral" },
    ],
    charts: [{
      type: "donut", title: "Value by category",
      data: [...byCat.entries()].map(([name, value]) => ({ name, value: Math.round(value) })),
      centerLabel: "Total", centerValue: formatPKR(totalValue, { compact: true }),
    }],
    columns: [
      { key: "name", header: "Variant", kind: "text" }, { key: "category", header: "Category", kind: "text" },
      { key: "units", header: "On hand", align: "right", kind: "num" }, { key: "cost", header: "Avg cost", align: "right", kind: "pkr" },
      { key: "value", header: "Value", align: "right", kind: "pkr" },
    ],
    rows: rows.slice(0, 100), dimensions: [],
    categoryFilter: { options: cats },
  };
}

/* ---------------- Stock Additions (date-filterable stock-in ledger) ---------------- */
// Every time stock was ADDED — receiving (PO / GRN), manual stock-in, or opening
// stock. These are exactly the ledger moves coming FROM a supplier location into
// a physical one. Filterable by date (FilterBar), product, category, supplier
// and user.
async function stockInReport(supabase: Supabase, range: DateRange, params: URLSearchParams): Promise<ReportData> {
  const fProduct = params.get("product") ?? "";
  const fSupplier = params.get("supplier") ?? "";
  const fUser = params.get("user") ?? "";
  // Phase I — multi-select categories (with main→sub rollup), replacing the old
  // single-value `category` dimension.
  const { options: catOptions, scope: catScope } = await categoryScope(supabase, params);

  // Supplier-type locations mark a stock addition (in-flow from outside).
  const { data: locs } = await supabase.from("locations").select("id, type");
  const supplierLocIds = (locs ?? []).filter((l) => l.type === "SUPPLIER").map((l) => l.id);

  // Paginated (not a plain .select()) — an unpaginated stock-moves read is
  // silently capped at 1000 rows by PostgREST, which would drop older stock
  // additions from a wide-range report on a store this size.
  const moves = await fetchAll<{
    id: string; variant_id: string; product_id: string; qty: number; unit_cost: number | null;
    created_at: string; created_by: string | null; reference_type: string; reference_id: string | null;
  }>((from, to) => {
    let q = supabase
      .from("stock_moves")
      .select("id, variant_id, product_id, qty, unit_cost, created_at, created_by, reference_type, reference_id")
      .in("from_location_id", supplierLocIds)
      .gte("created_at", iso(range.from)).lte("created_at", iso(range.to))
      .order("created_at", { ascending: false }).order("id").range(from, to);
    if (fProduct) q = q.eq("product_id", fProduct);
    if (fUser) q = q.eq("created_by", fUser);
    return q;
  });

  // supplier comes from the goods receipt the move references (when any).
  // Chunked + paginated (fetchAllByIds) rather than a single `.in()` — once
  // `moves` above is fully paginated, a wide range can reference hundreds of
  // distinct GRNs, which would blow past PostgREST's URL/header limit.
  const grnIds = [...new Set(moves.map((m) => m.reference_id).filter(Boolean))] as string[];
  const grns = grnIds.length
    ? await fetchAllByIds<{ id: string; supplier_id: string | null }>(grnIds, (chunk, from, to) => supabase
        .from("goods_receipts").select("id, supplier_id").in("id", chunk).order("id").range(from, to))
    : [];
  const grnSupplier = new Map(grns.map((g) => [g.id, g.supplier_id]));
  const { data: suppliers } = await supabase.from("suppliers").select("id, name");
  const supName = new Map((suppliers ?? []).map((s) => [s.id, s.name as string]));

  const variants = await getVariantOptions(supabase);
  // Names resolve from the FULL catalogue (incl. archived) so a historical
  // stock-addition row never renders blank after its product is archived.
  const nameMap = await getVariantNames(supabase);
  const profiles = await profileNames(supabase);

  type Add = Record<string, unknown> & { _cat: string | null; _sup: string; created_at: string; qty: number; value: number; product: string };
  let rows: Add[] = moves.map((m) => {
    const nm = nameMap.get(m.variant_id);
    const supplierId = m.reference_id ? (grnSupplier.get(m.reference_id) ?? null) : null;
    const supplier = supplierId ? (supName.get(supplierId) ?? "—") : (m.reference_type === "OPENING" ? "Opening stock" : "—");
    const qty = Number(m.qty);
    const cost = Number(m.unit_cost ?? 0);
    return {
      _cat: nm?.category_id ?? null,
      _sup: supplierId ?? "",
      created_at: m.created_at,
      datetime: formatKarachiDateTime(new Date(m.created_at)),
      product: nm ? `${nm.product_name} · ${nm.label}` : "—",
      qty, cost, value: qty * cost, supplier,
      user: m.created_by ? (profiles.get(m.created_by) ?? "—") : "—",
    };
  });
  if (catScope) rows = rows.filter((r) => !!r._cat && catScope.has(r._cat));
  if (fSupplier) rows = rows.filter((r) => r._sup === fSupplier);

  const totalQty = rows.reduce((s, r) => s + r.qty, 0);
  const totalValue = rows.reduce((s, r) => s + r.value, 0);

  // dimension option lists (distinct, from full data)
  const productOpts = [...new Map(variants.map((v) => [v.product_id, v.product_name])).entries()]
    .map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  const supplierOpts = (suppliers ?? []).map((s) => ({ value: s.id, label: s.name as string })).sort((a, b) => a.label.localeCompare(b.label));
  const userOpts = [...profiles.entries()].map(([value, label]) => ({ value, label: label as string })).sort((a, b) => a.label.localeCompare(b.label));

  return {
    key: "stockin", title: "Stock Additions", subtitle: range.label,
    kpis: [
      { label: "Additions", value: formatNumber(rows.length), accent: "blue" },
      { label: "Units added", value: formatNumber(totalQty), accent: "teal" },
      { label: "Cost value", value: formatPKR(totalValue, { compact: true }), fullValue: formatPKR(totalValue), accent: "amber", sensitive: true },
      { label: "Products", value: formatNumber(new Set(rows.map((r) => r.product)).size), accent: "purple" },
    ],
    charts: [{ ...trend(range, rows.map((r) => ({ created_at: r.created_at, value: r.qty })), "teal", "qty"), type: "bar", title: "Units added" }],
    columns: [
      { key: "datetime", header: "Date / time", kind: "text" },
      { key: "product", header: "Product", kind: "text" },
      { key: "qty", header: "Qty added", align: "right", kind: "num" },
      { key: "cost", header: "Unit cost", align: "right", kind: "pkr" },
      { key: "value", header: "Value", align: "right", kind: "pkr" },
      { key: "supplier", header: "Supplier", kind: "text" },
      { key: "user", header: "Added by", kind: "text" },
    ],
    rows,
    dimensions: [
      { key: "product", label: "All products", options: productOpts },
      { key: "supplier", label: "All suppliers", options: supplierOpts },
      { key: "user", label: "All users", options: userOpts },
    ],
    categoryFilter: { options: catOptions },
  };
}

/* ---------------- 4. Product performance ---------------- */
async function productsReport(supabase: Supabase, range: DateRange, params: URLSearchParams): Promise<ReportData> {
  const view = params.get("view") ?? "best";
  const mode = parseMode(params);
  const { items } = await fetchSales(supabase, range);
  const returns = await fetchReturns(supabase, range);
  const variants = await getVariantOptions(supabase);
  const { data: avail } = await selectAll<{ variant_id: string; on_hand: number }>((from, to) => supabase.from("variant_availability").select("variant_id, on_hand").order("variant_id").range(from, to));
  const availMap = new Map((avail ?? []).map((a) => [a.variant_id, Number(a.on_hand)]));

  // Units/revenue/profit ever sold per variant, on the Net/Gross basis per `mode`.
  // The qty here (unaffected by mode) is used for the Dead-stock classification
  // ("did this variant ever sell at all?").
  const everSold = new Map<string, { qty: number; revenue: number; profit: number }>();
  for (const it of items) {
    const k = it.variant_id as string;
    const cur = everSold.get(k) ?? { qty: 0, revenue: 0, profit: 0 };
    cur.qty += Number(it.qty); cur.revenue += lineRevenue(it, mode);
    cur.profit += lineProfit(it, mode);
    everSold.set(k, cur);
  }
  // Net of returns (Net mode only) — every reported figure (units/revenue/profit/
  // top-sellers) is net, so a fully returned item is not counted as a net sale.
  const sold = new Map<string, { qty: number; revenue: number; profit: number }>();
  for (const [k, g] of everSold) sold.set(k, { ...g });
  if (mode === "net") for (const [vid, rv] of returns.byVariant) {
    const cur = sold.get(vid) ?? { qty: 0, revenue: 0, profit: 0 };
    cur.qty -= rv.qty; cur.revenue -= rv.revenue; cur.profit -= rv.profit;
    sold.set(vid, cur);
  }

  let all = variants.map((v) => {
    const s = sold.get(v.variant_id) ?? { qty: 0, revenue: 0, profit: 0 };
    return { name: `${v.product_name} · ${v.label}`, sku: v.sku, qty: s.qty, revenue: s.revenue, profit: s.profit, on_hand: availMap.get(v.variant_id) ?? 0, grossQty: everSold.get(v.variant_id)?.qty ?? 0 };
  });

  // Dead = never sold (any basis) and still on hand — unaffected by returns netting.
  if (view === "dead") all = all.filter((r) => r.grossQty === 0 && r.on_hand > 0).sort((a, b) => b.on_hand - a.on_hand);
  else if (view === "slow") all = all.filter((r) => r.on_hand > 0).sort((a, b) => a.qty - b.qty);
  else all = all.filter((r) => r.qty > 0).sort((a, b) => b.revenue - a.revenue);

  const bestForChart = [...all].filter((r) => r.revenue > 0).slice(0, 10).map((r) => ({ label: r.name.split(" · ")[0].slice(0, 14), revenue: Math.round(r.revenue) }));

  return {
    key: "products", title: "Product Performance", subtitle: `${range.label} · ${mode === "gross" ? "Gross" : "Net"}`,
    kpis: [
      { label: "Variants sold", value: formatNumber([...sold.values()].filter((s) => s.qty > 0).length), accent: "blue" },
      { label: "Dead stock", value: formatNumber(variants.filter((v) => !(everSold.get(v.variant_id)?.qty) && (availMap.get(v.variant_id) ?? 0) > 0).length), accent: "coral" },
      { label: "Units sold", value: formatNumber([...sold.values()].reduce((s, x) => s + x.qty, 0)), accent: "teal" },
      { label: mode === "gross" ? "Revenue (Gross)" : "Revenue", value: formatPKR([...sold.values()].reduce((s, x) => s + x.revenue, 0), { compact: true }), fullValue: formatPKR([...sold.values()].reduce((s, x) => s + x.revenue, 0)), accent: "green", sensitive: true },
    ],
    charts: [{ type: "bar", title: "Top sellers by revenue", data: bestForChart, dataKey: "revenue", accent: "blue" }],
    columns: [
      { key: "name", header: "Variant", kind: "text" }, { key: "qty", header: "Sold", align: "right", kind: "num" },
      { key: "revenue", header: "Revenue", align: "right", kind: "pkr" }, { key: "profit", header: "Profit", align: "right", kind: "pkr" },
      { key: "on_hand", header: "On hand", align: "right", kind: "num" },
    ],
    rows: all.slice(0, 100),
    dimensions: [{ key: "view", label: "View: Best sellers", options: [
      { value: "best", label: "Best sellers" }, { value: "slow", label: "Slow movers" }, { value: "dead", label: "Dead stock" },
    ] }],
  };
}

/* ---------------- 5. Purchases & suppliers ---------------- */
async function purchasesReport(supabase: Supabase, range: DateRange): Promise<ReportData> {
  const receipts = await fetchAll<{ supplier_id: string | null; total: number; created_at: string }>((from, to) => supabase
    .from("goods_receipts").select("supplier_id, total, created_at")
    .gte("created_at", iso(range.from)).lte("created_at", iso(range.to))
    .order("id").range(from, to));
  const { data: suppliers } = await supabase.from("suppliers").select("id, name, balance");
  const supName = new Map((suppliers ?? []).map((s) => [s.id, s.name]));

  const spendBy = new Map<string, number>();
  let totalSpend = 0;
  for (const r of receipts) {
    totalSpend += Number(r.total);
    const k = r.supplier_id ?? "—";
    spendBy.set(k, (spendBy.get(k) ?? 0) + Number(r.total));
  }
  const totalPayable = (suppliers ?? []).reduce((s, x) => s + Math.max(Number(x.balance), 0), 0);

  const rows = (suppliers ?? []).map((s) => ({
    name: s.name, spend: spendBy.get(s.id) ?? 0, payable: Number(s.balance),
  })).sort((a, b) => b.spend - a.spend);

  return {
    key: "purchases", title: "Purchases & Suppliers", subtitle: range.label,
    kpis: [
      { label: "Spend (period)", value: formatPKR(totalSpend, { compact: true }), fullValue: formatPKR(totalSpend), accent: "blue", sensitive: true },
      { label: "Receipts", value: formatNumber(receipts.length), accent: "purple" },
      { label: "Total Payable", value: formatPKR(totalPayable, { compact: true }), fullValue: formatPKR(totalPayable), accent: "coral", sensitive: true },
      { label: "Suppliers", value: formatNumber((suppliers ?? []).length), accent: "teal" },
    ],
    charts: [{ type: "bar", title: "Spend by supplier", accent: "blue", dataKey: "spend",
      data: rows.filter((r) => r.spend > 0).slice(0, 10).map((r) => ({ label: r.name.slice(0, 14), spend: Math.round(r.spend) })) }],
    columns: [
      { key: "name", header: "Supplier", kind: "text" }, { key: "spend", header: "Spend (period)", align: "right", kind: "pkr" },
      { key: "payable", header: "Payable", align: "right", kind: "pkr" },
    ],
    rows, dimensions: [],
  };
}

/* ---------------- 6. Customers & udhaar ---------------- */
async function customersReport(supabase: Supabase, range: DateRange): Promise<ReportData> {
  const { sales } = await fetchSales(supabase, range);
  const returns = await fetchReturns(supabase, range);
  // Paginated: an established store's customer/charge-ledger tables can exceed
  // PostgREST's 1000-row default cap, which would silently understate the
  // "Outstanding Udhaar" total and drop customers from the aging breakdown.
  const customers = await fetchAll<{ id: string; name: string; credit_balance: number }>((from, to) => supabase
    .from("customers").select("id, name, credit_balance").order("id").range(from, to));
  const ledger = await fetchAll<{ customer_id: string; created_at: string }>((from, to) => supabase
    .from("customer_ledger").select("customer_id, created_at").eq("type", "CHARGE").order("id").range(from, to));

  const salesBy = new Map<string, { amount: number; orders: number }>();
  for (const s of sales) {
    if (!s.customer_id) continue;
    const cur = salesBy.get(s.customer_id) ?? { amount: 0, orders: 0 };
    cur.amount += Number(s.total); cur.orders += 1;
    salesBy.set(s.customer_id, cur);
  }
  // Net refunds out of each customer's sales (orders count stays a transaction tally).
  const netSalesOf = (cid: string) => (salesBy.get(cid)?.amount ?? 0) - (returns.byCustomer.get(cid)?.revenue ?? 0);
  // oldest charge per customer (rough aging)
  const oldestCharge = new Map<string, number>();
  for (const l of ledger) {
    const t = new Date(l.created_at).getTime();
    oldestCharge.set(l.customer_id, Math.min(oldestCharge.get(l.customer_id) ?? t, t));
  }
  const ageBucket = (id: string, bal: number) => {
    if (bal <= 0) return "—";
    const days = oldestCharge.has(id) ? (Date.now() - (oldestCharge.get(id) as number)) / 86_400_000 : 0;
    return days <= 30 ? "0–30d" : days <= 60 ? "31–60d" : days <= 90 ? "61–90d" : "90d+";
  };

  const totalOutstanding = customers.reduce((s, c) => s + Math.max(Number(c.credit_balance), 0), 0);
  const rows = customers.map((c) => ({
    name: c.name, sales: netSalesOf(c.id), orders: salesBy.get(c.id)?.orders ?? 0,
    outstanding: Number(c.credit_balance), aging: ageBucket(c.id, Number(c.credit_balance)),
  })).sort((a, b) => b.outstanding - a.outstanding || b.sales - a.sales);

  return {
    key: "customers", title: "Customers & Udhaar", subtitle: range.label,
    kpis: [
      { label: "Outstanding Udhaar", value: formatPKR(totalOutstanding, { compact: true }), fullValue: formatPKR(totalOutstanding), accent: "coral", sensitive: true },
      { label: "On Khata", value: formatNumber(customers.filter((c) => Number(c.credit_balance) > 0).length), accent: "amber" },
      { label: "Sales (period)", value: formatPKR(sales.reduce((s, x) => s + Number(x.total), 0) - returns.totalRevenue, { compact: true }), fullValue: formatPKR(sales.reduce((s, x) => s + Number(x.total), 0) - returns.totalRevenue), accent: "blue", sensitive: true },
      { label: "Customers", value: formatNumber(customers.length), accent: "teal" },
    ],
    charts: [{ type: "bar", title: "Top customers by sales", accent: "teal", dataKey: "sales",
      data: rows.filter((r) => r.sales > 0).sort((a, b) => b.sales - a.sales).slice(0, 10).map((r) => ({ label: r.name.slice(0, 14), sales: Math.round(r.sales) })) }],
    columns: [
      { key: "name", header: "Customer", kind: "text" }, { key: "sales", header: "Sales (period)", align: "right", kind: "pkr" },
      { key: "outstanding", header: "Outstanding", align: "right", kind: "pkr" }, { key: "aging", header: "Aging", kind: "pill" },
    ],
    rows, dimensions: [],
  };
}

/* ---------------- 7. Staff activity ---------------- */
async function usersReport(supabase: Supabase, range: DateRange): Promise<ReportData> {
  const { sales } = await fetchSales(supabase, range);
  const returns = await fetchReturns(supabase, range);
  const { data: profiles } = await supabase.from("profiles").select("id, full_name, role");
  // Paginated: a busy store logs every action, so audit_log over a wide range
  // (e.g. "This Year") can exceed PostgREST's 1000-row cap and silently
  // undercount Logged Actions / Adjustments.
  const audit = await fetchAll<{ actor: string | null; action: string; created_at: string }>((from, to) => supabase
    .from("audit_log").select("actor, action, created_at")
    .gte("created_at", iso(range.from)).lte("created_at", iso(range.to))
    .order("id").range(from, to));

  const stat = new Map<string, { name: string; role: string; orders: number; sales: number; adjustments: number; actions: number }>();
  const ensure = (id: string) => {
    if (!stat.has(id)) {
      const p = (profiles ?? []).find((x) => x.id === id);
      stat.set(id, { name: p?.full_name ?? "—", role: p?.role ?? "—", orders: 0, sales: 0, adjustments: 0, actions: 0 });
    }
    return stat.get(id)!;
  };
  for (const s of sales) if (s.cashier_id) { const r = ensure(s.cashier_id); r.orders += 1; r.sales += Number(s.total); }
  // Net refunds out of the cashier's sales money (orders stays a transaction tally).
  // Only adjust cashiers already active this period — never invent a new staff row.
  for (const [cashierId, rv] of returns.byCashier) { const r = stat.get(cashierId); if (r) r.sales -= rv.revenue; }
  for (const a of audit) if (a.actor) {
    const r = ensure(a.actor); r.actions += 1;
    if (a.action === "stock_adjustment" || a.action === "cycle_count") r.adjustments += 1;
  }

  return {
    key: "users", title: "Staff Activity", subtitle: range.label,
    kpis: [
      { label: "Active Staff", value: formatNumber(stat.size), accent: "blue" },
      { label: "Orders Handled", value: formatNumber(sales.length), accent: "purple" },
      { label: "Adjustments", value: formatNumber([...stat.values()].reduce((s, x) => s + x.adjustments, 0)), accent: "amber" },
      { label: "Logged Actions", value: formatNumber(audit.length), accent: "teal" },
    ],
    charts: [{ type: "bar", title: "Sales by cashier", accent: "blue", dataKey: "sales",
      data: [...stat.values()].filter((r) => r.sales > 0).sort((a, b) => b.sales - a.sales).map((r) => ({ label: r.name.slice(0, 12), sales: Math.round(r.sales) })) }],
    columns: [
      { key: "name", header: "User", kind: "text" }, { key: "role", header: "Role", kind: "pill" },
      { key: "orders", header: "Orders", align: "right", kind: "num" }, { key: "sales", header: "Sales", align: "right", kind: "pkr" },
      { key: "adjustments", header: "Adjustments", align: "right", kind: "num" }, { key: "actions", header: "Actions", align: "right", kind: "num" },
    ],
    rows: [...stat.values()].sort((a, b) => b.sales - a.sales), dimensions: [],
  };
}

/* ---------------- 8. Full system ---------------- */
async function systemReport(supabase: Supabase, range: DateRange, params: URLSearchParams): Promise<ReportData> {
  const mode = parseMode(params);
  const { sales, items } = await fetchSales(supabase, range);
  const variants = await getVariantOptions(supabase);
  const vMap = new Map(variants.map((v) => [v.variant_id, v]));
  const catName = await categoryNames(supabase);
  const [{ data: avail }, { data: suppliers }, { data: customers }, { count: orderCount }] = await Promise.all([
    selectAll<{ variant_id: string; on_hand: number }>((from, to) => supabase.from("variant_availability").select("variant_id, on_hand").order("variant_id").range(from, to)),
    // Paginated: an unbounded select silently caps at 1000 rows and would
    // understate Payables/Udhaar on the Full System headline for a store this size.
    selectAll<{ balance: number }>((from, to) => supabase.from("suppliers").select("balance").order("id").range(from, to)),
    selectAll<{ credit_balance: number }>((from, to) => supabase.from("customers").select("credit_balance").order("id").range(from, to)),
    supabase.from("orders").select("id", { count: "exact", head: true }).gte("created_at", iso(range.from)).lte("created_at", iso(range.to)),
  ]);

  const web = await fetchWebOrders(supabase, range);
  const returns = await fetchReturns(supabase, range);
  // Net (default) of counter returns so the headline + every breakdown agrees
  // with the Sales tab; Gross leaves discount and returns un-netted.
  const retRevenue = mode === "net" ? returns.totalRevenue : 0;
  const retProfit = mode === "net" ? returns.totalProfit : 0;
  const revenue = sales.reduce((s, x) => s + saleRevenue(x, mode), 0) + web.reduce((s, x) => s + webRevenue(x, mode), 0) - retRevenue;
  const profit = sales.reduce((s, x) => s + saleProfit(x, mode), 0) + web.reduce((s, x) => s + webProfit(x, mode), 0) - retProfit;
  // Active inventory only: vMap holds active variants (archived products are
  // excluded by getVariantOptions), so skip any variant absent from it — keeps
  // this figure consistent with the dashboard and Inventory Valuation report.
  const stockValue = (avail ?? []).reduce((s, a) => { const v = vMap.get(a.variant_id); return v ? s + Number(a.on_hand) * v.cost : s; }, 0);
  const payables = (suppliers ?? []).reduce((s, x) => s + Math.max(Number(x.balance), 0), 0);
  const udhaar = (customers ?? []).reduce((s, x) => s + Math.max(Number(x.credit_balance), 0), 0);

  const byCat = new Map<string, number>();
  for (const it of items) {
    const v = vMap.get(it.variant_id as string);
    const cat = v?.category_id ? (catName.get(v.category_id) ?? "—") : "Uncategorised";
    byCat.set(cat, (byCat.get(cat) ?? 0) + lineRevenue(it, mode));
  }
  // Subtract returned revenue from its product's category (Net mode only).
  if (mode === "net") for (const [vid, rv] of returns.byVariant) {
    const v = vMap.get(vid);
    const cat = v?.category_id ? (catName.get(v.category_id) ?? "—") : "Uncategorised";
    byCat.set(cat, (byCat.get(cat) ?? 0) - rv.revenue);
  }

  const b = bucketOf(range);
  const dayAgg = new Map<string, { label: string; sales: number; profit: number }>();
  for (const s of sales) {
    const k = bucketKey(new Date(s.created_at), b);
    const cur = dayAgg.get(k) ?? { label: k, sales: 0, profit: 0 };
    cur.sales += saleRevenue(s, mode); cur.profit += saleProfit(s, mode);
    dayAgg.set(k, cur);
  }
  for (const w of web) {
    const k = bucketKey(new Date(w.created_at), b);
    const cur = dayAgg.get(k) ?? { label: k, sales: 0, profit: 0 };
    cur.sales += webRevenue(w, mode); cur.profit += webProfit(w, mode);
    dayAgg.set(k, cur);
  }
  // Net returns per period (Net mode only; a return isn't a new transaction, only money out).
  if (mode === "net") for (const r of returns.byDate) {
    const k = bucketKey(new Date(r.created_at), b);
    const cur = dayAgg.get(k) ?? { label: k, sales: 0, profit: 0 };
    cur.sales -= r.revenue; cur.profit -= r.profit;
    dayAgg.set(k, cur);
  }

  return {
    key: "system", title: "Full System Report", subtitle: `${range.label} · ${mode === "gross" ? "Gross" : "Net"}`,
    kpis: [
      { label: mode === "gross" ? "Sales (Gross)" : "Sales", value: formatPKR(revenue, { compact: true }), fullValue: formatPKR(revenue), accent: "blue", sensitive: true },
      { label: "Profit", value: formatPKR(profit, { compact: true }), fullValue: formatPKR(profit), accent: "green", sensitive: true },
      { label: "Online Orders", value: formatNumber(orderCount ?? 0), accent: "purple" },
      { label: "Stock Value", value: formatPKR(stockValue, { compact: true }), fullValue: formatPKR(stockValue), accent: "teal", sensitive: true },
      { label: "Payables", value: formatPKR(payables, { compact: true }), fullValue: formatPKR(payables), accent: "coral", sensitive: true },
      { label: "Udhaar", value: formatPKR(udhaar, { compact: true }), fullValue: formatPKR(udhaar), accent: "amber", sensitive: true },
    ],
    charts: [
      { ...trend(range, [
        ...sales.map((s) => ({ created_at: s.created_at, value: saleRevenue(s, mode) })),
        ...web.map((w) => ({ created_at: w.created_at, value: webRevenue(w, mode) })),
        ...(mode === "net" ? returns.byDate.map((r) => ({ created_at: r.created_at, value: -r.revenue })) : []),
      ], "blue", "sales"), title: "Sales trend" },
      { type: "donut", title: "Sales by category", data: [...byCat.entries()].map(([name, value]) => ({ name, value: Math.round(value) })) },
    ],
    columns: [
      { key: "label", header: "Period", kind: "text" }, { key: "sales", header: "Sales", align: "right", kind: "pkr" },
      { key: "profit", header: "Profit", align: "right", kind: "pkr" },
    ],
    rows: [...dayAgg.values()], dimensions: [],
  };
}

/* ---------------- helpers ---------------- */
async function categoryNames(supabase: Supabase) {
  const { data } = await supabase.from("categories").select("id, name");
  return new Map((data ?? []).map((c) => [c.id, c.name]));
}
async function categoryList(supabase: Supabase): Promise<CategoryFilterOption[]> {
  const { data } = await supabase.from("categories").select("id, name, parent_id").order("sort").order("name");
  return (data ?? []) as CategoryFilterOption[];
}
async function profileNames(supabase: Supabase) {
  const { data } = await supabase.from("profiles").select("id, full_name");
  return new Map((data ?? []).map((p) => [p.id, p.full_name]));
}
