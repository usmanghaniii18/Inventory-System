"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@hamza/shared/supabase/admin";
import { createClient } from "@hamza/shared/supabase/server";
import { getCurrentUser } from "@hamza/shared/auth";
import { fetchProductsPage, fetchAllProducts, type ProductsQuery, type ProductsPage, type ProductRow } from "@/lib/products-query";
import { generateInternalEan13, generateWeightTemplateEan13 } from "@/lib/barcode";
import { productInputSchema, variantPatchSchema, importRowsSchema, firstIssue } from "@hamza/shared/validation";
import type { ParsedProductRow } from "@/lib/csv";
import { productSlug } from "@/lib/product-slug";

/**
 * Server-side paginated + filtered product search. Powers the Products list's
 * debounced search and "load more" — only one page (+ its related rows) crosses
 * the wire, never the whole table.
 */
export async function searchProducts(params: ProductsQuery): Promise<ProductsPage> {
  const supabase = await createClient();
  return fetchProductsPage(supabase, params);
}

/**
 * Full (optionally filtered) product set for export — pages through the ENTIRE
 * catalogue server-side so the export never stops at PostgREST's 1000-row cap
 * (loads up to 15,000+ products with nothing dropped).
 */
export async function searchAllProducts(params: Pick<ProductsQuery, "q" | "categoryId" | "categoryIds">): Promise<{ rows: ProductRow[] }> {
  const supabase = await createClient();
  return { rows: await fetchAllProducts(supabase, params) };
}

async function requireManager() {
  const user = await getCurrentUser();
  if (!user || (user.role !== "owner" && user.role !== "manager")) return null;
  return user;
}

async function requireOwner() {
  const user = await getCurrentUser();
  if (!user || user.role !== "owner") return null;
  return user;
}

/** Archive (deactivate) or restore a product — the everyday soft-delete path. */
export async function setProductActive(productId: string, active: boolean) {
  if (!(await requireManager())) return { error: "Not authorized." };
  const db = createAdminClient();
  const { error } = await db.from("products").update({ active }).eq("id", productId);
  if (error) return { error: error.message };
  revalidatePath("/admin/products");
  revalidatePath("/admin/stock");
  return { ok: true as const };
}

/**
 * Permanently delete a product — owner only, and only when it has NO transaction
 * history (so historical reports stay correct). Requires the typed name to match.
 * Child rows (variants, barcodes, options, listing) cascade automatically.
 */
export async function permanentlyDeleteProduct(productId: string, confirmName: string) {
  if (!(await requireOwner())) return { error: "Only the owner can permanently delete products." };
  const db = createAdminClient();

  const { data: product } = await db.from("products").select("id, name").eq("id", productId).maybeSingle();
  if (!product) return { error: "Product not found." };
  if (confirmName.trim() !== (product.name as string).trim()) {
    return { error: "The name you typed doesn’t match — nothing was deleted." };
  }

  // Block if the product appears in any ledger / sale / order / reservation / PO.
  const head = { count: "exact" as const, head: true };
  const checks = await Promise.all([
    db.from("stock_moves").select("id", head).eq("product_id", productId),
    db.from("sale_items").select("id", head).eq("product_id", productId),
    db.from("order_items").select("id", head).eq("product_id", productId),
    db.from("reservations").select("id", head).eq("product_id", productId),
    db.from("purchase_order_items").select("id", head).eq("product_id", productId),
    db.from("goods_receipt_items").select("id", head).eq("product_id", productId),
  ]);
  const historyCount = checks.reduce((s, c) => s + (c.count ?? 0), 0);
  if (historyCount > 0) {
    return { error: "This product has transaction history, so it can’t be permanently deleted. Archive it instead to keep your reports accurate.", hasHistory: true as const };
  }

  // Defensive: clear any (orphan) stock_levels rows, which don't cascade.
  const { data: variants } = await db.from("product_variants").select("id").eq("product_id", productId);
  const variantIds = (variants ?? []).map((v) => v.id);
  if (variantIds.length) await db.from("stock_levels").delete().in("variant_id", variantIds);
  await db.from("stock_levels").delete().eq("product_id", productId);

  const { error } = await db.from("products").delete().eq("id", productId);
  if (error) return { error: error.message };

  revalidatePath("/admin/products");
  revalidatePath("/admin/stock");
  return { ok: true as const };
}

