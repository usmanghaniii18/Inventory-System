"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  Search, Loader2, Wallet, PackageX, Layers, AlertTriangle, Info, X,
  PackagePlus, SlidersHorizontal, ArrowLeftRight, ClipboardCheck, History,
  ArrowDownLeft, ArrowUpRight, Barcode,
} from "lucide-react";
import { PageHeader } from "@hamza/shared/ui/PageHeader";
import { Card } from "@hamza/shared/ui/Card";
import { Button } from "@hamza/shared/ui/Button";
import { Input, Label, FieldError } from "@hamza/shared/ui/Input";
import { Select } from "@hamza/shared/ui/Select";
import { Drawer } from "@hamza/shared/ui/Drawer";
import { StatusPill } from "@hamza/shared/ui/StatusPill";
import { StatTile } from "@hamza/shared/ui/StatTile";
import { EmptyState } from "@hamza/shared/ui/EmptyState";
import { useToast } from "@hamza/shared/ui/Toast";
import { ExportMenu } from "@hamza/shared/ui/ExportMenu";
import { cn, formatPKR, formatNumber } from "@hamza/shared/utils";
import {
  stockIn, adjustStock, transferStock, cycleCount, getMovementHistory, type MoveRow,
} from "./actions";
import { useScanHandler } from "@/components/scan/ScanProvider";
import { CategoryMultiSelect, type CategoryOption } from "@/components/CategoryMultiSelect";
import { parseScan } from "@/lib/barcode";
import { ensureCatalog, lookupBarcodeLoose } from "@/lib/catalog-cache";
import { expandCategorySelection } from "@/lib/categories";
import { beepOk, beepError } from "@/lib/sound";

export interface PhysLocation { code: string; name: string }

export interface StockRow {
  id: string;
  variant_id: string;
  product_id: string;
  product_name: string;
  label: string;
  sku: string;
  barcode: string | null;
  base_unit: string;
  category: string;
  category_id: string | null;
  reorder_point: number;
  on_hand: number;
  reserved: number;
  available: number;
  avg_cost: number;
  value: number;
  byLocation: { code: string; name: string; on_hand: number }[];
}

type ActionType = "in" | "adjust" | "transfer" | "count";
type StatusFilter = "all" | "in_stock" | "low_stock" | "out_of_stock";

function rowStatus(r: StockRow): StatusFilter {
  if (r.available <= 0) return "out_of_stock";
  if (r.available <= r.reorder_point) return "low_stock";
  return "in_stock";
}

