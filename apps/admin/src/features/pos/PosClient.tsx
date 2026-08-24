"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  Search, ShoppingCart, Plus, Minus, Trash2, X, Banknote,
  Loader2, Package, ScanLine, Camera, CheckCircle2, AlertTriangle, RotateCcw,
  Keyboard, Pause, Clock, Play, WifiOff, RefreshCw, Tag,
} from "lucide-react";
import { Input } from "@hamza/shared/ui/Input";
import { CustomerSelect } from "./CustomerSelect";
import { Button } from "@hamza/shared/ui/Button";
import { StatusPill } from "@hamza/shared/ui/StatusPill";
import { useToast } from "@hamza/shared/ui/Toast";
import { cn, formatPKR } from "@hamza/shared/utils";
import { useCatalog } from "@/lib/useCatalog";
import { ensureCatalog, type CatalogItem } from "@/lib/catalog-cache";
import { useScanHandler } from "@/components/scan/ScanProvider";
import { parseScan } from "@/lib/barcode";
import { beepOk, beepError } from "@/lib/sound";
import { CameraScanner } from "@/components/scan/CameraScannerLazy";
import { PaymentSheet } from "./PaymentSheet";
import { Receipt } from "./Receipt";
import { ReturnsSheet } from "./ReturnsSheet";
import { checkoutSale, quickAddCustomer, type PaymentInput } from "./actions";
import { enqueueSale, getQueue, removeFromQueue, queueCount, type QueuedSalePayload } from "@/lib/pos-queue";
import { computeTotals, unitDiscount, round2 as round2px } from "@hamza/shared/pricing";
import { computePromotions, type Promotion, type PromoResult } from "@hamza/shared/discounts";
import { type ReceiptData } from "@/lib/receipt";
import { printReceiptHtml, isPrintableReceipt } from "@/lib/receipt-html";
import { resolveShortcut, isCharacterKey, SHORTCUT_HELP, RETIRED_KEYS, type PosAction } from "@/lib/pos-shortcuts";

/** Cart line: qty + a per-line discount (rupees). `manual` is set once the
 *  cashier edits/removes it, so it stops tracking the product's default. */
interface CartEntry { p: PosProduct; qty: number; discount: number; manual: boolean }

/** Auto discount (rupees) for a whole line from the product's default. */
function autoLineDiscount(p: PosProduct, qty: number): number {
  return round2px(unitDiscount(p.price, p.disc_type, p.disc_value) * qty);
}

export interface StoreSettings {
  name: string;
  address?: string;
  phone?: string;
  ntn?: string;
  logo_url?: string;
  receipt_header?: string;
  receipt_footer?: string;
  /** Store-set disclaimer printed on every receipt (Phase F). */
  receipt_disclaimer?: string;
  tax_percent: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A field the cashier is deliberately typing into, which the scan box must not
 * steal focus from. The scan/search box itself is excluded (it IS the resting
 * place), so re-focusing it is always allowed.
 */
function isDeliberateField(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.dataset?.scanBox === "1") return false; // the scan box IS the resting place
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) return true;
  // A control the cashier reached with the KEYBOARD (Tab) is also off limits —
  // :focus-visible is set for keyboard focus but not for a mouse click, which is
  // exactly the distinction we want: never yank focus mid-Tab-navigation, but do
  // reclaim it from a button that was merely clicked.
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

// ---- Hold / resume: parked carts persisted per-device in localStorage --------
interface HeldSale {
  id: string;
  ts: number;
  customerId: string;
  customerName?: string;
  discount: string;
  lines: { p: PosProduct; qty: number; discount: number; manual: boolean }[];
}
const HELD_KEY = "hgs-held-sales";
function loadHeld(): HeldSale[] {
  if (typeof localStorage === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(HELD_KEY) ?? "[]") as HeldSale[]; } catch { return []; }
}
function saveHeld(h: HeldSale[]) {
  try { localStorage.setItem(HELD_KEY, JSON.stringify(h)); } catch { /* quota/full — ignore */ }
}

export interface PosProduct {
  variant_id: string;
  product_id: string;
  name: string;
  label: string;
  sku: string;
  barcode: string | null;
  price: number;
  cost: number;
  /** Product's default discount — auto-filled per cart line (editable). */
  disc_type: "PERCENT" | "FIXED" | null;
  disc_value: number;
  reorder_point: number;
  available: number;
  category_id: string | null;
  /** Effective image (variant photo, else product photo). */
  image_url: string | null;
  /** Base unit (e.g. Pcs / Kg) — shown on the invoice Qty column. */
  unit: string | null;
}

function tone(p: PosProduct) { return p.available <= 0 ? "out_of_stock" : p.available <= (p.reorder_point || 5) ? "low_stock" : "in_stock"; }

function toPos(it: CatalogItem): PosProduct {
  return {
    variant_id: it.variant_id,
    product_id: it.product_id,
    name: it.product_name,
    label: it.has_variants ? it.label : "",
    sku: it.sku,
    barcode: it.barcode,
    price: it.price,
    cost: it.avg_cost || it.cost,
    disc_type: it.disc_type ?? null,
    disc_value: Number(it.disc_value) || 0,
    reorder_point: Number(it.reorder_point) || 0,
    available: it.available,
    category_id: it.category_id,
    image_url: it.image_url ?? null,
    unit: it.unit ?? null,
  };
}

