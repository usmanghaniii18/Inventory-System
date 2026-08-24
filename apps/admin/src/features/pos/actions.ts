"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@hamza/shared/supabase/admin";
import { getCurrentUser } from "@hamza/shared/auth";
import { checkoutSchema, customerQuickSchema, firstIssue } from "@hamza/shared/validation";
import { computeTotals, paymentsSettle, round2 } from "@hamza/shared/pricing";
import { computePromotions, type PromoLine } from "@hamza/shared/discounts";
import { loadActivePromotions, recordRedemptions } from "@hamza/shared/promotions";
import { buildSaleMoves } from "@/lib/stock-moves";

export interface CartLine {
  variant_id: string;
  product_id: string;
  qty: number;
  unit_price: number;
  /** Per-line discount in rupees (off the line total). */
  discount?: number;
}

/** Quick-add a customer at the counter (returns the new id to attach immediately). */
export async function quickAddCustomer(name: string, phone?: string | null) {
  const user = await getCurrentUser();
  if (!user) return { error: "Not authorized." };
  const v = customerQuickSchema.safeParse({ name, phone });
  if (!v.success) return { error: firstIssue(v.error) };
  const db = createAdminClient();
  const { data, error } = await db
    .from("customers")
    .insert({ name: name.trim(), phone: phone?.trim() || null })
    .select("id, name, phone")
    .single();
  if (error) return { error: error.message };
  revalidatePath("/admin/customers");
  return { ok: true as const, customer: { id: data.id as string, name: data.name as string, phone: (data.phone as string) ?? null } };
}

// Cash, Easypaisa, JazzCash and Udhaar at the till; COD for the e-commerce side.
// Card and Bank Transfer were removed (Part 4).
export type PayMethod = "CASH" | "JAZZCASH" | "EASYPAISA" | "UDHAAR" | "COD";
export interface PaymentInput {
  method: PayMethod;
  amount: number;
}

export interface CheckoutResult {
  ok: true;
  sale_id: string;
  receipt_no: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  profit: number;
  payments: PaymentInput[];
  duplicate?: boolean;
}

