import type { createClient } from "@hamza/shared/supabase/server";
import { getVariantOptions } from "@/lib/catalog";
import { fetchAll, selectAll } from "@/lib/fetch-all";
import { bucketKey, bucketOf, type DateRange } from "@hamza/shared/dates";
import { netLineRevenue } from "@hamza/shared/pricing";

type Supabase = Awaited<ReturnType<typeof createClient>>;
const iso = (d: Date) => d.toISOString();

export interface DashboardData {
  kpis: { sales: number; profit: number; orders: number; lowStock: number; udhaar: number; stockValue: number };
  trend: { label: string; sales: number; profit: number }[];
  categoryMix: { name: string; value: number }[];
  topProducts: { label: string; revenue: number }[];
  paymentMix: { name: string; value: number }[];
  dailyOrders: { label: string; orders: number }[];
  lowStock: { id: string; product_id: string; name: string; available: number; reorder: number }[];
  recentOrders: { id: string; order_no: string; customer: string; total: number; status: string; payment: string }[];
  topCustomers: { id: string; name: string; outstanding: number }[];
  topSuppliers: { id: string; name: string; payable: number }[];
  nearExpiry: { id: string; product_id: string | null; name: string; lot: string; expiry: string; days: number }[];
  rangeLabel: string;
}

