"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Store, X } from "lucide-react";
import { cn } from "@hamza/shared/utils";
import { navForRole, type Role } from "./nav";

export function Sidebar({
  role,
  mobileOpen,
  onClose,
  storeName = "Hamza Store",
  logoUrl,
}: {
  role: Role;
  mobileOpen: boolean;
  onClose: () => void;
  storeName?: string;
  logoUrl?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const items = navForRole(role);
  // Cashiers have no Dashboard access, so the brand/logo must NOT lead there —
  // it lands them on POS billing instead (their home). Owner/manager keep the
  // Dashboard as home. The Dashboard route is also blocked server-side in
  // middleware, so this is defence-in-depth, not the only guard.
  const homeHref = role === "cashier" ? "/admin/pos" : "/admin/dashboard";

  // Warm a tab's full RSC payload the moment the user shows intent (hover/focus),
  // so the actual click resolves from the client router cache instantly. Next's
  // default Link prefetch for dynamic routes only fetches the loading shell; an
  // explicit prefetch pulls the data too.
  const warm = (href: string) => router.prefetch(href);

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30 lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-border bg-[var(--sidebar-bg)] transition-transform duration-200 lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* Brand */}
        <div className="flex h-16 items-center justify-between px-5">
          <Link href={homeHref} className="flex items-center gap-2.5">
            {logoUrl ? (
              <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl bg-surface-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={logoUrl} alt={storeName} className="h-full w-full object-contain" />
              </div>
            ) : (
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-500 text-white">
                <Store className="h-5 w-5" />
              </div>
            )}
            <div className="leading-tight">
              <div className="font-heading text-sm font-bold text-text-primary">
                {storeName}
              </div>
              <div className="text-[10px] text-text-tertiary">Inventory & POS</div>
            </div>
          </Link>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-text-tertiary hover:bg-surface-2 lg:hidden"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 overflow-y-auto scrollbar-thin px-3 py-2">
          {items.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch
                onClick={onClose}
                onMouseEnter={() => warm(item.href)}
                onFocus={() => warm(item.href)}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-[var(--sidebar-active-bg)] text-[var(--sidebar-active-text)] shadow-card"
                    : "text-[var(--sidebar-text)] hover:bg-surface-2 hover:text-text-primary",
                )}
              >
                <Icon className="h-[18px] w-[18px]" strokeWidth={active ? 2.4 : 2} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-border px-5 py-3 text-[11px] text-text-tertiary">
          © {new Date().getFullYear()} Hamza General Store
        </div>
      </aside>
    </>
  );
}
