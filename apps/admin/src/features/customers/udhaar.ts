"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@hamza/shared/supabase/admin";
import { getCurrentUser } from "@hamza/shared/auth";

/**
 * PHASE G — full itemised udhaar (khata) history.
 *
 * How credit sales are linked today
 * --------------------------------
 * A udhaar sale already records EVERYTHING needed: the invoice lives in
 * `sales` + `sale_items` (product, qty, unit price, per-line discount, line
 * total, bill subtotal/discount/tax/total), and the credit charge is appended to
 * `customer_ledger` as a CHARGE row whose running total is `balance_after`.
 *
 * What was missing was only the JOIN: `customer_ledger` has no `sale_id`, just a
 * text `reference` of the form "Sale <receipt_no>", so the Khata drawer had
 * nothing to show but amounts — hence "only a running total per customer".
 *
 * Rather than start duplicating invoice data into a second table, this module
 * resolves that text reference back to the real invoice and reads the items
 * straight from `sale_items`. No schema change and no migration is needed: the
 * ledger stays the authority for the balance, the sale stays the authority for
 * what was bought, and the two are joined at read time.
 */

export interface UdhaarLineItem {
  name: string;
  label: string;
  qty: number;
  unit: string | null;
  unit_price: number;
  /** Per-line discount in rupees, as recorded on the sale. */
  discount: number;
  /** Line total after its own discount — what this line contributed. */
  line_total: number;
}

export interface UdhaarEntry {
  /** CHARGE = took goods on credit; PAYMENT = repaid (or a return credit). */
  kind: "CHARGE" | "PAYMENT";
  /** Ledger row id — the unit an admin can delete. Null for an unledgered sale. */
  ledger_id: string | null;
  sale_id: string | null;
  receipt_no: string | null;
  /** ISO timestamp of the transaction. */
  date: string;
  /** Amount put on (CHARGE) or taken off (PAYMENT) the khata. */
  amount: number;
  reference: string | null;
  /** Running total as recorded at the time. */
  balance_after: number;
  /** The actual products bought on this occasion (CHARGE entries only). */
  items: UdhaarLineItem[];
  /** That invoice's own figures, when this entry resolves to a sale. */
  bill_subtotal: number;
  bill_discount: number;
  bill_total: number;
  /** True when this credit sale has no ledger row (data anomaly, shown read-only). */
  orphan?: boolean;
}

export interface UdhaarHistory {
  customer: { id: string; name: string; phone: string | null; credit_limit: number; credit_balance: number };
  entries: UdhaarEntry[];
  /** Σ CHARGE − Σ PAYMENT across the entries shown, for a consistency check. */
  computed_balance: number;
}

async function requireManager() {
  const user = await getCurrentUser();
  if (!user || (user.role !== "owner" && user.role !== "manager")) return null;
  return user;
}

/** Pull the receipt number out of a ledger reference like "Sale INV-12345678". */
function receiptOf(reference: string | null): string | null {
  if (!reference) return null;
  const m = /^(?:Sale|Return)\s+(\S+)/.exec(reference.trim());
  return m ? m[1] : null;
}