export function StockClient({
  rows, categories, locations,
}: {
  rows: StockRow[];
  categories: CategoryOption[];
  locations: PhysLocation[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const sp = useSearchParams();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [catIds, setCatIds] = useState<string[]>([]);
  // Selecting a main category must also match its sub-categories' products.
  const expandedCats = useMemo(() => expandCategorySelection(catIds, categories), [catIds, categories]);
  // Honor a ?filter=low_stock deep link from the dashboard "Low Stock → See all".
  const initialFilter = sp.get("filter");
  const [status, setStatus] = useState<StatusFilter>(
    initialFilter === "low_stock" || initialFilter === "out_of_stock" || initialFilter === "in_stock" ? initialFilter : "all",
  );
  const [loc, setLoc] = useState("");
  const [action, setAction] = useState<{ type: ActionType; row?: StockRow } | null>(null);
  const [history, setHistory] = useState<StockRow | null>(null);
  const [showInfo, setShowInfo] = useState(false);

  useEffect(() => {
    setShowInfo(localStorage.getItem("stock-explainer-dismissed") !== "1");
  }, []);
  const dismissInfo = () => { localStorage.setItem("stock-explainer-dismissed", "1"); setShowInfo(false); };

  // Context-aware scan on the Stock screen (Part 2): a known barcode opens the
  // stock-manage form (Stock In) with that variant preselected; an unknown one
  // jumps to Add Product pre-filled so it can be created first.
  useScanHandler(async (raw) => {
    const parsed = parseScan(raw);
    const match = rows.find((r) => r.barcode && (r.barcode === parsed.lookupKey || r.barcode === parsed.barcode));
    if (match) { beepOk(); setAction({ type: "in", row: match }); toast(`Stock In · ${match.product_name}`); return; }
    // Catalogue fallback covers variants not in the current stock list.
    await ensureCatalog();
    const hit = lookupBarcodeLoose(parsed.lookupKey) ?? lookupBarcodeLoose(parsed.barcode);
    const row = hit ? rows.find((r) => r.variant_id === hit.variant_id) : undefined;
    if (row) { beepOk(); setAction({ type: "in", row }); toast(`Stock In · ${row.product_name}`); return; }
    beepError();
    toast(`Not found — add ${parsed.barcode}`, "error");
    router.push(`/admin/products?add=${encodeURIComponent(parsed.barcode)}`);
  });

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (catIds.length && (!r.category_id || !expandedCats.has(r.category_id))) return false;
      if (status !== "all" && rowStatus(r) !== status) return false;
      if (loc && !(r.byLocation.find((l) => l.code === loc)?.on_hand)) return false;
      if (!term) return true;
      return (
        r.product_name.toLowerCase().includes(term) ||
        r.label.toLowerCase().includes(term) ||
        r.sku.toLowerCase().includes(term) ||
        (r.barcode ?? "").includes(term)
      );
    });
  }, [rows, q, catIds, expandedCats, status, loc]);

  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  const lowCount = rows.filter((r) => rowStatus(r) === "low_stock").length;
  const outCount = rows.filter((r) => rowStatus(r) === "out_of_stock").length;

  return (
    <div className="min-w-0">
      <PageHeader
        title="Stock"
        subtitle="Current on-hand levels per variant — every change is a recorded movement"
        actions={
          <div className="flex flex-wrap gap-2">
            <ExportMenu
              filename="stock"
              title="Stock on hand"
              columns={[
                { key: "product", header: "Product" }, { key: "variant", header: "Variant" },
                { key: "sku", header: "SKU" }, { key: "on_hand", header: "On hand" },
                { key: "available", header: "Available" }, { key: "avg_cost", header: "Avg cost" },
                { key: "value", header: "Value" }, { key: "status", header: "Status" },
              ]}
              rows={filtered.map((r) => ({
                product: r.product_name, variant: r.label, sku: r.sku, on_hand: r.on_hand,
                available: r.available, avg_cost: Math.round(r.avg_cost), value: Math.round(r.value),
                status: rowStatus(r).replace("_", " "),
              }))}
            />
            <Button size="sm" onClick={() => setAction({ type: "in" })}><PackagePlus className="h-4 w-4" /> Stock In</Button>
            <Button size="sm" variant="secondary" onClick={() => setAction({ type: "adjust" })}><SlidersHorizontal className="h-4 w-4" /> Adjust</Button>
            <Button size="sm" variant="secondary" onClick={() => setAction({ type: "transfer" })}><ArrowLeftRight className="h-4 w-4" /> Transfer</Button>
            <Button size="sm" variant="secondary" onClick={() => setAction({ type: "count" })}><ClipboardCheck className="h-4 w-4" /> Cycle Count</Button>
          </div>
        }
      />

      {showInfo && (
        <Card className="mb-4 flex items-start gap-3 border-blue-200 bg-blue-tile/40 p-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-tile text-blue-text">
            <Info className="h-5 w-5" />
          </div>
          <div className="flex-1 text-sm">
            <p className="font-medium text-text-primary">Stock is never edited directly.</p>
            <p className="mt-0.5 text-text-secondary">
              Every change — receiving, a sale, damage, a transfer or a cycle count — is
              saved as a <strong>movement</strong> in the ledger. That’s why on-hand
              numbers are read-only here: use the actions above, and open any row’s
              <History className="mx-1 inline h-3.5 w-3.5" /> history to see exactly what happened, when and by whom.
            </p>
          </div>
          <button onClick={dismissInfo} className="rounded-md p-1 text-text-tertiary hover:bg-surface-2" aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </Card>
      )}

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Stock Value" value={formatPKR(totalValue, { compact: true })} fullValue={formatPKR(totalValue)} icon={Wallet} accent="blue" sensitive />
        <StatTile label="Low-stock" value={lowCount} icon={AlertTriangle} accent="amber" />
        <StatTile label="Out of stock" value={outCount} icon={PackageX} accent="coral" />
        <StatTile label="Variants" value={rows.length} icon={Layers} accent="teal" />
      </div>

      <Card className="mb-4 grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search product, variant, SKU or barcode…" className="pl-9" />
        </div>
        <CategoryMultiSelect categories={categories} selected={catIds} onChange={setCatIds} className="lg:w-52" />
        <Select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className="lg:w-40">
          <option value="all">All statuses</option>
          <option value="in_stock">In stock</option>
          <option value="low_stock">Low</option>
          <option value="out_of_stock">Out</option>
        </Select>
        {locations.length > 1 && (
          <Select value={loc} onChange={(e) => setLoc(e.target.value)} className="lg:w-44">
            <option value="">All locations</option>
            {locations.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </Select>
        )}
      </Card>

      <Card className="min-w-0 max-w-full">
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              <th className="px-3 py-3 text-left">Product / Variant</th>
              <th className="w-14 px-2 py-3 text-right sm:w-20">On hand</th>
              <th className="hidden w-20 px-2 py-3 text-right lg:table-cell">Reserved</th>
              <th className="w-14 px-2 py-3 text-right sm:w-20">Avail.</th>
              <th className="hidden w-24 px-2 py-3 text-right md:table-cell">Avg cost</th>
              <th className="hidden w-24 px-2 py-3 text-right xl:table-cell">Value</th>
              <th className="hidden w-16 px-2 py-3 text-right xl:table-cell">Reorder</th>
              <th className="w-20 px-2 py-3 text-left sm:w-28">Status</th>
              <th className="w-[4.5rem] px-2 py-3 text-right sm:w-28" />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-12">
                  <EmptyState icon={Layers} title="No stock matches" description="Try clearing filters or search." />
                </td>
              </tr>
            ) : filtered.map((r) => (
              <tr key={r.id} className="border-b border-border/70 last:border-0">
                <td className="px-3 py-2.5">
                  <div className="truncate font-medium text-text-primary" title={r.product_name}>{r.product_name}</div>
                  <div className="truncate text-xs text-text-tertiary" title={`${r.label} · ${r.sku}`}>{r.label} · {r.sku}</div>
                </td>
                <td className="px-2 py-2.5 text-right tnum">{formatNumber(r.on_hand, 2)}</td>
                <td className="hidden px-2 py-2.5 text-right tnum text-text-tertiary lg:table-cell">{formatNumber(r.reserved, 2)}</td>
                <td className="px-2 py-2.5 text-right tnum font-medium text-text-primary">{formatNumber(r.available, 2)}</td>
                <td className="hidden truncate px-2 py-2.5 text-right tnum md:table-cell">{formatPKR(r.avg_cost)}</td>
                <td className="hidden truncate px-2 py-2.5 text-right tnum text-text-primary xl:table-cell">{formatPKR(r.value)}</td>
                <td className="hidden px-2 py-2.5 text-right tnum text-text-tertiary xl:table-cell">{r.reorder_point}</td>
                <td className="px-2 py-2.5"><StatusPill status={rowStatus(r)} /></td>
                <td className="px-2 py-2.5">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => setHistory(r)} className="hidden rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 sm:inline-flex" title="Movement history">
                      <History className="h-4 w-4" />
                    </button>
                    <Button size="sm" variant="secondary" onClick={() => setAction({ type: "adjust", row: r })}>Adjust</Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {action && (
        <ActionDrawer
          type={action.type}
          preselected={action.row}
          rows={rows}
          categories={categories}
          locations={locations}
          onClose={() => setAction(null)}
          onDone={(msg) => { setAction(null); toast(msg); router.refresh(); queryClient.invalidateQueries({ queryKey: ["products"] }); }}
          onError={(m) => toast(m, "error")}
        />
      )}

      <HistoryDrawer row={history} onClose={() => setHistory(null)} />
    </div>
  );
}

