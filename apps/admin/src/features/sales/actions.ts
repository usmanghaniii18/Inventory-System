"use server";

import { createAdminClient } from "@hamza/shared/supabase/admin";
import { getCurrentUser } from "@hamza/shared/auth";
import type { ReceiptData, ReceiptItem } from "@/lib/receipt";

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface SalesListRow {
  id: string;
  receipt_no: string;
  created_at: string;
  customer_name: string | null;
  cashier_name: string | null;
  total: number;
  net_total: number; // total minus refunds
  item_count: number;
  returned_amount: number;
  has_return: boolean;
}

/** Paginated POS sales history (most recent first), with per-bill return status. */
export async function getSalesPage(params: { search?: string; limit?: number; offset?: number }): Promise<{ rows: SalesListRow[]; hasMore: boolean }> {
  const user = await getCurrentUser();
  if (!user) return { rows: [], hasMore: false };
  const db = createAdminClient();
  const limit = params.limit ?? 25;
  const offset = params.offset ?? 0;

  let q = db
    .from("sales")
    .select("id, receipt_no, created_at, customer_name, customer_id, total, cashier_id")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit); // +1 to detect "has more"
  const s = params.search?.trim();
  if (s) q = q.or(`receipt_no.ilike.%${s}%,customer_name.ilike.%${s}%`);
  const { data: salesRaw } = await q;
  const page = (salesRaw ?? []).slice(0, limit);
  const hasMore = (salesRaw ?? []).length > limit;
  if (!page.length) return { rows: [], hasMore: false };

  const ids = page.map((x) => x.id);
  const [{ data: items }, { data: returns }, { data: cashiers }, { data: customers }] = await Promise.all([
    db.from("sale_items").select("sale_id, qty").in("sale_id", ids),
    db.from("sale_returns").select("sale_id, total").in("sale_id", ids),
    db.from("profiles").select("id, full_name").in("id", page.map((x) => x.cashier_id).filter(Boolean) as string[]),
    db.from("customers").select("id, name").in("id", page.map((x) => x.customer_id).filter(Boolean) as string[]),
  ]);

  const itemCount = new Map<string, number>();
  for (const it of items ?? []) itemCount.set(it.sale_id, (itemCount.get(it.sale_id) ?? 0) + 1);
  const refundBySale = new Map<string, number>();
  for (const r of returns ?? []) refundBySale.set(r.sale_id, (refundBySale.get(r.sale_id) ?? 0) + Number(r.total));
  const cashierName = new Map((cashiers ?? []).map((c) => [c.id, c.full_name as string]));
  const custName = new Map((customers ?? []).map((c) => [c.id, c.name as string]));

  const rows: SalesListRow[] = page.map((sale) => {
    const refunded = refundBySale.get(sale.id) ?? 0;
    return {
      id: sale.id,
      receipt_no: sale.receipt_no,
      created_at: sale.created_at,
      customer_name: sale.customer_name || (sale.customer_id ? custName.get(sale.customer_id) ?? null : null),
      cashier_name: sale.cashier_id ? cashierName.get(sale.cashier_id) ?? null : null,
      total: Number(sale.total),
      net_total: round2(Number(sale.total) - refunded),
      item_count: itemCount.get(sale.id) ?? 0,
      returned_amount: round2(refunded),
      has_return: refunded > 0,
    };
  });
  return { rows, hasMore };
}

/**
 * PERMANENTLY delete a FULLY-RETURNED bill (owner only). Removes the sale and its
 * return records FK-safely; the append-only stock ledger is never mutated.
 *
 * Stock stays correct by construction: a fully-returned bill's SALE move (out of
 * stock) and RETURN move (back into stock) already cancel, so on-hand is unchanged
 * whether or not the bill rows exist. Likewise any sale/refund customer-ledger
 * entries net to zero, so balances are untouched. We only delete business rows:
 *   sale_returns (→ cascades sale_return_items) · discount_redemptions
 *   · sales (→ cascades payments + sale_items)
 * Active (un-returned / partially-returned) sales are refused.
 */
