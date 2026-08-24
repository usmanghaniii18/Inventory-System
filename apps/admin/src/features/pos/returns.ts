"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@hamza/shared/supabase/admin";
import { getCurrentUser } from "@hamza/shared/auth";
import { returnSchema, firstIssue } from "@hamza/shared/validation";
import { netUnitPaid, splitUdhaarRefund } from "@hamza/shared/pricing";
import type { PayMethod } from "./actions";
import { returnWindowDays, isWithinReturnWindow } from "@/lib/return-window";

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ReturnableItem {
  sale_item_id: string;
  product_id: string;
  variant_id: string | null;
  name: string;
  label: string;
  qty: number;
  returned: number;
  remaining: number;
  unit_price: number;
  unit_cogs: number;
  /** Net amount actually paid per unit (after line + proportional bill discount
   *  and tax) — the correct refund basis, NOT the pre-discount unit_price. */
  refund_unit: number;
}

export interface SaleForReturn {
  sale_id: string;
  receipt_no: string;
  created_at: string;
  customer_id: string | null;
  within_window: boolean;
  window_days: number;
  items: ReturnableItem[];
}

/** Look up a sale by receipt number and return its still-returnable lines. */
export async function getSaleForReturn(receiptNo: string): Promise<SaleForReturn | { error: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: "Not authorized." };
  const db = createAdminClient();

  const { data: sale } = await db
    .from("sales").select("id, receipt_no, created_at, customer_id, total")
    .eq("receipt_no", receiptNo.trim()).maybeSingle();
  if (!sale) return { error: "No sale found with that receipt number." };

  const { data: items } = await db
    .from("sale_items").select("id, product_id, variant_id, qty, unit_price, unit_cogs, line_total").eq("sale_id", sale.id);
  const saleItemIds = (items ?? []).map((i) => i.id);

  // The actual amount paid per unit = each line's net (after its own discount)
  // with the bill-level discount + tax spread across lines proportionally, so
  // Σ(qty × refund_unit) == the bill total. Refunds use this, never unit_price.
  const sumLineTotals = (items ?? []).reduce((s, i) => s + Number(i.line_total), 0);
  const saleTotal = Number(sale.total);

  const { data: rets } = saleItemIds.length
    ? await db.from("sale_return_items").select("sale_item_id, qty").in("sale_item_id", saleItemIds)
    : { data: [] as { sale_item_id: string; qty: number }[] };
  const retMap = new Map<string, number>();
  for (const r of rets ?? []) retMap.set(r.sale_item_id, (retMap.get(r.sale_item_id) ?? 0) + Number(r.qty));

  const variantIds = [...new Set((items ?? []).map((i) => i.variant_id).filter(Boolean))] as string[];
  const { data: cat } = variantIds.length
    ? await db.from("catalog_index").select("variant_id, product_name, label").in("variant_id", variantIds)
    : { data: [] as { variant_id: string; product_name: string; label: string }[] };
  const nameMap = new Map((cat ?? []).map((c) => [c.variant_id, c]));

  const { data: settings } = await db.from("settings").select("store_info").eq("id", 1).maybeSingle();
  const windowDays = returnWindowDays(settings?.store_info as Record<string, unknown> | null);
  const within = isWithinReturnWindow(sale.created_at as string, windowDays);

  const list: ReturnableItem[] = (items ?? []).map((it) => {
    const returned = retMap.get(it.id) ?? 0;
    const c = it.variant_id ? nameMap.get(it.variant_id) : null;
    return {
      sale_item_id: it.id, product_id: it.product_id, variant_id: it.variant_id,
      name: c?.product_name ?? "Item", label: c?.label ?? "",
      qty: Number(it.qty), returned, remaining: round2(Math.max(0, Number(it.qty) - returned)),
      unit_price: Number(it.unit_price), unit_cogs: Number(it.unit_cogs),
      refund_unit: netUnitPaid(Number(it.line_total), Number(it.qty), sumLineTotals, saleTotal),
    };
  });

  return {
    sale_id: sale.id, receipt_no: sale.receipt_no, created_at: sale.created_at,
    customer_id: sale.customer_id, within_window: within, window_days: windowDays, items: list,
  };
}