export async function checkoutSale(input: {
  lines: CartLine[];
  customer_id?: string | null;
  customer_name?: string | null;
  payments: PaymentInput[];
  discount?: number;
  coupon_code?: string | null;
  idempotency_key: string;
}): Promise<CheckoutResult | { error: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: "Not authorized." };
  const parsed = checkoutSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };

  const hasUdhaar = input.payments.some((p) => p.method === "UDHAAR");
  if (hasUdhaar && !input.customer_id) {
    return { error: "Pick a customer for udhaar (khata) sales." };
  }

  const db = createAdminClient();

  // Idempotency: if a move with this key already exists, the sale was processed.
  const { data: dupe } = await db
    .from("stock_moves").select("reference_id")
    .eq("idempotency_key", `${input.idempotency_key}-0`).maybeSingle();
  if (dupe) {
    const { data: prev } = await db
      .from("sales").select("receipt_no, subtotal, discount, tax, total, profit").eq("id", dupe.reference_id).maybeSingle();
    return {
      ok: true, duplicate: true, sale_id: dupe.reference_id, receipt_no: prev?.receipt_no ?? "",
      subtotal: Number(prev?.subtotal ?? 0), discount: Number(prev?.discount ?? 0), tax: Number(prev?.tax ?? 0),
      total: Number(prev?.total ?? 0), profit: Number(prev?.profit ?? 0), payments: input.payments,
    };
  }

  const { data: locs } = await db.from("locations").select("id, code").in("code", ["MAIN", "CUST"]);
  const main = locs?.find((l) => l.code === "MAIN")?.id;
  const cust = locs?.find((l) => l.code === "CUST")?.id;
  if (!main || !cust) return { error: "Locations not configured." };

  const variantIds = input.lines.map((l) => l.variant_id);
  const { data: avail } = await db
    .from("variant_availability").select("variant_id, avg_cost, available").in("variant_id", variantIds);
  const costMap = new Map((avail ?? []).map((a) => [a.variant_id, Number(a.avg_cost)]));
  const availMap = new Map((avail ?? []).map((a) => [a.variant_id, Number(a.available)]));

  // Pre-check stock so we never create an orphan sale; the DB trigger is the
  // authoritative backstop for races (it blocks any physical location < 0).
  for (const l of input.lines) {
    const have = availMap.get(l.variant_id) ?? 0;
    if (l.qty > have) {
      return { error: `Not enough stock — need ${l.qty}, only ${have} available.` };
    }
  }

  let cogsTotal = 0;
  const items = input.lines.map((l) => {
    const gross = l.qty * l.unit_price;
    const lineDisc = Math.min(Math.max(l.discount ?? 0, 0), gross);
    const unitCogs = costMap.get(l.variant_id) ?? 0;
    cogsTotal += l.qty * unitCogs;
    return { ...l, line_total: gross - lineDisc, unit_cogs: unitCogs };
  });

  // Tax + invoice prefix come from settings.
  const { data: settings } = await db.from("settings").select("tax_percent, store_info").eq("id", 1).maybeSingle();
  const taxPercent = Number(settings?.tax_percent ?? 0);
  const prefix = ((settings?.store_info as Record<string, unknown> | null)?.invoice_prefix as string) || "INV";

  // Re-run the promotions engine server-side (authoritative) so a tampered client
  // can't invent a discount, then fold the promo total into the bill discount.
  const productIds = [...new Set(input.lines.map((l) => l.product_id))];
  const [{ data: prods }, { data: cats }, promotions] = await Promise.all([
    productIds.length ? db.from("products").select("id, category_id").in("id", productIds) : Promise.resolve({ data: [] as { id: string; category_id: string | null }[] }),
    db.from("categories").select("id, parent_id"),
    loadActivePromotions(db),
  ]);
  const catOf = new Map((prods ?? []).map((p) => [p.id, p.category_id]));
  const parentOf = new Map((cats ?? []).map((c) => [c.id, c.parent_id]));
  const promoLines: PromoLine[] = input.lines.map((l) => {
    const cid = catOf.get(l.product_id) ?? null;
    return {
      key: l.variant_id, product_id: l.product_id,
      category_ids: [cid, cid ? parentOf.get(cid) : null].filter(Boolean) as string[],
      qty: l.qty, unit_price: l.unit_price,
    };
  });
  const promo = computePromotions(promoLines, promotions, { couponCode: input.coupon_code });
  const effectiveBill = (input.discount ?? 0) + promo.totalDiscount;

  // Shared money math (identical on the client) — line + bill/promo discounts and tax.
  const { subtotal, discount, tax, total } = computeTotals(input.lines, effectiveBill, taxPercent);
  const profit = total - tax - cogsTotal;

  // Payments must settle the bill exactly (cash change is handled in the UI;
  // the applied cash amount is sent, not the tendered amount).
  if (!paymentsSettle(total, input.payments)) {
    const paid = input.payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    return { error: `Payments (Rs ${paid.toFixed(0)}) must equal the total (Rs ${total.toFixed(0)}).` };
  }

  const receiptNo = `${prefix}-${Date.now().toString().slice(-8)}`;

  const { data: sale, error: sErr } = await db
    .from("sales")
    .insert({
      receipt_no: receiptNo, customer_id: input.customer_id || null,
      customer_name: input.customer_name?.trim() || null, location_id: main,
      subtotal, discount, tax, total, cogs_total: cogsTotal, profit, cashier_id: user.id,
    })
    .select("id, receipt_no").single();
  if (sErr) return { error: sErr.message };
  const saleId = sale.id as string;

  await db.from("sale_items").insert(
    items.map((it) => ({
      sale_id: saleId, product_id: it.product_id, variant_id: it.variant_id,
      qty: it.qty, unit_price: it.unit_price, unit_cogs: it.unit_cogs, line_total: it.line_total,
    })),
  );

  // Every line yields exactly one MAIN->CUST move (stock leaves the shop, so the
  // apply_stock_move trigger decrements on_hand), always fully linked. See
  // buildSaleMoves for the guarded invariants + its regression tests.
  const moves = buildSaleMoves(items, {
    mainLocationId: main, custLocationId: cust, saleId,
    idempotencyKey: input.idempotency_key, userId: user.id,
  });
  const { error: mErr } = await db.from("stock_moves").insert(moves);
  if (mErr) {
    // The stock guard (or any move failure) rejected the sale — undo the header
    // so no orphan sale/items/payments remain (sale_items & payments cascade).
    await db.from("sales").delete().eq("id", saleId);
    return { error: mErr.message.includes("Insufficient stock") ? "Not enough stock to complete this sale." : mErr.message };
  }

  await db.from("payments").insert(
    input.payments
      .filter((p) => Number(p.amount) > 0)
      .map((p) => ({ sale_id: saleId, method: p.method, amount: Number(p.amount) })),
  );

  // Any udhaar portion goes on the customer's khata.
  if (hasUdhaar && input.customer_id) {
    const udhaar = input.payments.filter((p) => p.method === "UDHAAR").reduce((s, p) => s + Number(p.amount), 0);
    if (udhaar > 0) {
      const { data: c } = await db.from("customers").select("credit_balance").eq("id", input.customer_id).single();
      const newBal = Number(c?.credit_balance ?? 0) + udhaar;
      await db.from("customer_ledger").insert({
        customer_id: input.customer_id, type: "CHARGE", amount: udhaar,
        reference: `Sale ${receiptNo}`, balance_after: newBal, created_by: user.id,
      });
      await db.from("customers").update({ credit_balance: newBal }).eq("id", input.customer_id);
    }
  }

  // Record which promotions applied (usage tracking + profit after discount).
  if (promo.applied.length) await recordRedemptions(db, promo.applied, { channel: "POS", sale_id: saleId, profit });

  revalidatePath("/admin/stock");
  revalidatePath("/admin/products");
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/discounts");
  revalidatePath("/admin/reports");
  return {
    ok: true, sale_id: saleId, receipt_no: sale.receipt_no, subtotal, discount, tax, total, profit,
    payments: input.payments,
  };
}