export async function deleteReturnedSale(saleId: string): Promise<{ ok: true } | { error: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: "Not authorized." };
  if (user.role !== "owner") return { error: "Only the store owner can delete a bill." };
  const db = createAdminClient();

  // Guard: never delete an active sale — the bill must be returned in full.
  const detail = await getSaleDetail(saleId);
  if ("error" in detail) return detail;
  const fullyReturned = detail.items.length > 0 && detail.refunded_total > 0 && detail.items.every((it) => it.remaining <= 0);
  if (!fullyReturned) return { error: "Only fully-returned bills can be permanently deleted." };

  // FK-safe order. sale_return_items cascade from sale_returns; payments and
  // sale_items cascade from sales. discount_redemptions has no cascade → first.
  const ret = await db.from("sale_returns").delete().eq("sale_id", saleId);
  if (ret.error) return { error: ret.error.message };
  const dr = await db.from("discount_redemptions").delete().eq("sale_id", saleId);
  if (dr.error) return { error: dr.error.message };
  const del = await db.from("sales").delete().eq("id", saleId);
  if (del.error) return { error: del.error.message };

  return { ok: true };
}

export interface SaleDetailItem {
  sale_item_id: string;
  name: string;
  label: string;
  unit: string | null;
  qty: number;
  returned: number;
  remaining: number;
  unit_price: number;
  line_total: number; // as sold (net of any line discount)
  line_discount: number; // qty*unit_price - line_total
}
export interface SaleReturnRecord {
  id: string;
  created_at: string;
  total: number;
  refund_method: string;
  reason: string | null;
  items: { name: string; label: string; qty: number; line_total: number }[];
}
export interface SaleDetail {
  id: string;
  receipt_no: string;
  created_at: string;
  customer_name: string | null;
  cashier_name: string | null;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  net_total: number;
  refunded_total: number;
  payments: { method: string; amount: number }[];
  items: SaleDetailItem[];
  returns: SaleReturnRecord[];
}