export async function buildDashboard(supabase: Supabase, range: DateRange): Promise<DashboardData> {
  // These reads are all independent — run getVariantOptions, categories, the
  // range queries AND the reorder-point / lots / lot-level reads (used further
  // down for low-stock + near-expiry) in a SINGLE parallel batch. They don't
  // depend on the sale ids resolved later, so pulling them up here removes 3
  // sequential round-trips from the request.
  //
  // Every range-scoped and financially-material table below is read with
  // `fetchAll`/`selectAll`, paginated with a stable `.order("id")`. A plain
  // `.select()` is silently capped at 1000 rows by PostgREST with no
  // guaranteed row order — for a store doing hundreds of sales/day, a
  // multi-week range crosses that cap within weeks, which is what caused
  // "widening the range decreases the total" (two different-but-overlapping
  // capped subsets) and "identical trend curves" for different ranges.
  const [
    variants, { data: catRows }, sales, { data: avail },
    customers, suppliers, returnsRaw,
    { data: vrows }, lots, lotLevels,
    { data: recentOrdersRaw }, ordersInRangeRaw,
  ] = await Promise.all([
    getVariantOptions(supabase),
    supabase.from("categories").select("id, name"),
    fetchAll<{ id: string; total: number; profit: number; created_at: string }>((from, to) => supabase
      .from("sales").select("id, total, profit, created_at")
      .gte("created_at", iso(range.from)).lte("created_at", iso(range.to))
      .order("id").range(from, to)),
    selectAll((from, to) => supabase.from("variant_availability").select("variant_id, on_hand, available").order("variant_id").range(from, to)),
    fetchAll<{ id: string; name: string; credit_balance: number }>((from, to) => supabase
      .from("customers").select("id, name, credit_balance").order("id").range(from, to)),
    fetchAll<{ id: string; name: string; balance: number }>((from, to) => supabase
      .from("suppliers").select("id, name, balance").order("id").range(from, to)),
    fetchAll<{ id: string; created_at: string }>((from, to) => supabase
      .from("sale_returns").select("id, created_at")
      .gte("created_at", iso(range.from)).lte("created_at", iso(range.to))
      .order("id").range(from, to)),
    selectAll((from, to) => supabase.from("product_variants").select("id, reorder_point").order("id").range(from, to)),
    fetchAll<{ id: string; variant_id: string; lot_number: string; expiry_date: string }>((from, to) => supabase
      .from("lots").select("id, variant_id, lot_number, expiry_date")
      .not("expiry_date", "is", null).order("id").range(from, to)),
    fetchAll<{ lot_id: string; on_hand: number }>((from, to) => supabase
      .from("stock_levels").select("lot_id, on_hand")
      .not("lot_id", "is", null).order("lot_id").range(from, to)),
    // "Recent Orders" widget: always the latest few overall, independent of the
    // selected date range — deliberately NOT range-filtered.
    supabase.from("orders").select("id, order_no, customer_name, total, status, payment_type, created_at")
      .order("created_at", { ascending: false }).limit(6),
    // Range-scoped orders for the "Orders" KPI + "Daily Orders" chart — this
    // used to reuse the unfiltered latest-200 fetch above and silently show
    // zero/wrong data for any range outside that window; now filtered +
    // paginated server-side like everything else.
    fetchAll<{ id: string; created_at: string }>((from, to) => supabase
      .from("orders").select("id, created_at")
      .gte("created_at", iso(range.from)).lte("created_at", iso(range.to))
      .order("id").range(from, to)),
  ]);
  const vMap = new Map(variants.map((v) => [v.variant_id, v]));
  const catName = new Map<string, string>();
  for (const c of catRows ?? []) catName.set(c.id, c.name);

  // sale_items / sale_return_items are filtered via an FK embed on the parent's
  // date (`sales!inner`/`sale_returns!inner`) rather than an `.in("sale_id",
  // ids)` list — with a few hundred+ sales in a wide range, that id list builds
  // a URL/header long enough to blow past PostgREST's/the proxy's size limit
  // and fail outright, which is why Category Mix / Top Products silently
  // showed "No data in this period" for wide custom ranges. Same fix already
  // applied in reports/queries.ts's fetchSales/fetchReturns.
  const [items, pays, retItems] = await Promise.all([
    fetchAll<Record<string, unknown>>((from, to) => supabase
      .from("sale_items").select("sale_id, variant_id, qty, line_total, sales!inner(created_at)")
      .gte("sales.created_at", iso(range.from)).lte("sales.created_at", iso(range.to))
      .order("id").range(from, to)),
    // All payments in range — both in-store (sale_id) and online-store (order_id),
    // so the "Online" segment captures online payments from either channel.
    fetchAll<{ method: string; amount: number; order_id: string | null }>((from, to) => supabase
      .from("payments").select("method, amount, order_id")
      .gte("created_at", iso(range.from)).lte("created_at", iso(range.to))
      .order("id").range(from, to)),
    fetchAll<{ return_id: string; qty: number; line_total: number; unit_cogs: number }>((from, to) => supabase
      .from("sale_return_items").select("return_id, qty, line_total, unit_cogs, sale_returns!inner(created_at)")
      .gte("sale_returns.created_at", iso(range.from)).lte("sale_returns.created_at", iso(range.to))
      .order("id").range(from, to)),
  ]);

  // `sale_items.line_total` is net of only the line's own discount — it predates
  // the bill-level/promo discount, which is applied afterward across the whole
  // sale. Spread that bill-level discount (and tax) back across the sale's
  // lines proportionally (same basis as the returns/refund path) so category
  // mix / top products reconcile to the sale-header `total` instead of
  // overstating on the pre-discount line amount.
  const saleTotalOf = new Map(sales.map((s) => [s.id, Number(s.total)]));
  const sumLineTotalsOf = new Map<string, number>();
  for (const it of items) {
    const sid = it.sale_id as string;
    sumLineTotalsOf.set(sid, (sumLineTotalsOf.get(sid) ?? 0) + Number(it.line_total));
  }
  const itemsWithNetRevenue: { variant_id: string; net_line_total: number }[] = items.map((it) => {
    const sid = it.sale_id as string;
    return {
      variant_id: it.variant_id as string,
      net_line_total: netLineRevenue(Number(it.line_total), sumLineTotalsOf.get(sid) ?? 0, saleTotalOf.get(sid) ?? 0),
    };
  });

  // Returns net out of sales/profit (a return is not a sale). Attributed to the
  // return's own date for the trend.
  const retDate = new Map(returnsRaw.map((r) => [r.id, r.created_at]));
  const retByDate = new Map<string, { revenue: number; profit: number }>();
  let retRevenue = 0, retProfit = 0;
  for (const ri of retItems) {
    const rev = Number(ri.line_total); const prof = rev - Number(ri.qty) * Number(ri.unit_cogs);
    retRevenue += rev; retProfit += prof;
    const d = retDate.get(ri.return_id) ?? iso(range.from);
    const k = bucketKey(new Date(d), bucketOf(range));
    const cur = retByDate.get(k) ?? { revenue: 0, profit: 0 };
    cur.revenue += rev; cur.profit += prof; retByDate.set(k, cur);
  }

  // KPIs (net of returns)
  const totalSales = sales.reduce((s, x) => s + Number(x.total), 0) - retRevenue;
  const totalProfit = sales.reduce((s, x) => s + Number(x.profit), 0) - retProfit;
  const ordersInRange = ordersInRangeRaw.length;
  const availMap = new Map((avail ?? []).map((a) => [a.variant_id, a]));
  // Stock value counts active inventory only — vMap holds active variants
  // (getVariantOptions excludes archived products), so a variant missing from it
  // is archived and is skipped, matching the Inventory Valuation report.
  const stockValue = (avail ?? []).reduce((s, a) => { const v = vMap.get(a.variant_id); return v ? s + Number(a.on_hand) * v.cost : s; }, 0);
  const udhaar = customers.reduce((s, c) => s + Math.max(Number(c.credit_balance), 0), 0);

  // trend (sales + profit)
  const b = bucketOf(range);
  const trendMap = new Map<string, { label: string; sales: number; profit: number }>();
  for (const s of sales) {
    const k = bucketKey(new Date(s.created_at), b);
    const cur = trendMap.get(k) ?? { label: k, sales: 0, profit: 0 };
    cur.sales += Number(s.total); cur.profit += Number(s.profit);
    trendMap.set(k, cur);
  }
  for (const [k, rv] of retByDate) {
    const cur = trendMap.get(k) ?? { label: k, sales: 0, profit: 0 };
    cur.sales -= rv.revenue; cur.profit -= rv.profit;
    trendMap.set(k, cur);
  }

  // category mix + top products
  const catMap = new Map<string, number>();
  const prodMap = new Map<string, number>();
  for (const it of itemsWithNetRevenue) {
    const v = vMap.get(it.variant_id);
    const cat = v?.category_id ? (catName.get(v.category_id) ?? "—") : "Uncategorised";
    catMap.set(cat, (catMap.get(cat) ?? 0) + Number(it.net_line_total));
    const pname = v ? v.product_name : "—";
    prodMap.set(pname, (prodMap.get(pname) ?? 0) + Number(it.net_line_total));
  }

  // payment mix — in-store methods (Cash / Easypaisa / JazzCash / Udhaar) shown
  // individually; every e-commerce payment (linked to an order) rolls up into a
  // single "Online" segment. (Part 4: Card & Bank Transfer were removed.)
  const payMap = new Map<string, number>();
  for (const p of pays) {
    const m = String(p.method).toUpperCase();
    const bucket = p.order_id
      ? "Online"
      : m === "CASH" ? "Cash"
      : m === "EASYPAISA" ? "Easypaisa"
      : m === "JAZZCASH" ? "JazzCash"
      : m === "UDHAAR" ? "Udhaar"
      : "Online"; // COD / any legacy method
    payMap.set(bucket, (payMap.get(bucket) ?? 0) + Number(p.amount));
  }

  // daily orders — already range-filtered server-side (ordersInRangeRaw)
  const ordMap = new Map<string, number>();
  for (const o of ordersInRangeRaw) {
    const k = bucketKey(new Date(o.created_at), b);
    ordMap.set(k, (ordMap.get(k) ?? 0) + 1);
  }

  // low stock (current)
  const lowStock = variants.map((v) => {
    const a = availMap.get(v.variant_id);
    return { id: v.variant_id, product_id: v.product_id, name: `${v.product_name} · ${v.label}`, available: a ? Number(a.available) : 0, reorder: 0 };
  });
  const reorderMap = new Map((vrows ?? []).map((r) => [r.id, Number(r.reorder_point)]));
  const low = lowStock.map((r) => ({ ...r, reorder: reorderMap.get(r.id) ?? 0 }))
    .filter((r) => r.available <= r.reorder).sort((a, b) => a.available - b.available).slice(0, 8);

  // near expiry (FEFO) — lots + lot stock-levels were fetched in the batch above
  const lotOnHand = new Map<string, number>();
  for (const l of lotLevels) lotOnHand.set(l.lot_id, (lotOnHand.get(l.lot_id) ?? 0) + Number(l.on_hand));
  const nearExpiry = lots
    .filter((l) => (lotOnHand.get(l.id) ?? 0) > 0)
    .map((l) => {
      const v = vMap.get(l.variant_id);
      const days = Math.ceil((new Date(l.expiry_date).getTime() - Date.now()) / 86_400_000);
      return { id: l.id, product_id: v?.product_id ?? null, name: v ? `${v.product_name} · ${v.label}` : "—", lot: l.lot_number, expiry: l.expiry_date, days };
    })
    .filter((l) => l.days <= 90)
    .sort((a, b) => a.days - b.days).slice(0, 8);

  return {
    kpis: { sales: totalSales, profit: totalProfit, orders: ordersInRange, lowStock: low.length, udhaar, stockValue },
    trend: [...trendMap.values()],
    categoryMix: [...catMap.entries()].map(([name, value]) => ({ name, value: Math.round(value) })).sort((a, b) => b.value - a.value),
    topProducts: [...prodMap.entries()].map(([label, revenue]) => ({ label: label.slice(0, 14), revenue: Math.round(revenue) })).sort((a, b) => b.revenue - a.revenue).slice(0, 8),
    paymentMix: (["Cash", "Easypaisa", "JazzCash", "Udhaar", "Online"] as const)
      .filter((name) => payMap.has(name))
      .map((name) => ({ name, value: Math.round(payMap.get(name) ?? 0) })),
    dailyOrders: [...ordMap.entries()].map(([label, orders]) => ({ label, orders })),
    lowStock: low,
    recentOrders: (recentOrdersRaw ?? []).map((o) => ({ id: o.id, order_no: o.order_no, customer: o.customer_name, total: Number(o.total), status: String(o.status).toLowerCase(), payment: String(o.payment_type).toLowerCase() })),
    topCustomers: customers.map((c) => ({ id: c.id, name: c.name, outstanding: Number(c.credit_balance) })).filter((c) => c.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding).slice(0, 6),
    topSuppliers: suppliers.map((s) => ({ id: s.id, name: s.name, payable: Number(s.balance) })).filter((s) => s.payable > 0).sort((a, b) => b.payable - a.payable).slice(0, 6),
    nearExpiry,
    rangeLabel: range.label,
  };
}