/** Every dated credit transaction for one customer, with its real invoice. */
export async function getCustomerUdhaarHistory(customerId: string): Promise<UdhaarHistory | { error: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: "Not authorized." };
  const db = createAdminClient();

  const { data: customer } = await db
    .from("customers").select("id, name, phone, credit_limit, credit_balance")
    .eq("id", customerId).maybeSingle();
  if (!customer) return { error: "Customer not found." };

  const { data: ledger } = await db
    .from("customer_ledger")
    .select("id, type, amount, reference, balance_after, created_at")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false });

  // Resolve every referenced receipt to its sale in one round-trip.
  const receiptNos = [...new Set((ledger ?? []).map((l) => receiptOf(l.reference as string | null)).filter(Boolean))] as string[];

  // Also catch any credit sale that never produced a ledger row, so the history
  // can never silently omit goods the customer actually took.
  const { data: creditSales } = await db
    .from("sales")
    .select("id, receipt_no, created_at, subtotal, discount, tax, total, payments!inner(method, amount)")
    .eq("customer_id", customerId)
    .eq("payments.method", "UDHAAR");

  const allReceipts = [...new Set([...receiptNos, ...(creditSales ?? []).map((s) => s.receipt_no as string)])];

  const { data: sales } = allReceipts.length
    ? await db.from("sales").select("id, receipt_no, created_at, subtotal, discount, tax, total").in("receipt_no", allReceipts)
    : { data: [] as Record<string, unknown>[] };
  const saleByReceipt = new Map((sales ?? []).map((s) => [s.receipt_no as string, s]));
  const saleIds = (sales ?? []).map((s) => s.id as string);

  const { data: items } = saleIds.length
    ? await db.from("sale_items").select("sale_id, variant_id, qty, unit_price, line_total").in("sale_id", saleIds)
    : { data: [] as Record<string, unknown>[] };

  // Names resolve from the FULL catalogue index (archived products included) so
  // a historical khata line never renders blank after an item is archived.
  const variantIds = [...new Set((items ?? []).map((i) => i.variant_id).filter(Boolean))] as string[];
  const { data: cat } = variantIds.length
    ? await db.from("catalog_index").select("variant_id, product_name, label, unit").in("variant_id", variantIds)
    : { data: [] as Record<string, unknown>[] };
  const nameOf = new Map((cat ?? []).map((c) => [c.variant_id as string, c]));

  const itemsBySale = new Map<string, UdhaarLineItem[]>();
  for (const it of items ?? []) {
    const c = it.variant_id ? nameOf.get(it.variant_id as string) : undefined;
    const qty = Number(it.qty);
    const unitPrice = Number(it.unit_price);
    const lineTotal = Number(it.line_total);
    const arr = itemsBySale.get(it.sale_id as string) ?? [];
    arr.push({
      name: (c?.product_name as string) ?? "Item",
      label: ((c?.label as string) ?? "") === "Default" ? "" : ((c?.label as string) ?? ""),
      qty,
      unit: (c?.unit as string) ?? null,
      unit_price: unitPrice,
      // sale_items.line_total is already net of the line's own discount, so the
      // discount that was given is exactly the difference from the gross.
      discount: Math.round((qty * unitPrice - lineTotal) * 100) / 100,
      line_total: lineTotal,
    });
    itemsBySale.set(it.sale_id as string, arr);
  }

  const entries: UdhaarEntry[] = [];
  const seenReceipts = new Set<string>();

  for (const l of ledger ?? []) {
    const receiptNo = receiptOf(l.reference as string | null);
    const sale = receiptNo ? saleByReceipt.get(receiptNo) : undefined;
    const saleId = sale ? (sale.id as string) : null;
    if (receiptNo && l.type === "CHARGE") seenReceipts.add(receiptNo);
    entries.push({
      kind: l.type === "PAYMENT" ? "PAYMENT" : "CHARGE",
      ledger_id: l.id as string,
      sale_id: saleId,
      receipt_no: receiptNo,
      date: l.created_at as string,
      amount: Number(l.amount),
      reference: (l.reference as string) ?? null,
      balance_after: Number(l.balance_after),
      items: l.type === "CHARGE" && saleId ? (itemsBySale.get(saleId) ?? []) : [],
      bill_subtotal: sale ? Number(sale.subtotal) : 0,
      bill_discount: sale ? Number(sale.discount) : 0,
      bill_total: sale ? Number(sale.total) : 0,
    });
  }

  for (const s of creditSales ?? []) {
    const receiptNo = s.receipt_no as string;
    if (seenReceipts.has(receiptNo)) continue;
    const pays = (s.payments as { method: string; amount: number }[] | null) ?? [];
    const udhaar = pays.filter((p) => p.method === "UDHAAR").reduce((t, p) => t + Number(p.amount), 0);
    entries.push({
      kind: "CHARGE",
      ledger_id: null,
      sale_id: s.id as string,
      receipt_no: receiptNo,
      date: s.created_at as string,
      amount: udhaar,
      reference: `Sale ${receiptNo}`,
      balance_after: 0,
      items: itemsBySale.get(s.id as string) ?? [],
      bill_subtotal: Number(s.subtotal),
      bill_discount: Number(s.discount),
      bill_total: Number(s.total),
      orphan: true,
    });
  }

  entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const computed = entries.reduce((t, e) => t + (e.kind === "CHARGE" ? e.amount : -e.amount), 0);

  return {
    customer: {
      id: customer.id as string,
      name: customer.name as string,
      phone: (customer.phone as string) ?? null,
      credit_limit: Number(customer.credit_limit),
      credit_balance: Number(customer.credit_balance),
    },
    entries,
    computed_balance: Math.round(computed * 100) / 100,
  };
}

/**
 * Delete ONE khata entry and correct the running total.
 *
 * Deleting a CHARGE removes that credit from what the customer owes; deleting a
 * PAYMENT puts the repayment back on. Every later row's running total is shifted
 * by the same delta so the history stays readable top to bottom.
 *
 * The SALE ITSELF IS NEVER TOUCHED. Stock movements, revenue, profit and every
 * report keep the transaction exactly as it happened — this only unwinds the
 * credit side of it, which is what "remove this from the khata" means.
 */