/** Process a counter return: reverse stock back into inventory and refund. */
export async function processReturn(input: {
  sale_id: string;
  receipt_no: string;
  items: { sale_item_id: string; product_id: string; variant_id: string | null; qty: number; unit_price: number; unit_cogs: number }[];
  reason?: string | null;
  refund_method: PayMethod;
  customer_id?: string | null;
  idempotency_key: string;
}) {
  const user = await getCurrentUser();
  if (!user) return { error: "Not authorized." };
  const parsed = returnSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const picked = input.items.filter((i) => i.qty > 0);
  if (!picked.length) return { error: "Select at least one item to return." };

  const db = createAdminClient();

  // Idempotency: a retried submit must not refund twice.
  const { data: dupe } = await db
    .from("stock_moves").select("reference_id").eq("idempotency_key", `${input.idempotency_key}-0`).maybeSingle();
  if (dupe) return { ok: true, duplicate: true, return_id: dupe.reference_id, total: 0 };

  // Pull the WHOLE sale (header + every line) so the refund is computed from
  // what was actually paid — authoritative DB values, never the client payload.
  const { data: sale } = await db.from("sales").select("created_at, customer_id, total").eq("id", input.sale_id).maybeSingle();
  const { data: origItems } = await db
    .from("sale_items").select("id, qty, unit_price, unit_cogs, line_total").eq("sale_id", input.sale_id);
  const origMap = new Map((origItems ?? []).map((i) => [i.id, i]));
  const saleItemIds = picked.map((i) => i.sale_item_id);
  const { data: rets } = await db.from("sale_return_items").select("sale_item_id, qty").in("sale_item_id", saleItemIds);
  const retMap = new Map<string, number>();
  for (const r of rets ?? []) retMap.set(r.sale_item_id, (retMap.get(r.sale_item_id) ?? 0) + Number(r.qty));

  // Validate quantities against what's still returnable.
  for (const it of picked) {
    const orig = origMap.get(it.sale_item_id);
    if (!orig) return { error: "That line isn't part of this sale." };
    const remaining = Number(orig.qty) - (retMap.get(it.sale_item_id) ?? 0);
    if (it.qty > remaining + 1e-6) return { error: "Return quantity exceeds what was sold." };
  }

  // Return window.
  const { data: settings } = await db.from("settings").select("store_info").eq("id", 1).maybeSingle();
  const windowDays = returnWindowDays(settings?.store_info as Record<string, unknown> | null);
  if (sale && !isWithinReturnWindow(sale.created_at as string, windowDays)) {
    return { error: `Outside the ${windowDays}-day return window.` };
  }

  // Refund = the net amount actually paid for each returned line: its line_total
  // (already net of line discount) with the bill-level discount + tax spread
  // proportionally. NEVER the pre-discount unit_price. A full return refunds
  // exactly what that line collected, so net sales can't go negative.
  const sumLineTotals = (origItems ?? []).reduce((s, i) => s + Number(i.line_total), 0);
  const saleTotal = Number(sale?.total ?? 0);
  const refundOf = (saleItemId: string, qty: number) => {
    const orig = origMap.get(saleItemId)!;
    return round2(qty * netUnitPaid(Number(orig.line_total), Number(orig.qty), sumLineTotals, saleTotal));
  };
  const lines = picked.map((i) => {
    const orig = origMap.get(i.sale_item_id)!;
    return {
      ...i,
      unit_price: Number(orig.unit_price),
      unit_cogs: Number(orig.unit_cogs),
      refund: refundOf(i.sale_item_id, i.qty),
    };
  });
  const total = round2(lines.reduce((s, i) => s + i.refund, 0));

  const { data: locs } = await db.from("locations").select("id, code").in("code", ["MAIN", "CUST"]);
  const main = locs?.find((l) => l.code === "MAIN")?.id;
  const cust = locs?.find((l) => l.code === "CUST")?.id;
  if (!main || !cust) return { error: "Locations not configured." };

  const { data: ret, error: rErr } = await db
    .from("sale_returns")
    .insert({ sale_id: input.sale_id, receipt_no: input.receipt_no, total, refund_method: input.refund_method, reason: input.reason || null, created_by: user.id })
    .select("id").single();
  if (rErr) return { error: rErr.message };
  const returnId = ret.id as string;

  await db.from("sale_return_items").insert(
    lines.map((i) => ({
      return_id: returnId, sale_item_id: i.sale_item_id, product_id: i.product_id, variant_id: i.variant_id,
      qty: i.qty, unit_price: i.unit_price, unit_cogs: i.unit_cogs, line_total: i.refund,
    })),
  );

  // Reverse stock back into inventory at the original COGS (so avg cost isn't skewed).
  const moves = lines.map((i, idx) => ({
    product_id: i.product_id, variant_id: i.variant_id, qty: i.qty,
    from_location_id: cust, to_location_id: main, unit_cost: i.unit_cogs,
    reference_type: "RETURN" as const, reference_id: returnId, source: "MANUAL" as const,
    idempotency_key: `${input.idempotency_key}-${idx}`, created_by: user.id, note: "Counter return",
  }));
  const { error: mErr } = await db.from("stock_moves").insert(moves);
  if (mErr) return { error: mErr.message };

  // Refund: whatever portion of the ORIGINAL bill was charged to the customer's
  // khata must come back off it automatically — regardless of the chosen refund
  // method — since handing back "cash" for money that was never paid in cash is
  // wrong, and leaving the khata charge untouched leaves their balance too high.
  // Only the portion of the bill originally paid in cash/Easypaisa/JazzCash (if
  // any) follows the cashier's chosen refund method, exactly as before.
  const cid = input.customer_id || sale?.customer_id || null;

  const applyToKhata = async (amount: number, reference: string) => {
    if (amount <= 0 || !cid) return;
    const { data: c } = await db.from("customers").select("credit_balance").eq("id", cid).single();
    const newBal = round2(Number(c?.credit_balance ?? 0) - amount);
    await db.from("customer_ledger").insert({
      customer_id: cid, type: "PAYMENT", amount, reference, balance_after: newBal, created_by: user.id,
    });
    await db.from("customers").update({ credit_balance: newBal }).eq("id", cid);
  };

  const { data: origPays } = cid ? await db.from("payments").select("method, amount").eq("sale_id", input.sale_id) : { data: [] as { method: string; amount: number }[] };
  const origUdhaar = (origPays ?? []).filter((p) => p.method === "UDHAAR").reduce((s, p) => s + Number(p.amount), 0);

  // Cap at what's still outstanding from THIS bill's own udhaar charge — a
  // return can never reverse more than that bill originally put on the khata,
  // even if an earlier (pre-fix) return already over-credited it.
  const { data: priorRefunds } = cid && origUdhaar > 0
    ? await db.from("customer_ledger").select("amount").eq("customer_id", cid).eq("type", "PAYMENT").eq("reference", `Return ${input.receipt_no}`)
    : { data: [] as { amount: number }[] };
  const alreadyRefunded = (priorRefunds ?? []).reduce((s, r) => s + Number(r.amount), 0);

  const { udhaarPortion, remainder } = cid
    ? splitUdhaarRefund({ refundTotal: total, saleTotal, originalUdhaar: origUdhaar, alreadyRefundedUdhaar: alreadyRefunded })
    : { udhaarPortion: 0, remainder: total };
  await applyToKhata(udhaarPortion, `Return ${input.receipt_no}`);

  // Whatever's left (all of it, for a bill with no original udhaar — unchanged
  // path) follows the cashier's chosen refund method.
  if (remainder > 0) {
    if (input.refund_method === "UDHAAR" && cid) {
      // A separate reference from the bill-linked reversal above, so a cashier
      // choosing to also convert this leftover into store credit never counts
      // against — and so never shrinks — this bill's own udhaar-reversal cap.
      const reference = origUdhaar > 0 ? `Return ${input.receipt_no} (extra, converted to khata)` : `Return ${input.receipt_no}`;
      await applyToKhata(remainder, reference);
    } else {
      await db.from("payments").insert({ sale_id: input.sale_id, method: input.refund_method, amount: -remainder });
    }
  }

  revalidatePath("/admin/stock");
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/customers");
  return { ok: true as const, return_id: returnId, total };
}