/* ---------------- Variant picker (search + scan) ---------------- */

function VariantPicker({
  rows, categories, value, onChange,
}: {
  rows: StockRow[];
  categories: CategoryOption[];
  value: StockRow | null;
  onChange: (r: StockRow) => void;
}) {
  const [term, setTerm] = useState("");
  // Phase I — narrow the pickable products by category before searching, using
  // the same multi-select + main→sub rollup as the Low Stock filter above.
  const [catIds, setCatIds] = useState<string[]>([]);
  const expanded = useMemo(() => expandCategorySelection(catIds, categories), [catIds, categories]);
  const scoped = useMemo(
    () => (catIds.length ? rows.filter((r) => r.category_id && expanded.has(r.category_id)) : rows),
    [rows, catIds, expanded],
  );
  const results = useMemo(() => {
    const t = term.trim().toLowerCase();
    if (!t) return scoped.slice(0, 8);
    // exact barcode -> auto pick (searched across the WHOLE catalogue, so a scan
    // still resolves even when a category filter is narrowing the list)
    const exact = rows.find((r) => r.barcode && r.barcode === term.trim());
    if (exact) return [exact];
    return scoped.filter((r) =>
      r.product_name.toLowerCase().includes(t) ||
      r.label.toLowerCase().includes(t) ||
      r.sku.toLowerCase().includes(t) ||
      (r.barcode ?? "").includes(t),
    ).slice(0, 8);
  }, [rows, scoped, term]);

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-border bg-surface-2 px-3 py-2">
        <div>
          <div className="text-sm font-medium text-text-primary">{value.product_name}</div>
          <div className="text-xs text-text-tertiary">{value.label} · {value.sku} · on hand {formatNumber(value.on_hand, 2)}</div>
        </div>
        <button type="button" onClick={() => { onChange(null as never); setTerm(""); }} className="rounded-md p-1 text-text-tertiary hover:bg-surface">
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2">
        <CategoryMultiSelect categories={categories} selected={catIds} onChange={setCatIds} placeholder="All categories" />
      </div>
      <div className="relative">
        <Barcode className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
        <Input data-scan-input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Scan barcode or search…" className="pl-9" />
      </div>
      <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-border">
        {results.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-text-tertiary">No matches</p>
        ) : results.map((r) => (
          <button
            key={r.variant_id}
            type="button"
            onClick={() => onChange(r)}
            className="flex w-full items-center justify-between border-b border-border/60 px-3 py-2 text-left last:border-0 hover:bg-surface-2"
          >
            <div>
              <div className="text-sm font-medium text-text-primary">{r.product_name}</div>
              <div className="text-xs text-text-tertiary">{r.label} · {r.sku}</div>
            </div>
            <span className="tnum text-xs text-text-tertiary">{formatNumber(r.on_hand, 2)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Unified action drawer ---------------- */

const ACTION_META: Record<ActionType, { title: string; cta: string; desc: string }> = {
  in: { title: "Stock In", cta: "Add stock", desc: "Receive new stock into the store — increases available quantity and updates the average cost." },
  adjust: { title: "Adjust — Add or Reduce", cta: "Save adjustment", desc: "Correct the quantity up (found / over-count) or down (damage / loss / theft). Records a movement; stock is never edited directly." },
  transfer: { title: "Transfer", cta: "Move stock", desc: "Move stock from one location to another. The total quantity stays the same." },
  count: { title: "Cycle Count", cta: "Save count", desc: "Enter your physical count — the system records a correcting movement so it matches what’s on the shelf." },
};

function ActionDrawer({
  type, preselected, rows, categories, locations, onClose, onDone, onError,
}: {
  type: ActionType;
  preselected?: StockRow;
  rows: StockRow[];
  categories: CategoryOption[];
  locations: PhysLocation[];
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (m: string) => void;
}) {
  const [variant, setVariant] = useState<StockRow | null>(preselected ?? null);
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [reason, setReason] = useState("");
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [lot, setLot] = useState("");
  const [expiry, setExpiry] = useState("");
  const [locCode, setLocCode] = useState(locations[0]?.code ?? "MAIN");
  const [fromCode, setFromCode] = useState(locations[0]?.code ?? "MAIN");
  const [toCode, setToCode] = useState(locations[1]?.code ?? locations[0]?.code ?? "MAIN");
  const [counted, setCounted] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string>();

  const meta = ACTION_META[type];
  const locOnHand = (code: string) => variant?.byLocation.find((l) => l.code === code)?.on_hand ?? 0;
  const locName = (code: string) => locations.find((l) => l.code === code)?.name ?? code;

  // Plain-language confirmation of the effect before saving.
  const effect = (() => {
    if (!variant) return null;
    const name = `${variant.product_name} · ${variant.label}`;
    const q = Number(qty);
    if (type === "in") return q > 0 ? { name, lines: [{ loc: locName(locCode), from: locOnHand(locCode), to: locOnHand(locCode) + q }] } : null;
    if (type === "adjust") return q > 0 ? { name, lines: [{ loc: locName(locCode), from: locOnHand(locCode), to: direction === "add" ? locOnHand(locCode) + q : locOnHand(locCode) - q }] } : null;
    if (type === "transfer") return q > 0 ? { name, lines: [
      { loc: locName(fromCode), from: locOnHand(fromCode), to: locOnHand(fromCode) - q },
      { loc: locName(toCode), from: locOnHand(toCode), to: locOnHand(toCode) + q },
    ] } : null;
    if (type === "count" && counted !== "") return { name, lines: [{ loc: locName(locCode), from: locOnHand(locCode), to: Number(counted) }] };
    return null;
  })();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(undefined);
    if (!variant) { setErr("Pick a variant first."); return; }
    setSaving(true);
    let res: { ok?: true; error?: string };

    if (type === "in") {
      res = await stockIn({
        variant_id: variant.variant_id, product_id: variant.product_id,
        qty: Number(qty), unit_cost: Number(cost) || 0, location_code: locCode,
        lot_number: lot || null, expiry: expiry || null,
        source: variant.barcode ? "SCAN" : "MANUAL",
      });
    } else if (type === "adjust") {
      res = await adjustStock({
        variant_id: variant.variant_id, product_id: variant.product_id,
        direction, qty: Number(qty),
        reason: reason || (direction === "add" ? "Found / correction" : "Damage / loss"),
        unit_cost: cost ? Number(cost) : variant.avg_cost, location_code: locCode,
      });
    } else if (type === "transfer") {
      res = await transferStock({
        variant_id: variant.variant_id, product_id: variant.product_id,
        qty: Number(qty), from_code: fromCode, to_code: toCode, unit_cost: variant.avg_cost,
      });
    } else {
      res = await cycleCount({
        variant_id: variant.variant_id, product_id: variant.product_id,
        counted_qty: Number(counted), current_qty: locOnHand(locCode),
        unit_cost: variant.avg_cost, location_code: locCode,
      });
    }

    setSaving(false);
    if (res?.error) { setErr(res.error); onError(res.error); return; }
    onDone(`${meta.title} posted`);
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={meta.title}
      footer={
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="stock-action-form" className="flex-1" disabled={saving || !variant}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} {meta.cta}
          </Button>
        </div>
      }
    >
      <form id="stock-action-form" onSubmit={submit} className="space-y-4">
        <p className="rounded-lg bg-blue-tile/40 px-3 py-2 text-xs text-text-secondary">{meta.desc}</p>
        <div>
          <Label>Product / Variant</Label>
          <VariantPicker rows={rows} categories={categories} value={variant} onChange={setVariant} />
        </div>

        {type === "in" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Quantity</Label><Input type="number" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" /></div>
              <div><Label>Cost / unit (₨)</Label><Input type="number" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0" /></div>
            </div>
            {locations.length > 1 && (
              <div><Label>Into location</Label>
                <Select value={locCode} onChange={(e) => setLocCode(e.target.value)}>
                  {locations.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                </Select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Lot / batch (optional)</Label><Input value={lot} onChange={(e) => setLot(e.target.value)} placeholder="e.g. B-2206" /></div>
              <div><Label>Expiry (optional)</Label><Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></div>
            </div>
            <Hint>Posts <strong>Supplier → {locations.find((l) => l.code === locCode)?.name ?? "Store"}</strong> and updates the weighted-average cost.</Hint>
          </>
        )}

        {type === "adjust" && (
          <>
            <div><Label>Type</Label>
              <Select value={direction} onChange={(e) => setDirection(e.target.value as "add" | "remove")}>
                <option value="add">Add (found / correction up)</option>
                <option value="remove">Remove (damage / loss)</option>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Quantity</Label><Input type="number" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" /></div>
              {direction === "add" && <div><Label>Cost / unit (₨)</Label><Input type="number" value={cost} onChange={(e) => setCost(e.target.value)} placeholder={variant ? String(variant.avg_cost) : "0"} /></div>}
            </div>
            <div><Label>Reason</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Broken during handling" /></div>
            <Hint>{direction === "add" ? "Adjustment → Store" : "Store → Loss"}. Append-only; stock is never edited directly.</Hint>
          </>
        )}

        {type === "transfer" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>From</Label>
                <Select value={fromCode} onChange={(e) => setFromCode(e.target.value)}>
                  {locations.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                </Select>
                {variant && <p className="mt-1 text-[11px] text-text-tertiary">On hand: {formatNumber(locOnHand(fromCode), 2)}</p>}
              </div>
              <div><Label>To</Label>
                <Select value={toCode} onChange={(e) => setToCode(e.target.value)}>
                  {locations.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                </Select>
              </div>
            </div>
            <div><Label>Quantity</Label><Input type="number" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" /></div>
            <Hint>Moves stock between locations, carrying its cost.</Hint>
          </>
        )}

        {type === "count" && (
          <>
            {locations.length > 1 && (
              <div><Label>Location</Label>
                <Select value={locCode} onChange={(e) => setLocCode(e.target.value)}>
                  {locations.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                </Select>
              </div>
            )}
            <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
              <div className="flex justify-between"><span className="text-text-tertiary">System on-hand</span><span className="tnum font-medium">{variant ? formatNumber(locOnHand(locCode), 2) : "—"}</span></div>
            </div>
            <div><Label>Counted quantity</Label><Input type="number" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder="0" /></div>
            {variant && counted !== "" && (
              <p className="text-sm text-text-secondary">
                Difference: <span className={cn("tnum font-medium", Number(counted) - locOnHand(locCode) >= 0 ? "text-green-text" : "text-coral-text")}>
                  {Number(counted) - locOnHand(locCode) >= 0 ? "+" : ""}{formatNumber(Number(counted) - locOnHand(locCode), 2)}
                </span>
              </p>
            )}
            <Hint>Creates a correcting movement so the system matches your count.</Hint>
          </>
        )}

        {effect && (
          <div className="rounded-lg border border-amber-tile bg-amber-tile/40 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-sm font-medium text-text-primary"><AlertTriangle className="h-3.5 w-3.5 text-amber-text" /> Please confirm</p>
            <div className="mt-1 space-y-0.5 text-sm text-text-secondary">
              {effect.lines.map((l, i) => (
                <p key={i}>
                  This will change <strong className="text-text-primary">{effect.name}</strong>
                  {effect.lines.length > 1 ? ` at ${l.loc}` : ""} from{" "}
                  <strong className="tnum text-text-primary">{formatNumber(l.from, 2)}</strong> to{" "}
                  <strong className={cn("tnum", l.to < l.from ? "text-coral-text" : "text-green-text")}>{formatNumber(l.to, 2)}</strong>
                  {l.to < 0 && <span className="ml-1 font-medium text-coral-text">(below zero — not allowed)</span>}.
                </p>
              ))}
            </div>
          </div>
        )}

        <FieldError message={err} />
      </form>
    </Drawer>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg bg-surface-2 px-3 py-2 text-[11px] text-text-tertiary">{children}</p>;
}

/* ---------------- Movement history drawer ---------------- */

function HistoryDrawer({ row, onClose }: { row: StockRow | null; onClose: () => void }) {
  const [moves, setMoves] = useState<MoveRow[] | null>(null);

  useEffect(() => {
    let active = true;
    if (row) {
      setMoves(null);
      getMovementHistory(row.variant_id).then((m) => { if (active) setMoves(m); });
    }
    return () => { active = false; };
  }, [row]);

  return (
    <Drawer open={!!row} onClose={onClose} title={row ? `History · ${row.product_name}` : "History"} width="max-w-lg">
      {row && (
        <div>
          <p className="mb-4 text-xs text-text-tertiary">{row.label} · {row.sku}</p>
          {moves === null ? (
            <div className="flex justify-center py-10 text-text-tertiary"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : moves.length === 0 ? (
            <EmptyState icon={History} title="No movements yet" description="Stock actions will appear here." />
          ) : (
            <ol className="relative space-y-4 border-l border-border pl-5">
              {moves.map((m) => (
                <li key={m.id} className="relative">
                  <span className={cn(
                    "absolute -left-[1.6rem] flex h-6 w-6 items-center justify-center rounded-full",
                    m.direction === "in" ? "bg-green-tile text-green-text" : m.direction === "out" ? "bg-coral-tile text-coral-text" : "bg-blue-tile text-blue-text",
                  )}>
                    {m.direction === "in" ? <ArrowDownLeft className="h-3.5 w-3.5" /> : m.direction === "out" ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowLeftRight className="h-3.5 w-3.5" />}
                  </span>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-text-primary">
                        {m.direction === "in" ? "+" : m.direction === "out" ? "−" : "±"}{formatNumber(m.qty, 2)} {row.base_unit}
                        <span className="ml-2 text-xs font-normal text-text-tertiary">{m.reference_type.toLowerCase()}</span>
                      </div>
                      <div className="text-xs text-text-tertiary">
                        {(m.from_code ?? "?")} → {(m.to_code ?? "?")}
                        {m.unit_cost != null ? ` · ${formatPKR(m.unit_cost)}/u` : ""}
                      </div>
                      {m.note && <div className="mt-0.5 text-xs text-text-secondary">{m.note}</div>}
                    </div>
                    <div className="shrink-0 text-right text-[11px] text-text-tertiary">
                      <div>{new Date(m.created_at).toLocaleDateString("en-PK", { day: "2-digit", month: "short" })}</div>
                      <div>{new Date(m.created_at).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" })}</div>
                      <div className="mt-0.5 flex items-center justify-end gap-1">
                        <span className="rounded bg-surface-2 px-1.5 py-0.5">{m.source.toLowerCase()}</span>
                      </div>
                      {m.actor && <div className="mt-0.5">{m.actor}</div>}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </Drawer>
  );
}
