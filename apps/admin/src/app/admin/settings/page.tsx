import type { Metadata } from "next";
import { createClient } from "@hamza/shared/supabase/server";
import { createAdminClient } from "@hamza/shared/supabase/admin";
import { getCurrentUser } from "@hamza/shared/auth";
import { SettingsClient, type SettingsData, type UserRow } from "@/features/settings/SettingsClient";
import { DEFAULT_RETURN_WINDOW_DAYS } from "@/lib/return-window";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const supabase = await createClient();
  const me = await getCurrentUser();
  const isOwner = me?.role === "owner";

  const [{ data: settings }, { data: users }] = await Promise.all([
    supabase.from("settings").select("store_name, costing_method, tax_percent, currency, store_info, courier_keys, notif_prefs").eq("id", 1).single(),
    supabase.from("profiles").select("id, full_name, role, active").order("role"),
  ]);

  // emails come from auth.users (owner only — needs admin)
  const emailById = new Map<string, string>();
  if (isOwner) {
    try {
      const admin = createAdminClient();
      const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
      for (const u of list?.users ?? []) if (u.email) emailById.set(u.id, u.email);
    } catch { /* ignore — emails optional */ }
  }

  const info = (settings?.store_info as Record<string, unknown>) ?? {};
  const inv = (info.inventory as Record<string, unknown>) ?? {};
  const sales = (info.sales as Record<string, unknown>) ?? {};
  const courier = (settings?.courier_keys as Record<string, string>) ?? {};
  const notif = (settings?.notif_prefs as Record<string, unknown>) ?? {};

  const data: SettingsData = {
    store_name: settings?.store_name ?? "Hamza General Store",
    costing_method: (settings?.costing_method as "WEIGHTED_AVERAGE" | "FIFO") ?? "WEIGHTED_AVERAGE",
    tax_percent: Number(settings?.tax_percent ?? 0),
    currency: settings?.currency ?? "PKR",
    address: String(info.address ?? ""),
    phone: String(info.phone ?? ""),
    ntn: String(info.ntn ?? ""),
    receipt_header: String(info.receipt_header ?? ""),
    receipt_footer: String(info.receipt_footer ?? ""),
    receipt_disclaimer: String(info.receipt_disclaimer ?? ""),
    logo_url: String(info.logo_url ?? ""),
    low_stock_default: Number(inv.low_stock_default ?? 5),
    barcode_format: String(inv.barcode_format ?? "EAN"),
    default_unit: String(inv.default_unit ?? "pcs"),
    rounding: String(sales.rounding ?? "none"),
    receipt_template: String(sales.receipt_template ?? "standard"),
    return_window_days: Number(info.return_window_days ?? DEFAULT_RETURN_WINDOW_DAYS),
    allow_discounts: Boolean(sales.allow_discounts ?? true),
    courier, resend_key: courier.resend ?? "", whatsapp_key: courier.whatsapp ?? "",
    from_email: String(info.from_email ?? ""),
    notif_prefs: notif,
  };

  const userRows: UserRow[] = (users ?? []).map((u) => ({
    id: u.id, full_name: u.full_name, role: u.role, active: u.active, email: emailById.get(u.id) ?? "",
  }));

  return <SettingsClient data={data} users={userRows} isOwner={isOwner} myId={me?.id ?? ""} />;
}