/** Full saved bill: every line, totals, payments, and any linked returns. */
export async function getSaleDetail(saleId: string): Promise<SaleDetail | { error: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: "Not authorized." };
  const db = createAdminClient();

  const { data: sale } = await db
    .from("sales")
    .select("id, receipt_no, created_at, customer_name, customer_id, cashier_id, subtotal, discount, tax, total")
    .eq("id", saleId).maybeSingle();
  if (!sale) return { error: "Sale not found." };

  const [{ data: items }, { data: pays }, { data: rets }, { data: cashier }] = await Promise.all([
    db.from("sale_items").select("id, product_id, variant_id, qty, unit_price, line_total").eq("sale_id", saleId),
    db.from("payments").select("method, amount").eq("sale_id", saleId),
    db.from("sale_returns").select("id, created_at, total, refund_method, reason").eq("sale_id", saleId).order("created_at"),
    sale.cashier_id ? db.from("profiles").select("full_name").eq("id", sale.cashier_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);

  const saleItemIds = (items ?? []).map((i) => i.id);
  const variantIds = [...new Set((items ?? []).map((i) => i.variant_id).filter(Boolean))] as string[];
  const [{ data: retItems }, { data: cat }] = await Promise.all([
    saleItemIds.length ? db.from("sale_return_items").select("return_id, sale_item_id, qty, line_total, variant_id, product_id").in("sale_item_id", saleItemIds) : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    variantIds.length ? db.from("catalog_index").select("variant_id, product_name, label, unit").in("variant_id", variantIds) : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);
  const nameMap = new Map((cat ?? []).map((c) => [c.variant_id as string, c]));
  const returnedByItem = new Map<string, number>();
  for (const r of retItems ?? []) returnedByItem.set(r.sale_item_id as string, (returnedByItem.get(r.sale_item_id as string) ?? 0) + Number(r.qty));

  const detailItems: SaleDetailItem[] = (items ?? []).map((it) => {
    const c = it.variant_id ? nameMap.get(it.variant_id) : null;
    const returned = returnedByItem.get(it.id) ?? 0;
    const lineTotal = Number(it.line_total);
    return {
      sale_item_id: it.id,
      name: (c?.product_name as string) ?? "Item",
      label: (c?.label as string) ?? "",
      unit: (c?.unit as string) ?? null,
      qty: Number(it.qty),
      returned,
      remaining: round2(Math.max(0, Number(it.qty) - returned)),
      unit_price: Number(it.unit_price),
      line_total: lineTotal,
      line_discount: round2(Number(it.qty) * Number(it.unit_price) - lineTotal),
    };
  });

  // Group return-item lines under each return record.
  const retItemsByReturn = new Map<string, { name: string; label: string; qty: number; line_total: number }[]>();
  for (const r of retItems ?? []) {
    const c = r.variant_id ? nameMap.get(r.variant_id as string) : null;
    const arr = retItemsByReturn.get(r.return_id as string) ?? [];
    arr.push({ name: (c?.product_name as string) ?? "Item", label: (c?.label as string) ?? "", qty: Number(r.qty), line_total: Number(r.line_total) });
    retItemsByReturn.set(r.return_id as string, arr);
  }
  const returns: SaleReturnRecord[] = (rets ?? []).map((r) => ({
    id: r.id, created_at: r.created_at, total: Number(r.total), refund_method: r.refund_method as string,
    reason: (r.reason as string) ?? null, items: retItemsByReturn.get(r.id) ?? [],
  }));
  const refundedTotal = round2(returns.reduce((s, r) => s + r.total, 0));

  return {
    id: sale.id, receipt_no: sale.receipt_no, created_at: sale.created_at,
    customer_name: sale.customer_name ?? null,
    cashier_name: (cashier?.full_name as string) ?? null,
    subtotal: Number(sale.subtotal), discount: Number(sale.discount), tax: Number(sale.tax), total: Number(sale.total),
    net_total: round2(Number(sale.total) - refundedTotal), refunded_total: refundedTotal,
    payments: (pays ?? []).map((p) => ({ method: p.method as string, amount: Number(p.amount) })),
    items: detailItems, returns,
  };
}

/**
 * Rebuild a saved bill as a ReceiptData for the shared invoice template.
 *
 * By default this reproduces the ORIGINAL sale EXACTLY from the figures persisted
 * at sale time — the stored per-line unit price, line total (and the discount
 * derived from them) plus the sale's own stored subtotal / total discount / tax /
 * net total. Nothing is recomputed from current product or discount settings, so
 * a reprint byte-matches the original no matter how much later it is printed, and
 * regardless of any later product/discount changes.
 *
 * The one exception is a bill that has since been RETURNED (in part or in full):
 * when `netOfReturns` is true (the default) such a bill is re-rendered as the
 * UPDATED bill — returned-in-full lines drop off, partially returned lines show
 * the remaining qty, and the total reflects the net of refunds. An un-returned
 * bill always reads straight from the stored figures.
 */
export async function getSaleReceiptData(saleId: string, netOfReturns = true): Promise<ReceiptData | { error: string }> {
  const detail = await getSaleDetail(saleId);
  if ("error" in detail) return detail;
  const db = createAdminClient();
  const { data: settings } = await db.from("settings").select("store_name, tax_percent, store_info").eq("id", 1).maybeSingle();
  const info = (settings?.store_info ?? {}) as Record<string, string | undefined>;
  const taxPercent = Number(settings?.tax_percent ?? 0);

  const meta = {
    store: {
      name: settings?.store_name ?? "Hamza General Store",
      address: info.address, phone: info.phone, ntn: info.ntn, logo_url: info.logo_url,
      header: info.receipt_header, footer: info.receipt_footer,
    },
    receipt_no: detail.receipt_no,
    date: new Date(detail.created_at).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" }),
    cashier: detail.cashier_name ?? "Cashier",
    customer: detail.customer_name,
    customer_address: null,
    tax_percent: taxPercent,
    payments: detail.payments,
    change: 0,
  };

  // Only re-render as an "updated bill" when this sale actually has returns.
  const applyReturns = netOfReturns && detail.refunded_total > 0;

  if (!applyReturns) {
    // EXACT original bill — every figure straight from what was persisted at sale
    // time. Per line: stored unit price, stored line total, and the discount is
    // exactly (qty × unit_price − line_total) as recorded. Totals are the sale's
    // own stored subtotal / discount / tax / total (never recomputed).
    const items: ReceiptItem[] = detail.items.map((it) => ({
      name: it.name, label: it.label || undefined, qty: it.qty, unit: it.unit,
      unit_price: it.unit_price, discount: it.line_discount, line_total: it.line_total,
    }));
    return {
      ...meta, items,
      subtotal: detail.subtotal, discount: detail.discount, tax: detail.tax, total: detail.total,
    };
  }

  // Updated bill after a return — reflect only the remaining (un-returned) qty and
  // the net-of-refunds total. Line discounts are prorated to the remaining qty.
  const lines = detail.items.filter((it) => it.remaining > 0);
  const items: ReceiptItem[] = lines.map((it) => {
    const perUnitDiscount = it.qty > 0 ? it.line_discount / it.qty : 0;
    return {
      name: it.name, label: it.label || undefined, qty: it.remaining, unit: it.unit,
      unit_price: it.unit_price, discount: round2(perUnitDiscount * it.remaining),
      line_total: round2(it.remaining * it.unit_price - perUnitDiscount * it.remaining),
    };
  });
  const subtotal = round2(items.reduce((s, it) => s + it.qty * it.unit_price, 0));
  const discount = round2(items.reduce((s, it) => s + (it.discount ?? 0), 0));
  return {
    ...meta, items,
    subtotal, discount, tax: detail.tax, total: round2(detail.net_total),
  };
}