export interface VariantInput {
  sku: string;
  barcode?: string | null;
  sale_price: number;
  cost: number;
  reorder_point: number;
  /** Product's default discount (Part 2). */
  default_discount_type?: "PERCENT" | "FIXED" | null;
  default_discount_value?: number;
  opening_qty?: number | null;
  /** Selected option values, one per option in declared order (e.g. ["Ruby Red","3.5g"]). */
  option_values: string[];
}

export interface ProductInput {
  name: string;
  brand?: string | null;
  category_id?: string | null;
  description?: string | null;
  base_unit?: string;
  base_price: number;
  has_variants: boolean;
  /** Ordered option definitions; empty when the product has no variants. */
  options: { name: string; values: string[] }[];
  variants: VariantInput[];
}

/**
 * Give every variant of a JUST-CREATED product a scannable internal barcode
 * when none was typed in.
 *
 * Why: `create_product_full` only writes a product_barcodes row when the form
 * supplied a barcode, so a product added without one had NO barcode at all
 * until somebody remembered to open Products → Label → "Generate internal
 * barcode". That easily-missed manual step is why items were turning up at the
 * till with nothing to scan. New products now leave the Add form scannable.
 *
 * The generated value is a GS1 prefix-2 EAN-13 built from a database sequence —
 * fixed 13 digits, unique, and completely independent of the product's name, so
 * a one-letter name and a forty-letter name produce identically sized symbols.
 *
 * SAFETY: this only ever INSERTS a barcode for a variant that has none. It
 * never reads, rewrites or regenerates an existing product_barcodes row, so no
 * sticker already on a shelf can be invalidated by it.
 */
async function ensureVariantBarcodes(
  db: ReturnType<typeof createAdminClient>,
  productId: string,
  variableWeight = false,
): Promise<void> {
  const { data: variants } = await db
    .from("product_variants").select("id").eq("product_id", productId);
  const ids = (variants ?? []).map((v) => v.id as string);
  if (!ids.length) return;

  const { data: existing } = await db
    .from("product_barcodes").select("variant_id").in("variant_id", ids);
  const have = new Set((existing ?? []).map((b) => b.variant_id as string));
  const missing = ids.filter((id) => !have.has(id));
  if (!missing.length) return;

  // One INSERT per variant, retried past a collision.
  //
  // This used to build every row and insert them as a single statement whose
  // error was discarded. Postgres rejects the WHOLE statement on one unique
  // violation, so a single colliding code left EVERY variant of the product
  // with no barcode at all — silently. That is one of the ways items reached
  // the till with a sticker that scanned as nothing. Per-row inserts mean one
  // bad draw can only ever cost the variant it belongs to, and the retry draws
  // a fresh sequence value instead of giving up.
  for (const variantId of missing) {
    for (let attempt = 0; attempt < BARCODE_ASSIGN_RETRIES; attempt++) {
      const { data: seq, error: seqErr } = await db.rpc("next_internal_barcode");
      if (seqErr) return; // sequence unavailable — leave it to the Label dialog
      let barcode: string;
      try {
        const n = Number(seq);
        barcode = variableWeight ? generateWeightTemplateEan13(n) : generateInternalEan13(n);
      } catch {
        return; // sequence has outgrown the code format — the Label dialog reports it
      }
      const { error } = await db.from("product_barcodes").insert({
        product_id: productId, variant_id: variantId, barcode, type: "INTERNAL", is_primary: true,
      });
      if (!error) break;
      if (!isUniqueViolation(error)) break; // a real failure — a barcode is never worth failing the product over
    }
  }
}

/**
 * Create a product as a parent grouping plus one or more variants.
 * Stock is posted per-variant through the append-only ledger.
 */
