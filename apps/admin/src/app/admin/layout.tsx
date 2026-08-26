import { redirect } from "next/navigation";
import { createClient } from "@hamza/shared/supabase/server";
import { AppShell } from "@/components/layout/AppShell";
import { UpdateBanner } from "@/components/layout/UpdateBanner";
import type { Role } from "@/components/layout/nav";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // The profile, unread badge and store branding only need the user id, so fetch
  // all three in ONE parallel round-trip instead of a serial waterfall — this
  // layout re-runs on every admin navigation, so collapsing it keeps tab
  // switching fast. Each query degrades gracefully on its own (pre-seed fallback).
  const [profileRes, unreadRes, settingsRes] = await Promise.all([
    supabase.from("profiles").select("full_name, role").eq("id", user.id).single()
      .then((r) => r, () => ({ data: null })),
    supabase.from("notifications").select("id", { count: "exact", head: true })
      .eq("recipient_type", "ADMIN").is("read_at", null)
      .then((r) => r, () => ({ count: 0 })),
    supabase.from("settings").select("store_name, store_info").eq("id", 1).maybeSingle()
      .then((r) => r, () => ({ data: null })),
  ]);

  // Profile may not exist yet (before schema/seed). Fall back gracefully.
  const profile = (profileRes.data as { full_name?: string; role?: Role } | null) ?? null;
  const role: Role = profile?.role ?? "owner";
  const fullName = profile?.full_name ?? user.email?.split("@")[0] ?? "User";

  const unread = ("count" in unreadRes ? unreadRes.count : 0) ?? 0;

  const settings = (settingsRes.data as { store_name?: string; store_info?: Record<string, string | undefined> } | null) ?? null;
  const info = settings?.store_info ?? {};
  const storeName = settings?.store_name || "Hamza Store";
  const logoUrl = info.logo_url || "";

  return (
    <AppShell role={role} userName={fullName} unreadCount={unread} storeName={storeName} logoUrl={logoUrl}>
      {/* Warns when this tab is older than the deployed server. See UpdateBanner. */}
      <UpdateBanner />
      {children}
    </AppShell>
  );
}
