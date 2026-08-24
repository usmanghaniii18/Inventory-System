"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@hamza/shared/supabase/admin";
import { getCurrentUser } from "@hamza/shared/auth";
import { stockInSchema, adjustSchema, transferSchema, cycleCountSchema, firstIssue } from "@hamza/shared/validation";

type Db = ReturnType<typeof createAdminClient>;

async function requireManager() {
  const user = await getCurrentUser();
  if (!user || (user.role !== "owner" && user.role !== "manager")) return null;
  return user;
}

async function locationIds(db: Db) {
  const { data } = await db.from("locations").select("id, code");
  return new Map((data ?? []).map((l) => [l.code, l.id as string]));
}

/** Resolve (or create) a lot for a variant, returning its id. */
async function resolveLot(db: Db, variantId: string, productId: string, lot?: string | null, expiry?: string | null) {
  if (!lot) return null;
  const { data: existing } = await db
    .from("lots").select("id").eq("product_id", productId).eq("lot_number", lot).maybeSingle();
  if (existing?.id) return existing.id as string;
  const { data: created } = await db
    .from("lots")
    .insert({ product_id: productId, variant_id: variantId, lot_number: lot, expiry_date: expiry || null })
    .select("id").single();
  return (created?.id as string) ?? null;
}

async function logAudit(db: Db, actor: string, action: string, variantId: string, detail: unknown) {
  await db.from("audit_log").insert({
    actor, action, entity: "product_variants", entity_id: variantId, after: detail as never,
  });
}

function done() {
  revalidatePath("/admin/stock");
  revalidatePath("/admin/products");
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/reports");
  return { ok: true as const };
}

/* ---------------- Stock In (manual receipt, outside a PO) ---------------- */
export async function stockIn(input: {
  variant_id: string;
  product_id: string;
  qty: number;
  unit_cost: number;
  location_code?: string;
  lot_number?: string | null;
  expiry?: string | null;
  source?: "MANUAL" | "SCAN";
  note?: string;
}) {
  const user = await requireManager();
  if (!user) return { error: "Not authorized." };
  const v = stockInSchema.safeParse(input);
  if (!v.success) return { error: firstIssue(v.error) };

  const db = createAdminClient();
  const locs = await locationIds(db);
  const sup = locs.get("SUP");
  const dest = locs.get(input.location_code ?? "MAIN");
  if (!sup || !dest) return { error: "Locations not configured." };

  const lotId = await resolveLot(db, input.variant_id, input.product_id, input.lot_number, input.expiry);

  const { error } = await db.from("stock_moves").insert({
    product_id: input.product_id,
    variant_id: input.variant_id,
    lot_id: lotId,
    qty: input.qty,
    from_location_id: sup,
    to_location_id: dest,
    unit_cost: input.unit_cost ?? 0,
    reference_type: "PURCHASE",
    source: input.source ?? "MANUAL",
    created_by: user.id,
    note: input.note ?? "Manual stock-in",
  });
  if (error) return { error: error.message };
  await logAudit(db, user.id, "stock_in", input.variant_id, { qty: input.qty, unit_cost: input.unit_cost });
  return done();
}

/* ---------------- Adjustment (damage / loss / found) ---------------- */
export async function adjustStock(input: {
  variant_id: string;
  product_id: string;
  direction: "add" | "remove";
  qty: number;
  reason: string;
  unit_cost?: number | null;
  location_code?: string;
}) {
  const user = await requireManager();
  if (!user) return { error: "Not authorized." };
  const v = adjustSchema.safeParse(input);
  if (!v.success) return { error: firstIssue(v.error) };

  const db = createAdminClient();
  const locs = await locationIds(db);
  const loc = locs.get(input.location_code ?? "MAIN");
  const adj = locs.get("ADJ");
  const loss = locs.get("LOSS");
  if (!loc || !adj || !loss) return { error: "Locations not configured." };

  const move = input.direction === "add"
    ? { from_location_id: adj, to_location_id: loc }
    : { from_location_id: loc, to_location_id: loss };

  const { error } = await db.from("stock_moves").insert({
    product_id: input.product_id,
    variant_id: input.variant_id,
    qty: input.qty,
    ...move,
    unit_cost: input.direction === "add" ? (input.unit_cost ?? 0) : null,
    reference_type: "ADJUSTMENT",
    source: "MANUAL",
    created_by: user.id,
    note: input.reason,
  });
  if (error) return { error: error.message };
  await logAudit(db, user.id, "stock_adjustment", input.variant_id, { direction: input.direction, qty: input.qty, reason: input.reason });
  return done();
}

