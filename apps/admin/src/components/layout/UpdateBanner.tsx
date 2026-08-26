"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

/**
 * Tells the cashier when the page in front of them is older than the server.
 *
 * WHY THIS EXISTS
 * ---------------
 * A Next.js App Router page never reloads itself. A till opened before a deploy
 * keeps running the bundle it downloaded then — indefinitely. That is not a
 * caching bug and no service worker is involved; it is just what a long-lived
 * tab does. It cost this shop a day of scanning against pre-fix code with
 * nothing on screen to suggest anything was wrong.
 *
 * WHY IT DOES NOT RELOAD BY ITSELF
 * --------------------------------
 * This runs on a till. Reloading the page out from under a half-rung sale would
 * throw away the cart, so the decision stays with the cashier: the banner is
 * loud, permanent until acted on, and one click away from a fresh page. It is
 * deliberately not dismissible — a notice you can dismiss is a notice that gets
 * dismissed at 9am and forgotten.
 */
const POLL_MS = 120_000;

export function UpdateBanner() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const mine = process.env.NEXT_PUBLIC_BUILD_ID ?? "";
    // No build id (local dev, or a host that provides none) — nothing to compare.
    if (!mine) return;

    let alive = true;
    const check = async () => {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const { buildId } = (await res.json()) as { buildId?: string };
        if (alive && buildId && buildId !== mine) setStale(true);
      } catch {
        /* offline — say nothing; the till keeps working from its cache */
      }
    };

    void check();
    const timer = window.setInterval(check, POLL_MS);
    window.addEventListener("focus", check);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, []);

  if (!stale) return null;

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-black shadow-lg"
    >
      <RefreshCw className="h-4 w-4 shrink-0" />
      <span>
        This page is running an older version of the app. Reload to get the latest
        &mdash; finish the current sale first.
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="shrink-0 rounded-md bg-black/85 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-black"
      >
        Reload now
      </button>
    </div>
  );
}
