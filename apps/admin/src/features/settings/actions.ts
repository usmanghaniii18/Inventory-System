"use server";

import { revalidatePath } from "next/cache";
import { createClient as createSupabaseJs } from "@supabase/supabase-js";
import { createAdminClient } from "@hamza/shared/supabase/admin";
import { createClient } from "@hamza/shared/supabase/server";
import { getCurrentUser } from "@hamza/shared/auth";
import { selectAll } from "@/lib/fetch-all";

async function requireOwner() {
  const user = await getCurrentUser();
  if (!user || user.role !== "owner") return null;
  return user;
}

async function mergeJson(db: ReturnType<typeof createAdminClient>, column: "store_info" | "courier_keys" | "notif_prefs", patch: Record<string, unknown>) {
  const { data } = await db.from("settings").select(column).eq("id", 1).single();
  const current = ((data as Record<string, unknown> | null)?.[column] as Record<string, unknown>) ?? {};
  await db.from("settings").update({ [column]: { ...current, ...patch } }).eq("id", 1);
}

/* ---------------- Store profile ---------------- */
export async function updateStoreProfile(input: {
  store_name: string; currency: string; tax_percent: number;
  address?: string; phone?: string; ntn?: string;
  receipt_header?: string; receipt_footer?: string; receipt_disclaimer?: string; logo_url?: string;
}) {
  if (!(await requireOwner())) return { error: "Only the owner can change settings." };
  const db = createAdminClient();
  const { error } = await db.from("settings").update({
    store_name: input.store_name, currency: input.currency, tax_percent: input.tax_percent,
  }).eq("id", 1);
  if (error) return { error: error.message };
  await mergeJson(db, "store_info", {
    address: input.address ?? "", phone: input.phone ?? "", ntn: input.ntn ?? "",
    receipt_header: input.receipt_header ?? "", receipt_footer: input.receipt_footer ?? "",
    // Phase F — blank means "use the built-in default" at render time, so the
    // admin can clear the field without ending up with no disclaimer at all.
    receipt_disclaimer: input.receipt_disclaimer ?? "", logo_url: input.logo_url ?? "",
  });
  // The store logo / name / address live in the SHARED admin layout (sidebar +
  // header, on every page) and are read fresh into POS receipts. Revalidating
  // only /admin/settings left the cached logo on all other routes — so a new
  // logo appeared to "not take effect". Revalidate the whole admin layout so the
  // new logo shows immediately everywhere (headers + invoices/receipts).
  revalidatePath("/admin", "layout");
  revalidatePath("/admin/settings");
  return { ok: true };
}

/* ---------------- Store logo upload ---------------- */
// Reuses the same working Storage mechanism as product photos: one file →
// public bucket → public URL. Each upload gets a UNIQUE path (so the URL always
// changes and no browser/CDN can serve a stale cached image), and the new URL is
// persisted to settings.store_info.logo_url IMMEDIATELY here — not deferred to a
// separate "Save profile" click. That two-step gap was the bug: uploads landed
// in storage but the settings record kept pointing at the old logo, so every
// reader (header, invoice, settings) showed the previous image.
const LOGO_BUCKET = "product-images";
const LOGO_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/avif"];
const LOGO_MAX_BYTES = 5_242_880; // 5 MB

/** Persist the store logo reference and refresh everywhere it's shown. */
async function persistLogo(db: ReturnType<typeof createAdminClient>, url: string) {
  await mergeJson(db, "store_info", { logo_url: url });
  // Logo lives in the SHARED admin layout (header on every page) and is read
  // into POS/reprint receipts — revalidate the whole admin layout so the new
  // logo appears immediately without a hard refresh.
  revalidatePath("/admin", "layout");
  revalidatePath("/admin/settings");
}