/* ---------------- Transfer (between physical locations) ---------------- */
export async function transferStock(input: {
  variant_id: string;
  product_id: string;
  qty: number;
  from_code: string;
  to_code: string;
  unit_cost?: number | null;
}) {
  const user = await requireManager();
  if (!user) return { error: "Not authorized." };
  const v = transferSchema.safeParse(input);
  if (!v.success) return { error: firstIssue(v.error) };
  if (input.from_code === input.to_code) return { error: "Pick two different locations." };

  const db = createAdminClient();
  const locs = await locationIds(db);
  const from = locs.get(input.from_code);
  const to = locs.get(input.to_code);
  if (!from || !to) return { error: "Locations not configured." };

  const { error } = await db.from("stock_moves").insert({
    product_id: input.product_id,
    variant_id: input.variant_id,
    qty: input.qty,
    from_location_id: from,
    to_location_id: to,
    unit_cost: input.unit_cost ?? 0, // carry source cost so destination avg stays correct
    reference_type: "TRANSFER",
    source: "MANUAL",
    created_by: user.id,
    note: `Transfer ${input.from_code} → ${input.to_code}`,
  });
  if (error) return { error: error.message };
  await logAudit(db, user.id, "stock_transfer", input.variant_id, { qty: input.qty, from: input.from_code, to: input.to_code });
  return done();
}

/* ---------------- Cycle count (set counted qty -> correcting move) -------- */
export async function cycleCount(input: {
  variant_id: string;
  product_id: string;
  counted_qty: number;
  current_qty: number;
  unit_cost?: number | null;
  location_code?: string;
}) {
  const user = await requireManager();
  if (!user) return { error: "Not authorized." };
  const v = cycleCountSchema.safeParse(input);
  if (!v.success) return { error: firstIssue(v.error) };

  const diff = input.counted_qty - input.current_qty;
  if (diff === 0) return { error: "Counted quantity matches the system — no move needed." };

  const db = createAdminClient();
  const locs = await locationIds(db);
  const loc = locs.get(input.location_code ?? "MAIN");
  const adj = locs.get("ADJ");
  if (!loc || !adj) return { error: "Locations not configured." };

  const move = diff > 0
    ? { from_location_id: adj, to_location_id: loc }
    : { from_location_id: loc, to_location_id: adj };

  const { error } = await db.from("stock_moves").insert({
    product_id: input.product_id,
    variant_id: input.variant_id,
    qty: Math.abs(diff),
    ...move,
    unit_cost: diff > 0 ? (input.unit_cost ?? 0) : null,
    reference_type: "COUNT",
    source: "MANUAL",
    created_by: user.id,
    note: `Cycle count: counted ${input.counted_qty}, system ${input.current_qty} (${diff > 0 ? "+" : ""}${diff})`,
  });
  if (error) return { error: error.message };
  await logAudit(db, user.id, "cycle_count", input.variant_id, { counted: input.counted_qty, system: input.current_qty, diff });
  return done();
}

/* ---------------- Movement history (per variant) ---------------- */
export interface MoveRow {
  id: number;
  qty: number;
  unit_cost: number | null;
  reference_type: string;
  source: string;
  note: string | null;
  created_at: string;
  from_code: string | null;
  to_code: string | null;
  actor: string | null;
  direction: "in" | "out" | "move";
}

export async function getMovementHistory(variantId: string): Promise<MoveRow[]> {
  const db = createAdminClient();
  const { data } = await db
    .from("stock_moves")
    .select("id, qty, unit_cost, reference_type, source, note, created_at, from_location_id, to_location_id, created_by")
    .eq("variant_id", variantId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (!data?.length) return [];

  const locs = await (async () => {
    const { data: l } = await db.from("locations").select("id, code, type");
    return new Map((l ?? []).map((x) => [x.id, x]));
  })();
  const actorIds = [...new Set(data.map((m) => m.created_by).filter(Boolean))] as string[];
  const { data: profiles } = actorIds.length
    ? await db.from("profiles").select("id, full_name").in("id", actorIds)
    : { data: [] as { id: string; full_name: string }[] };
  const actorName = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));

  return data.map((m) => {
    const from = m.from_location_id ? locs.get(m.from_location_id) : null;
    const to = m.to_location_id ? locs.get(m.to_location_id) : null;
    const toPhysical = to?.type === "PHYSICAL";
    const fromPhysical = from?.type === "PHYSICAL";
    const direction: MoveRow["direction"] =
      toPhysical && fromPhysical ? "move" : toPhysical ? "in" : "out";
    return {
      id: m.id,
      qty: Number(m.qty),
      unit_cost: m.unit_cost != null ? Number(m.unit_cost) : null,
      reference_type: m.reference_type,
      source: m.source,
      note: m.note,
      created_at: m.created_at,
      from_code: from?.code ?? null,
      to_code: to?.code ?? null,
      actor: m.created_by ? (actorName.get(m.created_by) ?? null) : null,
      direction,
    };
  });
}