export async function deleteUdhaarEntry(ledgerId: string): Promise<{ ok: true; balance: number } | { error: string }> {
  const user = await requireManager();
  if (!user) return { error: "Only an owner or manager can change khata records." };
  const db = createAdminClient();

  const { data: row } = await db
    .from("customer_ledger").select("id, customer_id, type, amount, created_at").eq("id", ledgerId).maybeSingle();
  if (!row) return { error: "That entry no longer exists." };

  const customerId = row.customer_id as string;
  const amount = Number(row.amount);
  // Removing a charge reduces the balance; removing a payment restores it.
  const delta = row.type === "PAYMENT" ? amount : -amount;

  const { data: cust } = await db.from("customers").select("credit_balance").eq("id", customerId).single();
  const newBalance = Math.round((Number(cust?.credit_balance ?? 0) + delta) * 100) / 100;

  const { error: delErr } = await db.from("customer_ledger").delete().eq("id", ledgerId);
  if (delErr) return { error: delErr.message };

  // Shift the running total on every entry recorded after this one.
  const { data: later } = await db
    .from("customer_ledger").select("id, balance_after")
    .eq("customer_id", customerId).gt("created_at", row.created_at as string);
  for (const l of later ?? []) {
    await db.from("customer_ledger")
      .update({ balance_after: Math.round((Number(l.balance_after) + delta) * 100) / 100 })
      .eq("id", l.id);
  }

  await db.from("customers").update({ credit_balance: newBalance }).eq("id", customerId);
  revalidatePath("/admin/customers");
  revalidatePath("/admin/dashboard");
  return { ok: true, balance: newBalance };
}

/** Rename a customer (the name shown on their udhaar record). */
export async function renameCustomer(customerId: string, name: string): Promise<{ ok: true; name: string } | { error: string }> {
  const user = await requireManager();
  if (!user) return { error: "Only an owner or manager can rename a customer." };
  const clean = name.trim();
  if (!clean) return { error: "Name can’t be empty." };
  const db = createAdminClient();
  const { error } = await db.from("customers").update({ name: clean }).eq("id", customerId);
  if (error) return { error: error.message };
  revalidatePath("/admin/customers");
  return { ok: true, name: clean };
}

/**
 * Wipe a customer's udhaar record: every khata entry is removed and the balance
 * is reset to zero. Requires the customer's name to be typed back, because this
 * erases financial history and cannot be undone.
 *
 * Their SALES are left completely intact — this clears the credit ledger only,
 * so revenue, profit, stock and every report are unaffected.
 */
export async function clearCustomerUdhaar(customerId: string, confirmName: string): Promise<{ ok: true; removed: number } | { error: string }> {
  const user = await requireManager();
  if (!user) return { error: "Only an owner or manager can clear a khata." };
  const db = createAdminClient();

  const { data: customer } = await db.from("customers").select("id, name").eq("id", customerId).maybeSingle();
  if (!customer) return { error: "Customer not found." };
  if (confirmName.trim() !== (customer.name as string).trim()) {
    return { error: "The name you typed doesn’t match — nothing was deleted." };
  }

  const { count } = await db
    .from("customer_ledger").select("id", { count: "exact", head: true }).eq("customer_id", customerId);
  const { error } = await db.from("customer_ledger").delete().eq("customer_id", customerId);
  if (error) return { error: error.message };
  await db.from("customers").update({ credit_balance: 0 }).eq("id", customerId);

  revalidatePath("/admin/customers");
  revalidatePath("/admin/dashboard");
  return { ok: true, removed: count ?? 0 };
}

/**
 * Permanently delete a customer — only when they have no transaction history,
 * so no sale, order or khata entry is ever orphaned. Otherwise the caller is
 * told to clear the khata instead.
 */
export async function deleteCustomer(customerId: string, confirmName: string): Promise<{ ok: true } | { error: string; hasHistory?: true }> {
  const user = await requireManager();
  if (!user) return { error: "Only an owner or manager can delete a customer." };
  const db = createAdminClient();

  const { data: customer } = await db.from("customers").select("id, name").eq("id", customerId).maybeSingle();
  if (!customer) return { error: "Customer not found." };
  if (confirmName.trim() !== (customer.name as string).trim()) {
    return { error: "The name you typed doesn’t match — nothing was deleted." };
  }

  const head = { count: "exact" as const, head: true };
  const [salesRes, ordersRes] = await Promise.all([
    db.from("sales").select("id", head).eq("customer_id", customerId),
    db.from("orders").select("id", head).eq("customer_id", customerId),
  ]);
  if ((salesRes.count ?? 0) + (ordersRes.count ?? 0) > 0) {
    return {
      error: "This customer has sales history, so deleting them would break your reports. Clear their khata instead.",
      hasHistory: true,
    };
  }

  const { error } = await db.from("customers").delete().eq("id", customerId);
  if (error) return { error: error.message };
  revalidatePath("/admin/customers");
  return { ok: true };
}