export async function uploadLogo(formData: FormData): Promise<{ url: string } | { error: string }> {
  if (!(await requireOwner())) return { error: "Only the owner can change settings." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "No image selected." };
  if (!LOGO_TYPES.includes(file.type)) return { error: "Use a PNG, JPG or WebP image." };
  if (file.size > LOGO_MAX_BYTES) return { error: "Logo must be under 5 MB." };

  const db = createAdminClient();
  const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = `branding/logo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const { error } = await db.storage.from(LOGO_BUCKET).upload(path, file, {
    upsert: true, contentType: file.type, cacheControl: "31536000",
  });
  if (error) return { error: error.message || "Upload failed — please try again." };
  const url = db.storage.from(LOGO_BUCKET).getPublicUrl(path).data.publicUrl;
  await persistLogo(db, url);
  return { url };
}

/** Clear the store logo (persisted immediately, mirrors uploadLogo). */
export async function removeLogo(): Promise<{ ok: true } | { error: string }> {
  if (!(await requireOwner())) return { error: "Only the owner can change settings." };
  await persistLogo(createAdminClient(), "");
  return { ok: true };
}

/* ---------------- Inventory settings ---------------- */
export async function updateInventorySettings(input: {
  costing_method: "WEIGHTED_AVERAGE" | "FIFO";
  low_stock_default: number; barcode_format: string; default_unit: string;
}) {
  if (!(await requireOwner())) return { error: "Only the owner can change settings." };
  const db = createAdminClient();
  await db.from("settings").update({ costing_method: input.costing_method }).eq("id", 1);
  await mergeJson(db, "store_info", {
    inventory: { low_stock_default: input.low_stock_default, barcode_format: input.barcode_format, default_unit: input.default_unit },
  });
  revalidatePath("/admin/settings");
  return { ok: true };
}

/* ---------------- Sales settings ---------------- */
export async function updateSalesSettings(input: {
  tax_percent: number; rounding: string; receipt_template: string; allow_discounts: boolean;
  /** Phase H — days after a sale that a return is still accepted (0 = no limit). */
  return_window_days?: number;
}) {
  if (!(await requireOwner())) return { error: "Only the owner can change settings." };
  const db = createAdminClient();
  await db.from("settings").update({ tax_percent: input.tax_percent }).eq("id", 1);
  await mergeJson(db, "store_info", {
    sales: { rounding: input.rounding, receipt_template: input.receipt_template, allow_discounts: input.allow_discounts },
    // Kept at the TOP level of store_info because that is where the returns
    // flow already reads it from — moving it under `sales` would silently
    // orphan any value a store has already saved.
    ...(input.return_window_days !== undefined ? { return_window_days: input.return_window_days } : {}),
  });
  revalidatePath("/admin/settings");
  revalidatePath("/admin/pos");
  return { ok: true };
}

/* ---------------- Integrations ---------------- */
export async function updateIntegrations(input: {
  courier: Record<string, string>;
  resend_key?: string; whatsapp_key?: string; from_email?: string;
  payment?: { stripe_secret?: string; jazzcash_merchant?: string; jazzcash_password?: string; jazzcash_salt?: string; jazzcash_sandbox?: boolean; easypaisa_store?: string; easypaisa_key?: string; easypaisa_sandbox?: boolean };
  notif_prefs: Record<string, unknown>;
}) {
  if (!(await requireOwner())) return { error: "Only the owner can change settings." };
  const db = createAdminClient();
  await mergeJson(db, "courier_keys", {
    ...input.courier,
    resend: input.resend_key ?? "",
    whatsapp: input.whatsapp_key ?? "",
    stripe_secret: input.payment?.stripe_secret ?? "",
    jazzcash_merchant: input.payment?.jazzcash_merchant ?? "",
    jazzcash_password: input.payment?.jazzcash_password ?? "",
    jazzcash_salt: input.payment?.jazzcash_salt ?? "",
    jazzcash_sandbox: input.payment?.jazzcash_sandbox ? "true" : "",
    easypaisa_store: input.payment?.easypaisa_store ?? "",
    easypaisa_key: input.payment?.easypaisa_key ?? "",
    easypaisa_sandbox: input.payment?.easypaisa_sandbox ? "true" : "",
  });
  if (input.from_email !== undefined) await mergeJson(db, "store_info", { from_email: input.from_email });
  await mergeJson(db, "notif_prefs", input.notif_prefs);
  revalidatePath("/admin/settings");
  return { ok: true };
}

/* ---------------- Users & roles ---------------- */
export async function inviteUser(input: { email: string; full_name: string; role: "owner" | "manager" | "cashier"; password: string }) {
  if (!(await requireOwner())) return { error: "Only the owner can manage users." };
  if (!input.email || !input.password) return { error: "Email and a temporary password are required." };
  if (input.password.length < 8) return { error: "Password must be at least 8 characters." };
  const db = createAdminClient();
  const { data, error } = await db.auth.admin.createUser({
    email: input.email, password: input.password, email_confirm: true,
    user_metadata: { full_name: input.full_name, role: input.role },
  });
  if (error) return { error: error.message };
  // ensure profile reflects role/name (trigger also handles it)
  if (data.user) await db.from("profiles").update({ full_name: input.full_name, role: input.role }).eq("id", data.user.id);
  revalidatePath("/admin/settings");
  return { ok: true };
}

export async function updateUserRole(userId: string, role: "owner" | "manager" | "cashier") {
  if (!(await requireOwner())) return { error: "Only the owner can manage users." };
  const db = createAdminClient();
  const { error } = await db.from("profiles").update({ role }).eq("id", userId);
  if (error) return { error: error.message };
  revalidatePath("/admin/settings");
  return { ok: true };
}

export async function setUserActive(userId: string, active: boolean) {
  const me = await requireOwner();
  if (!me) return { error: "Only the owner can manage users." };
  if (userId === me.id && !active) return { error: "You can’t deactivate your own account." };
  const db = createAdminClient();
  const { error } = await db.from("profiles").update({ active }).eq("id", userId);
  if (error) return { error: error.message };
  revalidatePath("/admin/settings");
  return { ok: true };
}

export async function resetUserPassword(userId: string, newPassword: string) {
  if (!(await requireOwner())) return { error: "Only the owner can reset passwords." };
  if (!newPassword || newPassword.length < 8) return { error: "Password must be at least 8 characters." };
  const db = createAdminClient();
  const { error } = await db.auth.admin.updateUserById(userId, { password: newPassword });
  if (error) return { error: error.message };
  return { ok: true };
}

/* ---------------- Change own password ---------------- */
export async function changePassword(currentPassword: string, newPassword: string) {
  const me = await getCurrentUser();
  if (!me) return { error: "Not signed in." };
  if (!newPassword || newPassword.length < 8) return { error: "New password must be at least 8 characters." };

  // verify the current password with a throwaway (non-persistent) client
  const verifier = createSupabaseJs(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { error: vErr } = await verifier.auth.signInWithPassword({ email: me.email, password: currentPassword });
  if (vErr) return { error: "Current password is incorrect." };

  // update via the logged-in session client
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { error: error.message };
  return { ok: true };
}

/* ---------------- CSV product export (backup) ---------------- */
export async function exportProductsCSV(): Promise<{ csv: string } | { error: string }> {
  if (!(await requireOwner())) return { error: "Only the owner can export data." };
  const db = createAdminClient();
  // Paged so a full backup export never stops at the 1000-row cap.
  const [{ data: variants }, { data: products }, { data: avail }, { data: barcodes }] = await Promise.all([
    selectAll((from, to) => db.from("product_variants").select("id, product_id, sku, cost, sale_price").order("id").range(from, to)),
    selectAll((from, to) => db.from("products").select("id, name").order("id").range(from, to)),
    selectAll((from, to) => db.from("variant_availability").select("variant_id, on_hand").order("variant_id").range(from, to)),
    selectAll((from, to) => db.from("product_barcodes").select("variant_id, barcode, is_primary").order("id").range(from, to)),
  ]);
  const pName = new Map((products ?? []).map((p) => [p.id, p.name]));
  const onHand = new Map((avail ?? []).map((a) => [a.variant_id, Number(a.on_hand)]));
  const bc = new Map<string, string>();
  for (const b of barcodes ?? []) if (!bc.has(b.variant_id) || b.is_primary) bc.set(b.variant_id, b.barcode);
  const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const header = "product,sku,barcode,cost,sale_price,on_hand";
  const lines = (variants ?? []).map((v) =>
    [pName.get(v.product_id) ?? "", v.sku, bc.get(v.id) ?? "", v.cost, v.sale_price, onHand.get(v.id) ?? 0].map(esc).join(","));
  return { csv: `${header}\n${lines.join("\n")}` };
}

/* ---------------- CSV product import ---------------- */
export async function importProductsCSV(rows: { name: string; sku: string; price: number; cost: number; qty: number; barcode?: string }[]) {
  if (!(await requireOwner())) return { error: "Only the owner can import data." };
  const db = createAdminClient();
  const { data: locs } = await db.from("locations").select("id, code").in("code", ["SUP", "MAIN"]);
  const sup = locs?.find((l) => l.code === "SUP")?.id;
  const main = locs?.find((l) => l.code === "MAIN")?.id;

  let created = 0; const errors: string[] = [];
  for (const r of rows) {
    if (!r.name || !r.sku) { errors.push(`Skipped row without name/sku`); continue; }
    const { data: product, error } = await db.from("products")
      .insert({ name: r.name, sku: r.sku, default_sale_price: r.price || 0, has_variants: false })
      .select("id").single();
    if (error) { errors.push(`${r.sku}: ${error.message}`); continue; }
    const { data: variant } = await db.from("product_variants")
      .insert({ product_id: product.id, sku: r.sku, cost: r.cost || 0, sale_price: r.price || 0, is_default: true })
      .select("id").single();
    if (r.barcode && variant) await db.from("product_barcodes").insert({ product_id: product.id, variant_id: variant.id, barcode: r.barcode, type: "EAN", is_primary: true });
    if (r.qty > 0 && variant && sup && main) {
      await db.from("stock_moves").insert({
        product_id: product.id, variant_id: variant.id, qty: r.qty, from_location_id: sup, to_location_id: main,
        unit_cost: r.cost || 0, reference_type: "OPENING", source: "IMPORT", note: "CSV import",
      });
    }
    created++;
  }
  revalidatePath("/admin/settings"); revalidatePath("/admin/products"); revalidatePath("/admin/stock");
  return { ok: true, created, errors };
}