export function PosClient({
  products: initialProducts, categories, barcodeIndex: initialBarcodeIndex, customers, store, cashierName,
  promotions = [], categoryParents = {},
}: {
  products: PosProduct[];
  categories: { id: string; name: string }[];
  barcodeIndex: Record<string, string>;
  customers: { id: string; name: string; phone: string | null; address?: string | null }[];
  store: StoreSettings;
  cashierName: string;
  promotions?: Promotion[];
  categoryParents?: Record<string, string | null>;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();

  // A completed sale (or synced offline sale) changed on-hand in the DB. Besides
  // re-rendering server components (router.refresh), drop the session-cached
  // ["products"] TanStack data so the Products tab reflects the new stock the
  // moment the cashier switches to it — no manual refresh.
  const invalidateStockViews = () => {
    queryClient.invalidateQueries({ queryKey: ["products"] });
  };

  // Local catalogue cache: instant scan/search, live stock, works offline.
  // Falls back to the server-rendered props until the cache has hydrated.
  const snap = useCatalog();
  const products = useMemo(
    () => (snap ? snap.items.filter((i) => i.active).map(toPos) : initialProducts),
    [snap, initialProducts],
  );
  const barcodeIndex = useMemo(() => {
    if (!snap) return initialBarcodeIndex;
    const m: Record<string, string> = {};
    for (const it of snap.items) if (it.barcode) m[it.barcode] = it.variant_id;
    return m;
  }, [snap, initialBarcodeIndex]);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [cart, setCart] = useState<Map<string, CartEntry>>(new Map());
  const [customerId, setCustomerId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const setCustomer = (name: string, id: string) => { setCustomerName(name); setCustomerId(id); };
  // Customers created inline at the till this session (so they show up linked
  // immediately without a server refresh).
  const [extraCustomers, setExtraCustomers] = useState<{ id: string; name: string; phone: string | null; address?: string | null }[]>([]);
  const allCustomers = useMemo(() => [...extraCustomers, ...customers], [extraCustomers, customers]);
  async function createCustomer(name: string, phone: string | null) {
    const res = await quickAddCustomer(name, phone);
    if (res && "error" in res && res.error) { toast(res.error, "error"); return null; }
    if (res && "customer" in res && res.customer) {
      setExtraCustomers((x) => [res.customer, ...x]);
      toast("Customer added");
      return res.customer;
    }
    return null;
  }
  const [discount, setDiscount] = useState("");
  const [processing, setProcessing] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [returnsOpen, setReturnsOpen] = useState(false);
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);
  const [lastReceipt, setLastReceipt] = useState<ReceiptData | null>(null);
  const [highlight, setHighlight] = useState(0);
  // ---- Phase B: fast keyboard qty/discount entry -------------------------
  // Exactly ONE cart line is ever in edit mode, so a single pair of inputs is
  // rendered (inside that line) and a single pair of refs owns focus. That is
  // what makes the flow safe with many lines in the cart: there is no per-line
  // input to mis-target, and nothing to shift focus onto a neighbouring line.
  const [editing, setEditing] = useState<{ id: string; field: "qty" | "disc" } | null>(null);
  const [qtyDraft, setQtyDraft] = useState("");
  const [discDraft, setDiscDraft] = useState("");
  // The line a bare F3 targets: the one most recently scanned / added / edited.
  const [activeLine, setActiveLine] = useState<string | null>(null);
  const [held, setHeld] = useState<HeldSale[]>([]);
  const [heldOpen, setHeldOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [online, setOnline] = useState(true);
  const [queued, setQueued] = useState(0);
  const flushing = useRef(false);
  const idemKey = useRef("");
  // Synchronous in-flight guard for the F9 fast path. `processing` is React
  // state, so two F9 presses in the same tick would both still observe it as
  // false and fire two checkouts; a ref flips immediately and is the only thing
  // that can actually stop a double charge.
  const charging = useRef(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [lastScan, setLastScan] = useState<{ ok: boolean; text: string } | null>(null);
  const scanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // ---- Phase A: the POS shell is sized to the REAL space left under the
  // sticky topbar, measured rather than assumed. The old fixed
  // `h-[calc(100vh-7rem)]` guessed the chrome height; whenever the guess was
  // even a few pixels short the shell overflowed and the whole PAGE scrolled
  // instead of the panels. Measuring (and re-measuring on resize/zoom) keeps
  // the header, totals and action buttons pinned no matter how long the cart
  // gets — only the product list and the cart list scroll, each on its own.
  const shellRef = useRef<HTMLDivElement>(null);
  const [shellHeight, setShellHeight] = useState<number | undefined>();
  useEffect(() => {
    const measure = () => {
      const el = shellRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY - window.scrollY;
      // Leave the shell's own bottom gutter (the admin <main> pb-6 = 24px).
      const h = Math.max(360, Math.round(window.innerHeight - top - 24));
      setShellHeight((prev) => (prev === h ? prev : h));
    };
    measure();
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro && shellRef.current?.parentElement) ro.observe(shellRef.current.parentElement);
    return () => { window.removeEventListener("resize", measure); ro?.disconnect(); };
  }, []);
  const byId = useMemo(() => new Map(products.map((p) => [p.variant_id, p])), [products]);
  const byBarcode = useMemo(() => {
    const m = new Map<string, PosProduct>();
    for (const p of products) if (p.barcode) m.set(p.barcode, p);
    return m;
  }, [products]);

  function flash(ok: boolean, text: string) {
    setLastScan({ ok, text });
    if (scanTimer.current) clearTimeout(scanTimer.current);
    scanTimer.current = setTimeout(() => setLastScan(null), 2200);
  }

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return products.filter((p) => {
      if (cat && p.category_id !== cat) return false;
      if (!t) return true;
      return p.name.toLowerCase().includes(t) || p.label.toLowerCase().includes(t) || p.sku.toLowerCase().includes(t) || (p.barcode ?? "").includes(t);
    });
  }, [products, q, cat]);

  // keep the keyboard highlight within the (re-filtered) grid
  useEffect(() => { setHighlight((h) => Math.min(h, Math.max(0, filtered.length - 1))); }, [filtered.length]);

  // load parked carts (this device) once
  useEffect(() => { setHeld(loadHeld()); }, []);

  // open Returns prefilled when arriving from an invoice search (?receipt=…)
  const returnReceipt = useSearchParams().get("receipt") ?? undefined;
  useEffect(() => { if (returnReceipt) setReturnsOpen(true); }, [returnReceipt]);

  // Clamp a line's discount to its gross (qty × price), keeping it valid.
  function clampDisc(p: PosProduct, qty: number, discount: number) {
    return Math.min(Math.max(round2px(discount), 0), round2px(p.price * qty));
  }

  function add(p: PosProduct, delta = 1) {
    setActiveLine(p.variant_id); // F3 edits the line you just scanned
    setCart((c) => {
      const next = new Map(c);
      const entry = next.get(p.variant_id);
      const cur = entry?.qty ?? 0;
      const qty = Math.max(0, cur + delta);
      if (qty === 0) { next.delete(p.variant_id); return next; }
      const manual = entry?.manual ?? false;
      // Auto lines track the product's default discount as qty changes; manual
      // (cashier-set) lines keep their amount, just re-clamped to the new gross.
      const discount = manual ? clampDisc(p, qty, entry?.discount ?? 0) : autoLineDiscount(p, qty);
      next.set(p.variant_id, { p, qty, discount, manual });
      return next;
    });
  }
  function setQty(id: string, qty: number) {
    setCart((c) => {
      const next = new Map(c);
      const entry = next.get(id);
      if (!entry) return next;
      if (qty <= 0) { next.delete(id); return next; }
      const discount = entry.manual ? clampDisc(entry.p, qty, entry.discount) : autoLineDiscount(entry.p, qty);
      next.set(id, { ...entry, qty, discount });
      return next;
    });
  }
  // Cashier edits a line's discount → fixed (manual) until removed.
  function setLineDiscount(id: string, value: number) {
    setCart((c) => {
      const next = new Map(c);
      const entry = next.get(id);
      if (!entry) return next;
      next.set(id, { ...entry, discount: clampDisc(entry.p, entry.qty, value), manual: true });
      return next;
    });
  }
  // Remove this line's discount entirely (charge full price for this customer).
  function clearLineDiscount(id: string) {
    setCart((c) => {
      const next = new Map(c);
      const entry = next.get(id);
      if (!entry) return next;
      next.set(id, { ...entry, discount: 0, manual: true });
      return next;
    });
  }

  // ---- Phase B: quantity + discount without repeated clicking -------------
  // Flow: F3 (or clicking a cart line) → Qty input → Enter → Discount input →
  // Enter → both applied, focus back on the scan box ready for the next scan.
  /** Put focus back on the scan/search box and leave edit mode. */
  function focusScan() {
    setEditing(null);
    // after the edit inputs unmount, so the browser doesn't steal focus back
    requestAnimationFrame(() => searchRef.current?.focus());
  }

  /** Return focus to the scan box after an action, without leaving edit mode. */
  function focusScanSoon() {
    requestAnimationFrame(() => {
      const el = searchRef.current;
      if (!el || document.activeElement === el) return;
      const active = document.activeElement as HTMLElement | null;
      if (isDeliberateField(active)) return; // never steal a field being typed in
      el.focus();
    });
  }

  /** Enter quantity-edit mode for a cart line (defaults to the active line). */
  function beginEdit(id?: string) {
    const target = id ?? activeLine ?? [...cart.keys()].at(-1);
    if (!target) return;
    const entry = cart.get(target);
    if (!entry) return;
    setActiveLine(target);
    setQtyDraft(String(entry.qty));
    setDiscDraft(entry.discount ? String(round2(entry.discount)) : "");
    setEditing({ id: target, field: "qty" });
  }

  /** Apply the typed quantity and advance to this same line's discount. */
  function commitQty() {
    if (!editing) return;
    const entry = cart.get(editing.id);
    if (!entry) return focusScan();
    const raw = qtyDraft.trim();
    const n = raw === "" ? entry.qty : Number(raw);
    if (!Number.isFinite(n) || n < 0) { beepError(); return; }
    if (n <= 0) { setQty(editing.id, 0); beepOk(); return focusScan(); } // 0 removes the line
    // Clamp to what's actually on hand so checkout can't fail on stock later.
    const capped = Math.min(n, entry.p.available);
    if (capped < n) flash(false, `Only ${entry.p.available} of ${entry.p.name} in stock`);
    setQty(editing.id, capped);
    setQtyDraft(String(capped));
    setEditing({ id: editing.id, field: "disc" });
  }

  /** Apply the typed discount (blank = 0) and hand focus back to the scan box. */
  function commitDisc() {
    if (!editing) return;
    const raw = discDraft.trim();
    const n = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(n) || n < 0) { beepError(); return; }
    if (n === 0) clearLineDiscount(editing.id);
    else setLineDiscount(editing.id, n);
    beepOk();
    focusScan();
  }

  // ---- Phase D: ONE add-to-cart path for every way an item can arrive -----
  // A hardware scan, a camera scan, a typed barcode, a product name typed into
  // the search box and a clicked card all funnel through addResolved(), so they
  // share the identical stock check, beep, on-screen confirmation, search reset
  // and scan-box refocus. Previously the search box had its own separate path that only
  // fired when the typed text matched exactly ONE product, which is why
  // "type a name + Enter" so often did nothing.
  function addResolved(p: PosProduct, qty = 1, note?: string): boolean {
    if (p.available <= 0) {
      beepError();
      flash(false, `${p.name} is out of stock`);
      return false;
    }
    add(p, qty);
    setQ("");
    beepOk();
    flash(true, note ?? `Added ${p.name}`);
    focusScanSoon();
    return true;
  }

  /** Resolve a code against the barcode indexes (tolerant of leading zeros). */
  function findByBarcode(raw: string): { p?: PosProduct; parsed: ReturnType<typeof parseScan> } {
    const parsed = parseScan(raw);
    const looseBarcode = (code: string): PosProduct | undefined => {
      if (!/^\d+$/.test(code)) return undefined;
      const bare = code.replace(/^0+/, "") || "0";
      for (const [bc, prod] of byBarcode) if (/^\d+$/.test(bc) && (bc.replace(/^0+/, "") || "0") === bare) return prod;
      return undefined;
    };
    const p =
      byBarcode.get(parsed.lookupKey) ||
      byBarcode.get(parsed.barcode) ||
      (barcodeIndex[parsed.lookupKey] ? byId.get(barcodeIndex[parsed.lookupKey]) : undefined) ||
      (barcodeIndex[parsed.barcode] ? byId.get(barcodeIndex[parsed.barcode]) : undefined) ||
      looseBarcode(parsed.lookupKey) ||
      looseBarcode(parsed.barcode);
    return { p, parsed };
  }

  // Single resolve path for MACHINE input: hardware scanner, camera, or a code
  // typed into the box. Deliberately strict — an unrecognised code is reported,
  // never guessed at, so a mis-read never silently bills the wrong item.
  function handleScan(raw: string) {
    const { p, parsed } = findByBarcode(raw);
    if (!p) {
      // still allow an unambiguous text match (e.g. a typed SKU)
      const t = raw.trim().toLowerCase();
      const matches = products.filter(
        (x) => x.name.toLowerCase().includes(t) || x.sku.toLowerCase().includes(t) || (x.barcode ?? "").includes(t),
      );
      if (matches.length === 1) { addResolved(matches[0]); return; }
      beepError();
      flash(false, `Unknown code: ${parsed.barcode}`);
      focusScanSoon();
      return;
    }
    const qty = parsed.isWeightEmbedded && parsed.weight ? parsed.weight : 1;
    addResolved(p, qty, parsed.isWeightEmbedded ? `${p.name} · ${qty.toFixed(3)} kg` : undefined);
  }

  /**
   * Enter in the search box. Tries the barcode indexes first (so a hand-typed
   * barcode behaves exactly like a scan), then falls back to the product the
   * cashier is actually looking at: the highlighted card when it's still in the
   * result list, otherwise the best match in the current (category-filtered)
   * results — exact SKU/name first, then a name that starts with the term, then
   * the top result. Whatever it picks goes through the same addResolved().
   */
  function submitSearch() {
    const term = q.trim();
    if (!term) {
      const p = filtered[highlight]; // Enter on an empty box adds the highlighted card
      if (p) addResolved(p);
      return;
    }

    const { p: byCode } = findByBarcode(term);
    if (byCode) { handleScan(term); return; }

    const t = term.toLowerCase();
    const pool = filtered.length ? filtered : products.filter(
      (x) => x.name.toLowerCase().includes(t) || x.label.toLowerCase().includes(t) || x.sku.toLowerCase().includes(t) || (x.barcode ?? "").includes(t),
    );
    if (!pool.length) {
      beepError();
      flash(false, `No product matches “${term}”`);
      return;
    }
    const exact = pool.find((x) => x.sku.toLowerCase() === t || x.name.toLowerCase() === t);
    const highlighted = filtered[highlight];
    const starts = pool.find((x) => x.name.toLowerCase().startsWith(t));
    const pick = exact
      ?? (highlighted && pool.includes(highlighted) ? highlighted : undefined)
      ?? starts
      ?? pool[0];
    addResolved(pick);
  }

  function onScan(e: React.KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    submitSearch();
  }

  // Own scans while POS is open (the global scan-anywhere sheet is suppressed).
  // Fires only when no field is focused, so it never double-counts the search box.
  useScanHandler((code) => handleScan(code));

  const lines = [...cart.values()];
  // Promotions (time-bound sales / category offers) layered on top of each
  // line's everyday default discount. Computed with the same engine the server
  // re-runs at checkout, so the previewed total matches what's charged. (Coupon
  // codes were removed from the cart in Part 3 — only automatic promos apply.)
  const promo: PromoResult = computePromotions(
    lines.map((l) => ({
      key: l.p.variant_id,
      product_id: l.p.product_id,
      category_ids: [l.p.category_id, l.p.category_id ? categoryParents[l.p.category_id] : null].filter(Boolean) as string[],
      qty: l.qty,
      unit_price: l.p.price,
    })),
    promotions,
    {},
  );
  const manualBill = Number(discount) || 0;
  const { subtotal, discount: disc, tax, total } = computeTotals(
    lines.map((l) => ({ qty: l.qty, unit_price: l.p.price, discount: l.discount })),
    manualBill + promo.totalDiscount,
    store.tax_percent,
  );
  const count = lines.reduce((s, l) => s + l.qty, 0);
  // Margin guard: warn when line + bill discounts push the sale below total cost.
  const totalCost = lines.reduce((s, l) => s + (l.p.cost > 0 ? l.p.cost * l.qty : 0), 0);
  const belowCost = totalCost > 0 && subtotal - disc < totalCost;

  function openPayment() {
    if (!lines.length) return toast("Cart is empty", "error");
    idemKey.current = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    setSheetOpen(false);
    setPaymentOpen(true);
  }

  /**
   * The ONE checkout path. Both the manual payment sheet and the F9 fast cash
   * path call this — same server action, same stock validation, same stock
   * moves, same receipt construction. `autoPrint` only changes what happens
   * AFTER the sale is recorded: the manual flow shows the receipt dialog, the
   * fast path prints straight away and resets for the next customer.
   *
   * Returns true when the sale was recorded (or queued offline), false when it
   * was rejected — so the fast path knows whether to confirm or stay put.
   */
  async function checkout(
    payments: PaymentInput[],
    change: number,
    { autoPrint = false }: { autoPrint?: boolean } = {},
  ): Promise<boolean> {
    if (!lines.length) return false;
    const cartLines = lines; // snapshot for the receipt before we clear
    const cust = allCustomers.find((c) => c.id === customerId) ?? null;
    // The free-typed name (or the linked customer's name) saved on the sale.
    const saleCustomerName = (customerName.trim() || cust?.name || "Walk-in customer");
    const payload: QueuedSalePayload = {
      lines: cartLines.map((l) => ({
        variant_id: l.p.variant_id, product_id: l.p.product_id, qty: l.qty, unit_price: l.p.price,
        discount: l.discount,
      })),
      customer_id: customerId || null, customer_name: saleCustomerName,
      payments, discount: Number(discount) || 0,
    };
    const makeReceipt = (receiptNo: string, sub: number, dis: number, tx: number, tot: number): ReceiptData => ({
      store: {
        name: store.name, address: store.address, phone: store.phone, logo_url: store.logo_url,
        header: store.receipt_header, footer: store.receipt_footer, ntn: store.ntn,
        disclaimer: store.receipt_disclaimer,
      },
      receipt_no: receiptNo,
      date: new Date().toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" }),
      cashier: cashierName,
      customer: saleCustomerName,
      customer_address: cust?.address ?? null,
      items: cartLines.map((l) => ({ name: l.p.name, label: l.p.label || undefined, qty: l.qty, unit: l.p.unit, unit_price: l.p.price, discount: l.discount, line_total: round2(l.p.price * l.qty) })),
      subtotal: sub, discount: dis, tax: tx, tax_percent: store.tax_percent, total: tot,
      payments, change,
    });

    setProcessing(true);
    try {
      if (typeof navigator !== "undefined" && !navigator.onLine) throw new Error("offline");
      const res = await checkoutSale({ ...payload, idempotency_key: idemKey.current });
      setProcessing(false);
      if ("error" in res) {
        // A real rejection — insufficient stock, a payment mismatch, an auth
        // failure. The cart is deliberately KEPT so nothing is lost and nothing
        // partial was charged. Identical for both paths.
        toast(res.error, "error");
        return false;
      }
      finishSale(makeReceipt(res.receipt_no, res.subtotal, res.discount, res.tax, res.total), autoPrint);
      void ensureCatalog({ force: true });
      router.refresh();
      invalidateStockViews();
      return true;
    } catch {
      // network unreachable — queue locally and print a provisional receipt
      await enqueueSale({ idempotency_key: idemKey.current, ts: Date.now(), payload });
      setProcessing(false);
      finishSale(makeReceipt(`OFFLINE-${idemKey.current.slice(0, 8)}`, subtotal, disc, tax, total), autoPrint);
      void refreshQueue();
      toast("Offline — sale queued, will sync on reconnect", "error");
      return true;
    }
  }

  /**
   * F9 fast path — the common case, a plain cash sale, in one keystroke.
   *
   * Charges the cart as CASH through the very same checkout() above (so stock
   * validation, the ledger and the receipt are all identical to the manual
   * flow), prints immediately, and resets for the next customer. Anything that
   * is NOT a plain cash sale — udhaar, JazzCash, Easypaisa, a split tender —
   * still goes through the Charge button / F4 payment sheet.
   */
  async function fastCashCheckout() {
    // Guard order matters: the synchronous ref first, so a second F9 in the
    // same tick cannot slip past while the first is still awaiting the server.
    if (charging.current || processing) return;
    if (!lines.length) return;
    charging.current = true;
    const amount = round2(total); // snapshot — the cart is cleared on success
    try {
      idemKey.current = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      const ok = await checkout([{ method: "CASH", amount }], 0, { autoPrint: true });
      if (ok) {
        beepOk();
        flash(true, `Charged Cash — ${formatPKR(amount)}`);
      } else {
        beepError(); // checkout() already surfaced the reason as a toast
      }
    } finally {
      charging.current = false;
    }
  }

  function finishSale(receipt: ReceiptData, autoPrint = false) {
    setLastReceipt(receipt); // kept so F9 can reprint after the sale is done
    setPaymentOpen(false);
    setCart(new Map()); setDiscount("");

    if (!autoPrint) {
      setReceiptData(receipt); // manual flow: show the receipt dialog as before
      return;
    }

    // Fast path: no dialog at all. Print, clear the customer and hand focus back
    // to the scan box — the same reset finishReceipt() performs when the dialog
    // is dismissed, just without requiring the dismissal.
    setReceiptData(null);
    setCustomer("", "");
    try {
      printReceiptHtml(receipt);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Sale saved, but the receipt could not be opened for printing", "error");
    }
    focusScanSoon();
  }

  async function refreshQueue() { setQueued(await queueCount()); }

  async function flushQueue() {
    if (flushing.current) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    flushing.current = true;
    try {
      for (const s of await getQueue()) {
        try {
          const res = await checkoutSale({ ...s.payload, idempotency_key: s.idempotency_key });
          await removeFromQueue(s.idempotency_key);
          if ("error" in res) toast(`A queued sale couldn't sync: ${res.error}`, "error");
        } catch {
          break; // still offline — leave the rest queued
        }
      }
    } finally {
      flushing.current = false;
      await refreshQueue();
      void ensureCatalog({ force: true });
      router.refresh();
      invalidateStockViews();
    }
  }

  // Track connectivity and flush the queue on reconnect / load.
  useEffect(() => {
    setOnline(navigator.onLine);
    void refreshQueue();
    void flushQueue();
    const goOnline = () => { setOnline(true); void flushQueue(); };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => { window.removeEventListener("online", goOnline); window.removeEventListener("offline", goOffline); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function finishReceipt() {
    setReceiptData(null);
    setCustomer("", "");
    searchRef.current?.focus();
  }

  // ---- Phase D: the scan box is ALWAYS ready ------------------------------
  // Root cause of "press F2 first, then it scans": the hardware-wedge listener
  // decides a burst is a scan purely from keystroke timing. When it judged a
  // burst too slow (a slower scanner, a jittery USB hub, a busy render) the
  // characters fell through to whatever had focus — and if that was a button or
  // the document body, they went nowhere and the scan was silently lost. F2
  // "fixed" it because it put focus back in the search box, where the fallback
  // path (characters land in the field, Enter submits it) works.
  //
  // So the search box is kept focused as the app's resting state: after adding
  // an item, after any dialog closes, when the tab or window regains focus, and
  // on a low-frequency self-heal sweep for anything else that stole it. It
  // never takes focus away from a field the cashier deliberately typed into
  // (the quantity/discount inputs, the customer box, the payment amounts).
  const anyOverlayOpen = paymentOpen || returnsOpen || cameraOpen || !!receiptData || heldOpen || shortcutsOpen;
  useEffect(() => {
    if (anyOverlayOpen || editing) return;
    const refocus = () => {
      const el = searchRef.current;
      if (!el || document.activeElement === el) return;
      if (isDeliberateField(document.activeElement as HTMLElement | null)) return;
      el.focus();
    };
    refocus();
    const heal = window.setInterval(refocus, 800);
    window.addEventListener("focus", refocus);
    document.addEventListener("visibilitychange", refocus);
    return () => {
      window.clearInterval(heal);
      window.removeEventListener("focus", refocus);
      document.removeEventListener("visibilitychange", refocus);
    };
  }, [anyOverlayOpen, editing]);

  // ---- Hold / resume ----
  function holdSale() {
    if (!lines.length) return toast("Cart is empty", "error");
    const entry: HeldSale = {
      id: crypto.randomUUID?.() ?? `${Date.now()}`,
      ts: Date.now(),
      customerId,
      customerName,
      discount,
      lines: lines.map((l) => ({ p: l.p, qty: l.qty, discount: l.discount, manual: l.manual })),
    };
    const next = [entry, ...held];
    setHeld(next); saveHeld(next);
    setCart(new Map()); setDiscount(""); setCustomer("", "");
    toast("Sale held");
    searchRef.current?.focus();
  }
  function resumeSale(id: string) {
    const entry = held.find((h) => h.id === id);
    if (!entry) return;
    let next = held.filter((h) => h.id !== id);
    // park the current cart first (if any) so nothing is lost
    if (cart.size) {
      next = [{
        id: crypto.randomUUID?.() ?? `${Date.now()}`,
        ts: Date.now(), customerId, customerName, discount,
        lines: lines.map((l) => ({ p: l.p, qty: l.qty, discount: l.discount, manual: l.manual })),
        }, ...next];
    }
    setHeld(next); saveHeld(next);
    setCart(new Map(entry.lines.map((l) => [l.p.variant_id, { p: l.p, qty: l.qty, discount: l.discount, manual: l.manual }])));
    setDiscount(entry.discount);
    setCustomer(entry.customerName ?? "", entry.customerId);
    setHeldOpen(false);
    searchRef.current?.focus();
  }
  function deleteHeld(id: string) {
    const next = held.filter((h) => h.id !== id);
    setHeld(next); saveHeld(next);
  }

  // ---- Phase C: print the bill straight from the billing screen ----------
  // The receipt that F9 / Ctrl+P prints: the sale just completed if its modal
  // is still up, otherwise the last one printed this session.
  function printCurrentReceipt() {
    const target = receiptData ?? lastReceipt;
    // Two separate conditions, deliberately: nothing to print at all, versus a
    // receipt that exists but has no lines. Both must be a message, never a
    // throw — an exception raised inside a keydown handler is not caught by
    // React's event machinery and takes the whole screen down to the route
    // error boundary.
    if (!isPrintableReceipt(target)) {
      flash(false, target ? "That bill has no items to print" : "Nothing to print yet");
      return;
    }
    try {
      printReceiptHtml(target);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not open the receipt for printing", "error");
    }
  }

  // ---- Keyboard shortcuts -------------------------------------------------
  // Run one resolved action. Every branch gives FEEDBACK: the old handler
  // silently did nothing when the cart was empty or no receipt existed yet,
  // which on a freshly loaded till is most keys, most of the time — and is
  // indistinguishable from "the shortcut is broken".
  function runShortcut(action: PosAction) {
    const anyModal = paymentOpen || returnsOpen || cameraOpen || !!receiptData;
    switch (action) {
      case "focusScan":
        focusScan();
        flash(true, "Ready to scan");
        return;
      case "editLine":
        if (anyModal) return;
        if (!cart.size) { beepError(); flash(false, "Cart is empty — scan an item first"); return; }
        beginEdit();
        return;
      case "checkout":
        if (anyModal) return;
        if (!cart.size) { beepError(); flash(false, "Cart is empty — nothing to charge"); return; }
        openPayment();
        return;
      case "print":
        // F9 is state-aware. An uncharged cart with items means "charge this as
        // cash and print it"; anything else means "print / reprint what's
        // already been charged". A modal open means the cashier is mid manual
        // flow, so the fast path stays out of the way.
        if (!anyModal && lines.length) { void fastCashCheckout(); return; }
        printCurrentReceipt();
        return;
      case "printOnly":
        // Ctrl+P — reprint only, never a charge. See pos-shortcuts.ts.
        printCurrentReceipt();
        return;
      case "clearOrCancel":
        if (shortcutsOpen) { setShortcutsOpen(false); return; }
        if (heldOpen) { setHeldOpen(false); return; }
        if (editing) { focusScan(); return; }
        if (anyModal) return;
        if (cart.size) { setCart(new Map()); setDiscount(""); flash(false, "Sale cleared"); }
        return;
      case "toggleHelp":
        if (anyModal) return;
        setShortcutsOpen((v) => !v);
        return;
      case "moveNext":
        if (anyModal) return;
        setHighlight((h) => Math.min(h + 1, filtered.length - 1));
        return;
      case "movePrev":
        if (anyModal) return;
        setHighlight((h) => Math.max(h - 1, 0));
        return;
      case "incQty": {
        if (anyModal) return;
        const p = filtered[highlight];
        if (p && p.available > 0) add(p, 1);
        return;
      }
      case "decQty": {
        if (anyModal) return;
        const p = filtered[highlight];
        if (p) add(p, -1);
        return;
      }
      // The browser owns F3 / F6, so those are no longer bound to an action.
      // If the keystroke does reach us, point the cashier at the new key.
      case "legacyEditHint":
        flash(false, `F3 is a browser key — press ${RETIRED_KEYS.F3.replacement} to edit quantity`);
        return;
      case "legacyPrintHint":
        flash(false, `F6 is a browser key — press ${RETIRED_KEYS.F6.replacement} to print`);
        return;
    }
  }

  // The handler is re-created every render (it closes over current state), but
  // the LISTENER below is registered exactly once. Routing through a ref is what
  // makes that safe.
  const shortcutRef = useRef<(e: KeyboardEvent) => void>(() => {});
  shortcutRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    const inCartEdit = !!t && typeof t.closest === "function" && !!t.closest("[data-cart-edit]");
    const action = resolveShortcut(e, {
      inCartEdit,
      inField: !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable),
      searchEmpty: q === "",
      anyModal: paymentOpen || returnsOpen || cameraOpen || !!receiptData,
    });

    if (typeof window !== "undefined" && window.localStorage.getItem("posKeys") === "1") {
      // Diagnostic mode: proves whether a keystroke reached the app at all, and
      // what it was understood to mean. See the POS shortcut notes.
      console.info("[pos-keys]", {
        key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey,
        repeat: e.repeat, target: t?.tagName, inCartEdit, action: action ?? "(ignored)",
      });
    }

    if (!action) return;
    // Only ever preventDefault for a key we actually handle, so typing and the
    // barcode wedge are untouched.
    e.preventDefault();
    runShortcut(action);
  };

  // Registered ONCE for the life of the page. The empty dependency array is the
  // point: the previous version listed cart / q / filtered / highlight as
  // dependencies, so the listener detached and reattached on almost every render
  // and on every Fast Refresh — a window in which no shortcut worked at all.
  //
  // Two phases, deliberately:
  //   capture — F-keys, Escape, arrows, Ctrl combos. First position in the event
  //             path, so nothing downstream can swallow a shortcut.
  //   bubble  — single printable characters (+ - = _ *). These must stay BEHIND
  //             the hardware scanner's stopPropagation() shield, or every hyphen
  //             in a scanned code like "GRO-SUG-1" would fire "decrease quantity".
  useEffect(() => {
    const onCapture = (e: KeyboardEvent) => { if (!isCharacterKey(e)) shortcutRef.current(e); };
    const onBubble = (e: KeyboardEvent) => { if (isCharacterKey(e)) shortcutRef.current(e); };
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("keydown", onBubble, false);
    return () => {
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("keydown", onBubble, false);
    };
  }, []);

  return (
    <div
      ref={shellRef}
      style={shellHeight ? { height: shellHeight } : undefined}
      className={cn(
        // The POS shell owns its own height so the PAGE never scrolls: the two
        // panels below are the only scrollable areas (see Phase A notes).
        "grid grid-cols-1 gap-4 overflow-hidden lg:grid-cols-[minmax(0,1fr)_380px]",
        !shellHeight && "h-[calc(100dvh-7rem)]",
      )}
    >
      {/* product area */}
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="mb-3 flex shrink-0 items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
            <Input
              ref={searchRef}
              data-scan-box="1"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onScan}
              placeholder="Scan barcode or search product…"
              className="h-12 pl-10 text-base"
            />
          </div>
          <button
            type="button"
            onClick={() => setCameraOpen(true)}
            title="Scan with camera"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-text-secondary transition-colors hover:bg-surface-2"
          >
            <Camera className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => setReturnsOpen(true)}
            title="Return / refund"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-text-secondary transition-colors hover:bg-surface-2"
          >
            <RotateCcw className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => setHeldOpen((o) => !o)}
            title="Held sales"
            className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-text-secondary transition-colors hover:bg-surface-2"
          >
            <Clock className="h-5 w-5" />
            {held.length > 0 && (
              <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-500 px-1 text-[10px] font-bold text-white">{held.length}</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setShortcutsOpen(true)}
            title="Keyboard shortcuts (?)"
            className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-text-secondary transition-colors hover:bg-surface-2 lg:flex"
          >
            <Keyboard className="h-5 w-5" />
          </button>
        </div>

        {/* offline / sync status */}
        {(!online || queued > 0) && (
          <div className="mb-3 flex shrink-0 items-center gap-2 rounded-xl border border-amber-icon/30 bg-amber-tile px-3 py-2 text-sm text-amber-text">
            <WifiOff className="h-4 w-4 shrink-0" />
            <span className="flex-1">
              {online
                ? `${queued} sale${queued !== 1 ? "s" : ""} waiting to sync`
                : `Offline — sales are queued${queued > 0 ? ` (${queued})` : ""} and will sync on reconnect`}
            </span>
            {online && queued > 0 && (
              <button onClick={() => flushQueue()} className="flex items-center gap-1 font-medium underline">
                <RefreshCw className="h-3.5 w-3.5" /> Sync now
              </button>
            )}
          </div>
        )}

        {/* per-scan confirmation / warning */}
        {lastScan && (
          <div className={cn(
            "mb-3 flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-sm animate-fade-in",
            lastScan.ok
              ? "border-green-icon/30 bg-green-tile text-green-text"
              : "border-coral-icon/30 bg-coral-tile text-coral-text",
          )}>
            {lastScan.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
            <span className="truncate">{lastScan.text}</span>
            <ScanLine className="ml-auto h-4 w-4 opacity-60" />
          </div>
        )}

        <div className="mb-3 flex shrink-0 gap-2 overflow-x-auto pb-1 scrollbar-thin">
          <Chip active={cat === ""} onClick={() => setCat("")}>All</Chip>
          {categories.map((c) => <Chip key={c.id} active={cat === c.id} onClick={() => setCat(c.id)}>{c.name}</Chip>)}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin pb-2">
          {filtered.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-text-tertiary">No products match.</div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {filtered.map((p, i) => {
                const inCart = cart.get(p.variant_id)?.qty ?? 0;
                const out = p.available <= 0;
                const isHighlight = i === highlight;
                return (
                  <div key={p.variant_id}
                    className={cn("group relative flex flex-col rounded-2xl border bg-surface p-3 text-left shadow-card transition-all",
                      out ? "border-border opacity-60" : "border-border hover:-translate-y-0.5 hover:shadow-drawer",
                      inCart > 0 && "ring-2 ring-brand-500",
                      isHighlight && inCart === 0 && "ring-2 ring-brand-300")}>
                    <button disabled={out} onClick={() => { setHighlight(i); add(p); }} className="flex flex-1 flex-col text-left disabled:cursor-not-allowed">
                      <div className="mb-2 flex h-20 items-center justify-center overflow-hidden rounded-xl bg-surface-2 text-text-tertiary">
                        {p.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.image_url} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <Package className="h-7 w-7" />
                        )}
                      </div>
                      <h3 className="line-clamp-2 text-sm font-medium leading-tight text-text-primary">{p.name}</h3>
                      {p.label && <p className="mt-0.5 text-xs text-text-tertiary">{p.label}</p>}
                      <div className="mt-auto flex items-end justify-between pt-2">
                        <span className="tnum font-heading text-base font-bold text-text-primary">{formatPKR(p.price)}</span>
                        <StatusPill status={tone(p)} className="px-2 py-0.5 text-[10px]" />
                      </div>
                    </button>
                    {inCart > 0 && (
                      <div className="mt-2 flex items-center justify-between rounded-lg bg-brand-50/60 p-1">
                        <button onClick={() => add(p, -1)} className="flex h-7 w-7 items-center justify-center rounded-md bg-surface text-text-primary shadow-sm"><Minus className="h-4 w-4" /></button>
                        <span className="tnum text-sm font-semibold text-text-primary">{inCart}</span>
                        <button onClick={() => add(p, 1)} disabled={inCart >= p.available} className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-500 text-white disabled:opacity-40"><Plus className="h-4 w-4" /></button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* desktop cart */}
      <div className="hidden min-h-0 lg:flex lg:min-h-0 lg:flex-col lg:overflow-hidden">
        <CartPanel
          lines={lines} subtotal={subtotal} discount={discount} setDiscount={setDiscount} total={total} tax={tax} taxPercent={store.tax_percent}
          belowCost={belowCost} promo={promo}
          customers={allCustomers} customerId={customerId} customerName={customerName} setCustomer={setCustomer} onCreateCustomer={createCustomer}
          setQty={setQty} remove={(id) => setQty(id, 0)} setLineDiscount={setLineDiscount} clearLineDiscount={clearLineDiscount}
          processing={processing} onCharge={openPayment} onHold={holdSale}
          editing={editing} qtyDraft={qtyDraft} setQtyDraft={setQtyDraft} discDraft={discDraft} setDiscDraft={setDiscDraft}
          beginEdit={beginEdit} commitQty={commitQty} commitDisc={commitDisc} cancelEdit={focusScan} activeLine={activeLine}
        />
      </div>

      {/* mobile cart trigger */}
      {count > 0 && (
        <button onClick={() => setSheetOpen(true)}
          className="fixed inset-x-4 bottom-4 z-40 flex items-center justify-between rounded-2xl bg-brand-500 px-5 py-3.5 text-white shadow-drawer lg:hidden">
          <span className="flex items-center gap-2"><ShoppingCart className="h-5 w-5" /> {count} item{count > 1 ? "s" : ""}</span>
          <span className="tnum font-heading text-lg font-bold">{formatPKR(total)}</span>
        </button>
      )}

      {/* mobile cart sheet */}
      {sheetOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40 animate-fade-in" onClick={() => setSheetOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 max-h-[88vh] rounded-t-2xl bg-surface p-4 shadow-drawer">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-heading text-lg font-semibold text-text-primary">Cart</h2>
              <button onClick={() => setSheetOpen(false)} className="rounded-lg p-2 text-text-tertiary hover:bg-surface-2"><X className="h-5 w-5" /></button>
            </div>
            <CartPanel
              lines={lines} subtotal={subtotal} discount={discount} setDiscount={setDiscount} total={total} tax={tax} taxPercent={store.tax_percent}
              belowCost={belowCost} promo={promo}
              customers={allCustomers} customerId={customerId} customerName={customerName} setCustomer={setCustomer} onCreateCustomer={createCustomer}
              setQty={setQty} remove={(id) => setQty(id, 0)} setLineDiscount={setLineDiscount} clearLineDiscount={clearLineDiscount}
              processing={processing} onCharge={openPayment} onHold={holdSale}
              editing={editing} qtyDraft={qtyDraft} setQtyDraft={setQtyDraft} discDraft={discDraft} setDiscDraft={setDiscDraft}
              beginEdit={beginEdit} commitQty={commitQty} commitDisc={commitDisc} cancelEdit={focusScan} activeLine={activeLine} embedded
            />
          </div>
        </div>
      )}

      <CameraScanner
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onResult={(code) => handleScan(code)}
        continuous
        title="Scan to add to cart"
      />

      <PaymentSheet
        open={paymentOpen}
        total={total}
        customers={allCustomers}
        customerId={customerId}
        customerName={customerName}
        setCustomer={setCustomer}
        onClose={() => setPaymentOpen(false)}
        onConfirm={checkout}
        processing={processing}
      />

      <Receipt
        data={receiptData}
        onClose={finishReceipt}
      />

      <ReturnsSheet open={returnsOpen} onClose={() => setReturnsOpen(false)} initialReceipt={returnReceipt} />

      {heldOpen && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
          <div className="absolute inset-0 bg-black/45 animate-fade-in" onClick={() => setHeldOpen(false)} />
          <div className="relative z-10 flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl bg-surface shadow-drawer animate-fade-in sm:rounded-2xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="flex items-center gap-2 font-heading text-lg font-semibold text-text-primary"><Clock className="h-5 w-5" /> Held sales</span>
              <button onClick={() => setHeldOpen(false)} className="rounded-lg p-1.5 text-text-tertiary hover:bg-surface-2"><X className="h-5 w-5" /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
              {held.length === 0 ? (
                <div className="flex h-32 items-center justify-center text-sm text-text-tertiary">No held sales</div>
              ) : held.map((h) => {
                const count = h.lines.reduce((s, l) => s + l.qty, 0);
                const amt = h.lines.reduce((s, l) => s + l.p.price * l.qty - (l.discount ?? 0), 0);
                const cust = allCustomers.find((c) => c.id === h.customerId);
                return (
                  <div key={h.id} className="flex items-center gap-2 rounded-xl border border-border p-3 mb-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-text-primary">{count} item{count !== 1 ? "s" : ""} · {formatPKR(amt)}</div>
                      <div className="text-xs text-text-tertiary">{cust ? `${cust.name} · ` : ""}{new Date(h.ts).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" })}</div>
                    </div>
                    <Button size="sm" onClick={() => resumeSale(h.id)}><Play className="h-4 w-4" /> Resume</Button>
                    <button onClick={() => deleteHeld(h.id)} className="rounded-md p-2 text-text-tertiary hover:text-coral-text"><Trash2 className="h-4 w-4" /></button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {shortcutsOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={() => setShortcutsOpen(false)}>
          <div className="absolute inset-0 bg-black/45 animate-fade-in" />
          <div className="relative z-10 w-full max-w-sm rounded-2xl bg-surface p-5 shadow-drawer animate-fade-in" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <span className="flex items-center gap-2 font-heading text-lg font-semibold text-text-primary"><Keyboard className="h-5 w-5" /> Shortcuts</span>
              <button onClick={() => setShortcutsOpen(false)} className="rounded-lg p-1.5 text-text-tertiary hover:bg-surface-2"><X className="h-5 w-5" /></button>
            </div>
            <dl className="space-y-2 text-sm">
              {SHORTCUT_HELP.map(({ keys, label }) => (
                <div key={keys} className="flex items-center justify-between gap-3">
                  <span className="text-text-secondary">{label}</span>
                  <kbd className="shrink-0 rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-xs text-text-primary">{keys}</kbd>
                </div>
              ))}
            </dl>
            <p className="mt-3 border-t border-border pt-2 text-[11px] leading-relaxed text-text-tertiary">
              F3 and F6 are no longer used: the browser keeps those for Find and for
              moving between its own panes, so a page cannot reliably claim them.
              They are now <strong className="text-text-secondary">F8</strong> and{" "}
              <strong className="text-text-secondary">F9</strong>.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={cn("whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
        active ? "border-brand-500 bg-brand-500 text-white" : "border-border bg-surface text-text-secondary hover:bg-surface-2")}>
      {children}
    </button>
  );
}

function CartPanel({
  lines, subtotal, discount, setDiscount, total, tax, taxPercent, belowCost, promo,
  customers, customerId, customerName, setCustomer, onCreateCustomer,
  setQty, remove, setLineDiscount, clearLineDiscount, processing, onCharge, onHold, embedded,
  editing, qtyDraft, setQtyDraft, discDraft, setDiscDraft, beginEdit, commitQty, commitDisc, cancelEdit, activeLine,
}: {
  lines: CartEntry[];
  subtotal: number; discount: string; setDiscount: (v: string) => void; total: number;
  tax: number; taxPercent: number;
  belowCost: boolean;
  promo: PromoResult;
  customers: { id: string; name: string; phone: string | null }[];
  customerId: string; customerName: string; setCustomer: (name: string, id: string) => void;
  onCreateCustomer: (name: string, phone: string | null) => Promise<{ id: string; name: string; phone: string | null } | null>;
  setQty: (id: string, qty: number) => void; remove: (id: string) => void;
  setLineDiscount: (id: string, value: number) => void; clearLineDiscount: (id: string) => void;
  processing: boolean; onCharge: () => void; onHold: () => void; embedded?: boolean;
  /** Phase B — keyboard qty/discount entry (see PosClient for the flow). */
  editing: { id: string; field: "qty" | "disc" } | null;
  qtyDraft: string; setQtyDraft: (v: string) => void;
  discDraft: string; setDiscDraft: (v: string) => void;
  beginEdit: (id?: string) => void; commitQty: () => void; commitDisc: () => void; cancelEdit: () => void;
  activeLine: string | null;
}) {
  // Only the ONE line in edit mode renders these inputs, so a single pair of
  // refs can never target the wrong line however many lines are in the cart.
  const qtyRef = useRef<HTMLInputElement>(null);
  const discRef = useRef<HTMLInputElement>(null);
  const editKey = editing ? `${editing.id}:${editing.field}` : "";
  useEffect(() => {
    if (!editing) return;
    const el = editing.field === "qty" ? qtyRef.current : discRef.current;
    if (!el || el.offsetParent === null) return; // skip the hidden (desktop) copy on mobile
    el.focus();
    el.select();
  }, [editKey, editing]);

  /** Enter/Tab advance the flow; Escape backs out to the scan box. */
  const stepKey = (e: React.KeyboardEvent, commit: () => void) => {
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
  };

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface", embedded ? "max-h-[72vh]" : "h-full")}>
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <span className="flex items-center gap-2 font-heading font-semibold text-text-primary"><ShoppingCart className="h-4 w-4" /> Cart</span>
        <span className="text-xs text-text-tertiary">{lines.length} line{lines.length !== 1 ? "s" : ""}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {lines.length === 0 ? (
          <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2 p-6 text-center text-text-tertiary">
            <ShoppingCart className="h-8 w-8" /><p className="text-sm">Tap products to add them</p>
          </div>
        ) : lines.map((l) => {
          const gross = l.p.price * l.qty;
          const net = round2(gross - l.discount);
          const hasDisc = l.discount > 0;
          const lineBelowCost = l.p.cost > 0 && net < l.p.cost * l.qty;
          const isEditing = editing?.id === l.p.variant_id;
          return (
          <div
            key={l.p.variant_id}
            onClick={() => { if (!isEditing) beginEdit(l.p.variant_id); }}
            className={cn(
              "cursor-pointer border-b border-border/60 px-3 py-2 last:border-0",
              isEditing ? "bg-brand-50/60 ring-1 ring-inset ring-brand-500" : activeLine === l.p.variant_id ? "bg-surface-2/50" : "hover:bg-surface-2/40",
            )}
          >
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-text-primary">{l.p.name}</div>
                <div className="text-xs text-text-tertiary">
                  {l.p.label || l.p.sku} ·{" "}
                  {hasDisc ? (
                    <>
                      <span className="line-through">{formatPKR(l.p.price)}</span>{" "}
                      <span className="font-medium text-green-text">{formatPKR(round2(l.p.price - l.discount / l.qty))}</span>
                    </>
                  ) : formatPKR(l.p.price)}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={(e) => { e.stopPropagation(); setQty(l.p.variant_id, l.qty - 1); }} className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-text-primary"><Minus className="h-3.5 w-3.5" /></button>
                <span className="tnum w-6 text-center text-sm font-semibold">{l.qty}</span>
                <button onClick={(e) => { e.stopPropagation(); setQty(l.p.variant_id, l.qty + 1); }} disabled={l.qty >= l.p.available} className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-text-primary disabled:opacity-40"><Plus className="h-3.5 w-3.5" /></button>
              </div>
              <div className="tnum w-16 text-right text-sm font-medium text-text-primary">{formatPKR(net)}</div>
              <button onClick={(e) => { e.stopPropagation(); remove(l.p.variant_id); }} className="rounded-md p-1 text-text-tertiary hover:text-coral-text"><Trash2 className="h-4 w-4" /></button>
            </div>

            {isEditing ? (
              /* Phase B — type qty, Enter, type discount, Enter, back to scanning. */
              <div data-cart-edit className="mt-1.5 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                <label className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-text-secondary">Qty</span>
                  <Input
                    ref={qtyRef}
                    data-cart-edit
                    type="number"
                    inputMode="decimal"
                    step="any"
                    value={qtyDraft}
                    onChange={(e) => setQtyDraft(e.target.value)}
                    onKeyDown={(e) => stepKey(e, commitQty)}
                    className="h-8 w-20 text-right text-sm"
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-text-secondary">Disc &#8360;</span>
                  <Input
                    ref={discRef}
                    data-cart-edit
                    type="number"
                    inputMode="decimal"
                    step="any"
                    value={discDraft}
                    onChange={(e) => setDiscDraft(e.target.value)}
                    onKeyDown={(e) => stepKey(e, commitDisc)}
                    placeholder="0"
                    className="h-8 w-20 text-right text-sm"
                  />
                </label>
                <span className="ml-auto text-right text-[10px] leading-tight text-text-tertiary">
                  {editing?.field === "qty" ? "Enter → discount" : "Enter → done"}
                  <br />Esc cancels
                </span>
              </div>
            ) : (
              /* per-line discount: auto-filled from the product, editable / removable */
              <div className="mt-1 flex items-center gap-2 pl-0.5" onClick={(e) => e.stopPropagation()}>
                <span className="text-[11px] text-text-tertiary">Discount</span>
                <Input
                  type="number"
                  value={l.discount ? String(round2(l.discount)) : ""}
                  onChange={(e) => setLineDiscount(l.p.variant_id, Number(e.target.value) || 0)}
                  placeholder="0"
                  className="h-7 w-20 text-right text-xs"
                />
                {hasDisc && (
                  <button onClick={() => clearLineDiscount(l.p.variant_id)} className="text-[11px] font-medium text-text-tertiary hover:text-coral-text">Remove</button>
                )}
                {lineBelowCost && (
                  <span className="ml-auto flex items-center gap-1 text-[11px] font-medium text-coral-text" title="This line is below its cost">
                    <AlertTriangle className="h-3 w-3" /> below cost
                  </span>
                )}
              </div>
            )}
          </div>
          );
        })}
      </div>

      <div className="max-h-[60%] shrink-0 space-y-3 overflow-y-auto border-t border-border p-4 scrollbar-thin">
        <CustomerSelect customers={customers} name={customerName} customerId={customerId} onPick={setCustomer} onCreate={onCreateCustomer} />
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-secondary">Subtotal</span><span className="tnum text-text-primary">{formatPKR(subtotal)}</span>
        </div>

        {/* Applied promotions (automatic sales / category offers) */}
        {promo.applied.filter((a) => a.amount > 0 || a.type === "FREE_DELIVERY").map((a) => (
          <div key={a.discount_id} className="flex items-center justify-between text-sm text-green-text">
            <span className="flex items-center gap-1.5"><Tag className="h-3.5 w-3.5" /> {a.name}</span>
            <span className="tnum">{a.type === "FREE_DELIVERY" ? "Free delivery" : `− ${formatPKR(a.amount)}`}</span>
          </div>
        ))}

        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-text-secondary">Bill discount</span>
          <Input type="number" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0" className="h-8 w-28 text-right" />
        </div>
        {tax > 0 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Tax ({taxPercent}%)</span><span className="tnum text-text-primary">{formatPKR(tax)}</span>
          </div>
        )}
        <div className="flex items-center justify-between border-t border-border pt-2">
          <span className="font-medium text-text-primary">Total</span>
          <span className="tnum font-heading text-xl font-bold text-text-primary">{formatPKR(total)}</span>
        </div>
        {belowCost && (
          <div className="flex items-center gap-1.5 rounded-lg bg-coral-tile px-2.5 py-1.5 text-xs font-medium text-coral-text">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> The bill discount puts this sale below its total cost.
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onHold} disabled={processing || !lines.length} className="shrink-0 px-4 py-3" title="Hold sale (park)">
            <Pause className="h-5 w-5" /> Hold
          </Button>
          <Button onClick={onCharge} disabled={processing || !lines.length} className="flex-1 py-3 text-base">
            {processing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Banknote className="h-5 w-5" />} Charge {formatPKR(total)}
          </Button>
        </div>
        {/* Which key does what, stated on the screen the cashier is looking at.
            F9 always means CASH — there is no payment-method selector in this
            panel to "respect", so an unconditional meaning is the unambiguous
            one. Anything else is a deliberate trip through the payment sheet. */}
        {lines.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] leading-tight text-text-tertiary">
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-surface-2 px-1 font-mono text-[10px] text-text-secondary">F9</kbd>
              <span className="font-medium text-green-text">Cash</span> &amp; print now
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-surface-2 px-1 font-mono text-[10px] text-text-secondary">F4</kbd>
              Udhaar / JazzCash / Easypaisa / split
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
