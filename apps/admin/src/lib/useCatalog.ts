"use client";

import { useEffect } from "react";
import { useSyncExternalStore } from "react";
import { ensureCatalog, getSnapshot, subscribe, type CatalogSnapshot } from "@/lib/catalog-cache";

/**
 * How often a screen that is sitting open re-checks the catalogue.
 *
 * A till is opened on Monday morning and not touched again for days. The
 * previous version called ensureCatalog() once, in a mount effect with an empty
 * dependency array — and ensureCatalog only starts a background refresh when it
 * is CALLED. Nothing called it again, so the page never re-fetched: every
 * product added, barcode assigned or price changed after that tab was opened
 * was invisible to it, indefinitely.
 *
 * That is why barcodes generated for the eighteen items with none still scanned
 * as "unknown" at a till whose tab predated them, on completely correct code.
 */
/**
 * Raised from 60s. At one minute this poll, multiplied by every open tab, is
 * what drained the Supabase egress quota and took every login down with it —
 * the full story is in api/catalog/route.ts.
 *
 * The ETag makes an unchanged poll cost a few hundred bytes rather than 1.22 MB,
 * so the interval is no longer what protects the budget. Five minutes is the
 * safety margin behind it: if the fingerprint path ever regresses to full
 * responses, this caps the bleeding at a fifth of what it was. Nothing a
 * cashier does waits on it — a sale patches the local cache immediately
 * (applyStockDelta), and focus/visibilitychange still reconcile on the spot.
 */
const POLL_MS = 5 * 60_000;

/**
 * Subscribe to the shared local catalogue cache. Returns the current snapshot
 * (or null before the first hydrate), and keeps it CURRENT for as long as the
 * component is mounted.
 *
 * Three triggers, deliberately:
 *   - on mount, as before;
 *   - every POLL_MS, so a screen nobody touches still catches up;
 *   - when the tab is focused or made visible again, so walking back to the
 *     till gives an immediate refresh rather than up to a minute of stale data.
 *
 * ensureCatalog() is cheap to call repeatedly: it returns the current snapshot
 * synchronously and only hits the network when the data is older than its own
 * threshold, so none of this adds a request per tick.
 */
export function useCatalog(): CatalogSnapshot | null {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => null);

  useEffect(() => {
    let alive = true;
    const check = () => { if (alive) void ensureCatalog(); };

    check();
    const timer = window.setInterval(check, POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisible);
    // Coming back from a network drop is the other moment the cached copy is
    // most likely to be behind.
    window.addEventListener("online", check);

    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", check);
    };
  }, []);

  return snapshot;
}