export async function createProduct(input: ProductInput) {
  const user = await requireManager();
  if (!user) return { error: "Not authorized." };
  const parsed = productInputSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const db = createAdminClient();

  // One transactional round-trip: product + listing + options/values + variants +
  // barcodes + option links + opening stock (was up to ~35 sequential calls).
  const payload = {
    ...input,
    slug: productSlug(input.name, input.variants[0].sku),
    created_by: user.id,
  };
  const { data, error } = await db.rpc("create_product_full", { payload });
  if (error) {
    const msg = error.message.includes("duplicate key")
      ? error.message.includes("barcode") ? "That barcode is already used by another product."
        : "That SKU is already used by another product."
      : error.message;
    return { error: msg };
  }

  // Phase D — a new product leaves this form scannable, no second manual step.
  await ensureVariantBarcodes(db, data as string);

  revalidatePath("/admin/products");
  revalidatePath("/admin/stock");
  return { ok: true, id: data as string };
}

/** Update the parent product's descriptive fields. */
export async function updateProduct(
  id: string,
  input: { name?: string; brand?: string | null; category_id?: string | null; description?: string | null; base_unit?: string; active?: boolean },
) {
  if (!(await requireManager())) return { error: "Not authorized." };
  const db = createAdminClient();
  const { error } = await db
    .from("products")
    .update({
      name: input.name,
      brand: input.brand ?? null,
      category_id: input.category_id || null,
      description: input.description ?? null,
      ...(input.base_unit ? { base_unit: input.base_unit } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    })
    .eq("id", id);
  if (error) return { error: error.message };
  revalidateProductSurfaces();
  return { ok: true };
}

/** Edits to a product/variant should show up everywhere it's sold or listed. */
function revalidateProductSurfaces() {
  revalidatePath("/admin/products");
  revalidatePath("/admin/stock");
  revalidatePath("/admin/pos");
  revalidatePath("/admin/dashboard");
  revalidatePath("/shop");
}

/** Update a single variant's SKU / barcode / pricing / reorder / active flag. */
export async function updateVariant(
  id: string,
  input: {
    sku?: string; barcode?: string | null; sale_price?: number; cost?: number; reorder_point?: number;
    default_discount_type?: "PERCENT" | "FIXED" | null; default_discount_value?: number; active?: boolean;
  },
) {
  if (!(await requireManager())) return { error: "Not authorized." };
  const { sku, barcode, ...rest } = input;
  const v = variantPatchSchema.safeParse(rest);
  if (!v.success) return { error: firstIssue(v.error) };
  const db = createAdminClient();

  // Cost is NEVER changed through the normal save — it only moves via purchases
  // (the weighted-average ledger) or the audited correctVariantCost() flow, so a
  // routine edit can't silently desync avg_cost or skip the owner gate.
  const patch: Record<string, unknown> = { ...rest };
  delete patch.cost;
  if (sku !== undefined && sku.trim()) patch.sku = sku.trim();
  const { error } = await db.from("product_variants").update(patch).eq("id", id);
  if (error) {
    return { error: error.message.includes("duplicate") ? "That SKU is already used by another variant." : error.message };
  }

  // Barcode: update the variant's primary barcode (insert if it has none).
  if (barcode !== undefined) {
    const code = (barcode ?? "").trim();
    const { data: variant } = await db.from("product_variants").select("product_id").eq("id", id).maybeSingle();
    const { data: existing } = await db.from("product_barcodes").select("id").eq("variant_id", id).eq("is_primary", true).maybeSingle();
    if (code) {
      if (existing) {
        const { error: bErr } = await db.from("product_barcodes").update({ barcode: code }).eq("id", existing.id);
        if (bErr) return { error: bErr.message.includes("duplicate") ? "That barcode is already used elsewhere." : bErr.message };
      } else if (variant) {
        const { error: bErr } = await db.from("product_barcodes").insert({ product_id: variant.product_id, variant_id: id, barcode: code, type: "EAN", is_primary: true });
        if (bErr) return { error: bErr.message.includes("duplicate") ? "That barcode is already used elsewhere." : bErr.message };
      }
    } else if (existing) {
      await db.from("product_barcodes").delete().eq("id", existing.id);
    }
  }

  revalidateProductSurfaces();
  return { ok: true };
}

// ---- Correct a wrongly-entered cost price --------------------------------
// Weighted-average cost normally comes from purchases and isn't editable. This
// is the controlled exception for fixing a data-entry mistake. See migration
// 0029: it updates the forward cost numbers (variant.cost + stock_levels.avg_cost)
// and records an audit row, WITHOUT changing any past sale's snapshotted profit.

export interface VariantCostContext {
  /** True once the variant has any non-OPENING movement (sales/purchases/etc.) —
   *  this is "Case B" and the correction becomes owner-only. */
  hasHistory: boolean;
  /** Static cost on the variant row (drives inventory valuation). */
  cost: number;
  /** Live weighted-average across physical stock (drives future POS COGS). */
  avgCost: number;
  onHand: number;
  lastCorrection: { new_cost: number; reason: string | null; created_at: string } | null;
}

/** Read the cost context so the UI can show current figures and decide Case A vs B. */
export async function getVariantCostContext(
  variantId: string,
): Promise<{ error: string } | ({ ok: true } & VariantCostContext)> {
  if (!(await requireManager())) return { error: "Not authorized." };
  const db = createAdminClient();
  const [{ data: hist }, { data: v }, { data: av }, { data: last }] = await Promise.all([
    db.from("stock_moves").select("id").eq("variant_id", variantId).neq("reference_type", "OPENING").limit(1),
    db.from("product_variants").select("cost").eq("id", variantId).maybeSingle(),
    db.from("variant_availability").select("avg_cost, on_hand").eq("variant_id", variantId).maybeSingle(),
    db.from("cost_corrections").select("new_cost, reason, created_at").eq("variant_id", variantId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  return {
    ok: true as const,
    hasHistory: (hist ?? []).length > 0,
    cost: Number(v?.cost ?? 0),
    avgCost: Number(av?.avg_cost ?? 0),
    onHand: Number(av?.on_hand ?? 0),
    lastCorrection: last ?? null,
  };
}

/**
 * Correct a variant's cost price.
 *  - Case A (no sales/purchase history): owner OR manager may fix the initial cost.
 *  - Case B (history exists): OWNER ONLY, and a reason is required.
 * Past completed sales keep their original recorded profit (snapshotted COGS) —
 * only the forward cost (valuation + future COGS) is corrected. Authoritative
 * history/role checks happen here, not in the client.
 */
export async function correctVariantCost(variantId: string, newCost: number, reason: string) {
  const user = await getCurrentUser();
  if (!user || (user.role !== "owner" && user.role !== "manager")) return { error: "Not authorized." };
  if (!Number.isFinite(newCost) || newCost < 0) return { error: "Enter a valid cost (0 or more)." };

  const db = createAdminClient();
  const { data: hist } = await db
    .from("stock_moves").select("id").eq("variant_id", variantId).neq("reference_type", "OPENING").limit(1);
  const hasHistory = (hist ?? []).length > 0;

  if (hasHistory && user.role !== "owner") {
    return { error: "This product already has sales/purchase history — only the owner can correct its cost." };
  }
  if (hasHistory && !reason.trim()) {
    return { error: "Please add a short reason for the correction." };
  }

  const { data, error } = await db.rpc("correct_variant_cost", {
    p_variant_id: variantId,
    p_new_cost: newCost,
    p_reason: reason.trim() || null,
    p_created_by: user.id,
  });
  if (error) return { error: error.message };

  revalidateProductSurfaces();
  revalidatePath("/admin/reports");
  return { ok: true as const, hadHistory: hasHistory, result: data };
}

// ---- Bulk CSV import (full products + opening stock) ---------------------
// The CSV carries EVERY Add-Product field (name, brand, category/sub-category,
// sku, barcode, unit, cost, price, default discount, opening stock, low-stock,
// status, description, image URL). Each row creates one complete product (a
// single default variant) through the same create_product_full RPC the manual
// "Add product" form uses, then sets the image + status — so a filled template
// imports a complete product, image included.
export interface ValidatedRow {
  line: number;
  name: string;
  sku: string;
  price: number;
  qty: number;
  status: "ok" | "error";
  errors: string[];
}

type Db = ReturnType<typeof createAdminClient>;

/** Validate rows against the DB and within the file (duplicate SKU/barcode, required fields). */
async function validateRows(db: Db, rows: ParsedProductRow[]): Promise<ValidatedRow[]> {
  const skus = rows.map((r) => r.sku?.trim()).filter(Boolean);
  const barcodes = rows.map((r) => r.barcode?.trim()).filter(Boolean) as string[];

  const [{ data: pSku }, { data: vSku }, { data: bc }] = await Promise.all([
    skus.length ? db.from("products").select("sku").in("sku", skus) : Promise.resolve({ data: [] as { sku: string }[] }),
    skus.length ? db.from("product_variants").select("sku").in("sku", skus) : Promise.resolve({ data: [] as { sku: string }[] }),
    barcodes.length ? db.from("product_barcodes").select("barcode").in("barcode", barcodes) : Promise.resolve({ data: [] as { barcode: string }[] }),
  ]);
  const existingSku = new Set([...(pSku ?? []), ...(vSku ?? [])].map((r) => r.sku));
  const existingBarcode = new Set((bc ?? []).map((r) => r.barcode));

  const seenSku = new Set<string>();
  const seenBarcode = new Set<string>();

  return rows.map((r, i) => {
    const errors: string[] = [];
    const sku = (r.sku ?? "").trim();
    const barcode = (r.barcode ?? "").trim();
    if (!r.name?.trim()) errors.push("Name required");
    if (!sku) errors.push("SKU required");
    else if (existingSku.has(sku)) errors.push("SKU already exists");
    else if (seenSku.has(sku)) errors.push("Duplicate SKU in file");
    if (barcode) {
      if (existingBarcode.has(barcode)) errors.push("Barcode already exists");
      else if (seenBarcode.has(barcode)) errors.push("Duplicate barcode in file");
    }
    if (!Number.isFinite(r.price) || r.price < 0) errors.push("Invalid price");
    if (!Number.isFinite(r.cost) || r.cost < 0) errors.push("Invalid cost");
    if (!Number.isFinite(r.qty) || r.qty < 0) errors.push("Invalid qty");
    if (sku) seenSku.add(sku);
    if (barcode) seenBarcode.add(barcode);
    return { line: i + 1, name: (r.name ?? "").trim(), sku, price: r.price, qty: r.qty, status: errors.length ? "error" : "ok", errors };
  });
}

/** Dry-run: validate the parsed CSV rows without writing anything. */
export async function validateProductImport(rows: ParsedProductRow[]): Promise<ValidatedRow[] | { error: string }> {
  if (!(await requireManager())) return { error: "Not authorized." };
  const v = importRowsSchema.safeParse(rows);
  if (!v.success) return { error: firstIssue(v.error) };
  return validateRows(createAdminClient(), rows);
}

/** Normalise a CSV discount cell to the engine's enum (or null). */
function parseDiscountType(s?: string): "PERCENT" | "FIXED" | null {
  const t = (s ?? "").trim().toUpperCase();
  if (t === "PERCENT" || t === "PERCENTAGE" || t === "%") return "PERCENT";
  if (t === "FIXED" || t === "FLAT" || t === "AMOUNT") return "FIXED";
  return null;
}

/** Treat anything explicitly "off" as archived; everything else stays active. */
function isArchivedStatus(s?: string): boolean {
  return ["archived", "inactive", "disabled", "off", "false", "no"].includes((s ?? "").trim().toLowerCase());
}

/** Find (case-insensitive) or create a category, optionally under a parent. */
async function findOrCreateCategory(db: Db, name: string, parentId: string | null): Promise<string | null> {
  const clean = name.trim();
  if (!clean) return parentId;
  let q = db.from("categories").select("id").ilike("name", clean);
  q = parentId ? q.eq("parent_id", parentId) : q.is("parent_id", null);
  const { data: found } = await q.maybeSingle();
  if (found) return found.id as string;
  const { data: created } = await db.from("categories").insert({ name: clean, parent_id: parentId }).select("id").single();
  return (created?.id as string) ?? parentId;
}

/** Resolve the most specific category id for a row (creates missing ones). */
async function resolveCategoryId(db: Db, category?: string, subCategory?: string): Promise<string | null> {
  let parentId: string | null = null;
  if (category?.trim()) parentId = await findOrCreateCategory(db, category, null);
  if (subCategory?.trim()) return findOrCreateCategory(db, subCategory, parentId);
  return parentId;
}

/** Import each valid row as a complete product (all fields + image). */
export async function importProducts(rows: ParsedProductRow[]) {
  const user = await requireManager();
  if (!user) return { error: "Not authorized." };
  const v = importRowsSchema.safeParse(rows);
  if (!v.success) return { error: firstIssue(v.error) };
  const db = createAdminClient();
  const validated = await validateRows(db, rows);
  const validLines = new Set(validated.filter((r) => r.status === "ok").map((r) => r.line));
  const valid = rows.filter((_, i) => validLines.has(i + 1));

  let created = 0;
  for (const r of valid) {
    const categoryId = await resolveCategoryId(db, r.category, r.sub_category);
    const payload = {
      name: r.name.trim(),
      brand: r.brand?.trim() || null,
      category_id: categoryId,
      description: r.description?.trim() || null,
      base_unit: r.unit?.trim() || "pcs",
      base_price: r.price || 0,
      has_variants: false,
      options: [],
      variants: [{
        sku: r.sku.trim(),
        barcode: r.barcode?.trim() || null,
        sale_price: r.price || 0,
        cost: r.cost || 0,
        reorder_point: r.low_stock || 0,
        default_discount_type: parseDiscountType(r.discount_type),
        default_discount_value: r.discount_value || 0,
        opening_qty: r.qty || 0,
        option_values: [],
      }],
      slug: productSlug(r.name, r.sku),
      created_by: user.id,
    };
    const { data: productId, error } = await db.rpc("create_product_full", { payload });
    if (error || !productId) continue;

    // Imported rows without a barcode column get one too (same guarantee).
    await ensureVariantBarcodes(db, productId as string);

    // Image(s): one or more URLs separated by "|" (first = cover), mirroring the
    // gallery so a CSV image link displays exactly like an uploaded photo.
    const urls = (r.image_url ?? "").split("|").map((u) => u.trim()).filter((u) => /^https?:\/\/\S+$/i.test(u));
    if (urls.length) {
      await db.from("store_listings").upsert({ product_id: productId, images: urls }, { onConflict: "product_id" });
      await db.from("products").update({ image_url: urls[0] }).eq("id", productId);
    }
    // Status: default active; archive only when explicitly marked off.
    if (isArchivedStatus(r.status)) await db.from("products").update({ active: false }).eq("id", productId);

    created++;
  }
  revalidateProductSurfaces();
  return { ok: true as const, created, skipped: rows.length - created };
}

/** How many fresh sequence values to try before giving up on a collision. */
const BARCODE_ASSIGN_RETRIES = 5;

/** Is this a Postgres unique-constraint violation (23505)? */
function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "23505") return true;
  const m = (error.message ?? "").toLowerCase();
  return m.includes("duplicate key") || m.includes("unique constraint");
}

/**
 * Ensure a variant has a scannable barcode. If it already has one, return it;
 * otherwise generate an internal GS1 prefix-2 EAN-13 (or a weight template for
 * variable-weight items), save it, and return it. Used by the label printer.
 */
export async function assignInternalBarcode(variantId: string, productId: string, variableWeight = false) {
  if (!(await requireManager())) return { error: "Not authorized." };
  const db = createAdminClient();

  const { data: existing } = await db
    .from("product_barcodes")
    .select("barcode, is_primary")
    .eq("variant_id", variantId)
    .order("is_primary", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing?.barcode) return { ok: true, barcode: existing.barcode as string, existed: true };

  // Draw from the sequence and INSERT, letting the database's unique constraint
  // — not a read-then-write check, which races two cashiers adding products at
  // once — be the thing that decides the code is free. A collision just draws
  // the next value.
  let lastError = "Could not assign a barcode.";
  for (let attempt = 0; attempt < BARCODE_ASSIGN_RETRIES; attempt++) {
    const { data: seq, error: seqErr } = await db.rpc("next_internal_barcode");
    if (seqErr) return { error: seqErr.message };
    let barcode: string;
    try {
      const n = Number(seq);
      barcode = variableWeight ? generateWeightTemplateEan13(n) : generateInternalEan13(n);
    } catch (e) {
      return { error: e instanceof RangeError ? e.message : "Could not generate a barcode." };
    }
    const { error } = await db.from("product_barcodes").insert({
      product_id: productId,
      variant_id: variantId,
      barcode,
      type: "INTERNAL",
      is_primary: true,
    });
    if (!error) {
      revalidatePath("/admin/products");
      return { ok: true, barcode, existed: false };
    }
    lastError = error.message;
    if (!isUniqueViolation(error)) break;
  }
  return { error: lastError };
}

// ---- Product image gallery -----------------------------------------------
// store_listings.images[] is the gallery; products.image_url mirrors the first
// (cover) image so cards / catalog_index / POS use it without joining listings.
const IMAGE_BUCKET = "product-images";
// Allowed photo types (matches the per-variant upload + the task spec).
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const MAX_IMAGE_BYTES = 5_242_880; // 5 MB

/** Validate a single image File — same rules as the (working) variant upload. */
function validateImageFile(file: unknown): { file: File } | { error: string } {
  if (!(file instanceof File) || file.size === 0) return { error: "No image selected." };
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) return { error: "Use a JPG, PNG or WebP image." };
  if (file.size > MAX_IMAGE_BYTES) return { error: "Image must be under 5 MB." };
  return { file };
}

/** Upload one file to storage and return its public URL (or an error message). */
async function uploadOne(db: ReturnType<typeof createAdminClient>, productId: string, file: File): Promise<{ url: string } | { error: string }> {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = `${productId}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const { error } = await db.storage.from(IMAGE_BUCKET).upload(path, file, { upsert: true, contentType: file.type, cacheControl: "31536000" });
  if (error) return { error: error.message || "Upload failed — please try again." };
  return { url: db.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl };
}

async function currentImages(db: ReturnType<typeof createAdminClient>, productId: string): Promise<string[]> {
  const { data } = await db.from("store_listings").select("images").eq("product_id", productId).maybeSingle();
  const imgs = ((data?.images as string[]) ?? []).filter(Boolean);
  if (imgs.length) return imgs;
  // migrate a legacy single image_url into the gallery view
  const { data: p } = await db.from("products").select("image_url").eq("id", productId).maybeSingle();
  return p?.image_url ? [p.image_url as string] : [];
}

/** Persist the gallery (store_listings.images) + cover (products.image_url).
 *  Returns an error message if either write fails so the caller can surface it. */
async function syncGallery(db: ReturnType<typeof createAdminClient>, productId: string, images: string[]): Promise<{ error?: string }> {
  const { error: listErr } = await db.from("store_listings").upsert({ product_id: productId, images }, { onConflict: "product_id" });
  if (listErr) return { error: listErr.message };
  const { error: prodErr } = await db.from("products").update({ image_url: images[0] ?? null }).eq("id", productId);
  if (prodErr) return { error: prodErr.message };
  return {};
}

/** Current gallery images for a product (cover first). */
export async function getProductImages(productId: string): Promise<string[]> {
  if (!(await requireManager())) return [];
  return currentImages(createAdminClient(), productId);
}

/**
 * Upload ONE product photo, appended to the gallery (first photo = cover).
 * Mirrors the per-variant upload (single file per request) so the body never
 * approaches the server-action size limit — the client uploads multiple photos
 * by calling this once per file.
 */
export async function uploadProductImage(productId: string, formData: FormData) {
  if (!(await requireManager())) return { error: "Not authorized." };
  const valid = validateImageFile(formData.get("file"));
  if ("error" in valid) return { error: valid.error };

  const db = createAdminClient();
  const up = await uploadOne(db, productId, valid.file);
  if ("error" in up) return { error: up.error };

  const images = [...(await currentImages(db, productId)), up.url];
  const sync = await syncGallery(db, productId, images);
  if (sync.error) return { error: sync.error };

  revalidateProductSurfaces();
  return { ok: true as const, images };
}

/**
 * Add a product photo by pasted image URL (no upload). Mirrors uploadProductImage
 * — appends to the gallery (first photo = cover), syncs the cover — so a URL and
 * an uploaded file save and display identically. Also used by the CSV importer's
 * image column.
 */
export async function addProductImageUrl(productId: string, rawUrl: string) {
  if (!(await requireManager())) return { error: "Not authorized." };
  const url = rawUrl.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return { error: "Enter a valid image URL (http:// or https://)." };

  const db = createAdminClient();
  const existing = await currentImages(db, productId);
  if (existing.includes(url)) return { error: "That image is already in the gallery." };
  const images = [...existing, url];
  const sync = await syncGallery(db, productId, images);
  if (sync.error) return { error: sync.error };

  revalidateProductSurfaces();
  return { ok: true as const, images };
}

/** Remove a photo from the gallery (and storage). */
export async function removeProductImageUrl(productId: string, url: string) {
  if (!(await requireManager())) return { error: "Not authorized." };
  const db = createAdminClient();
  const images = (await currentImages(db, productId)).filter((u) => u !== url);
  const sync = await syncGallery(db, productId, images);
  if (sync.error) return { error: sync.error };
  const path = url.split(`/${IMAGE_BUCKET}/`)[1];
  if (path) await db.storage.from(IMAGE_BUCKET).remove([path]);
  revalidateProductSurfaces();
  return { ok: true as const, images };
}

/** Make a photo the cover (move to front of the gallery). */
export async function setPrimaryProductImage(productId: string, url: string) {
  if (!(await requireManager())) return { error: "Not authorized." };
  const db = createAdminClient();
  const cur = await currentImages(db, productId);
  if (!cur.includes(url)) return { error: "Image not found." };
  const images = [url, ...cur.filter((u) => u !== url)];
  const sync = await syncGallery(db, productId, images);
  if (sync.error) return { error: sync.error };
  revalidateProductSurfaces();
  return { ok: true as const, images };
}

// ---- Per-variant image (optional) ----------------------------------------
// A variant may have its own photo; when absent the parent product image is
// used. Stored on product_variants.image_url; catalog_index already coalesces
// variant -> product so POS / storefront pick the right picture automatically.

/** Upload (replace) a single variant photo. */
export async function uploadVariantImage(variantId: string, formData: FormData) {
  if (!(await requireManager())) return { error: "Not authorized." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "No image selected." };
  if (!file.type.startsWith("image/")) return { error: "That file isn’t an image." };
  if (file.size > 5_242_880) return { error: "Image must be under 5 MB." };

  const db = createAdminClient();
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = `variants/${variantId}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const { error: upErr } = await db.storage.from(IMAGE_BUCKET).upload(path, file, { upsert: true, contentType: file.type, cacheControl: "31536000" });
  if (upErr) return { error: "Upload failed — please try again." };
  const url = db.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;

  // Remove the previous variant photo (storage) before pointing at the new one.
  const { data: prev } = await db.from("product_variants").select("image_url").eq("id", variantId).maybeSingle();
  const oldPath = (prev?.image_url as string | null)?.split(`/${IMAGE_BUCKET}/`)[1];

  const { error } = await db.from("product_variants").update({ image_url: url }).eq("id", variantId);
  if (error) return { error: error.message };
  if (oldPath) await db.storage.from(IMAGE_BUCKET).remove([oldPath]);

  revalidateProductSurfaces();
  return { ok: true as const, image_url: url };
}

/** Remove a variant's own photo (falls back to the product image again). */
export async function removeVariantImage(variantId: string) {
  if (!(await requireManager())) return { error: "Not authorized." };
  const db = createAdminClient();
  const { data: prev } = await db.from("product_variants").select("image_url").eq("id", variantId).maybeSingle();
  const oldPath = (prev?.image_url as string | null)?.split(`/${IMAGE_BUCKET}/`)[1];
  const { error } = await db.from("product_variants").update({ image_url: null }).eq("id", variantId);
  if (error) return { error: error.message };
  if (oldPath) await db.storage.from(IMAGE_BUCKET).remove([oldPath]);
  revalidateProductSurfaces();
  return { ok: true as const };
}

/** Bulk set the sale price on every variant of a product. */
export async function bulkSetPrice(productId: string, salePrice: number) {
  if (!(await requireManager())) return { error: "Not authorized." };
  const db = createAdminClient();
  const { error } = await db
    .from("product_variants")
    .update({ sale_price: salePrice })
    .eq("product_id", productId);
  if (error) return { error: error.message };
  revalidatePath("/admin/products");
  return { ok: true };
}
