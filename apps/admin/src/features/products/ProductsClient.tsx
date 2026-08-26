"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Search, Package, Loader2, Barcode, ChevronRight, ChevronDown,
  Pencil, Wand2, Layers, Tag, QrCode, Upload, Archive, ArchiveRestore, Trash2, AlertTriangle, ImagePlus, X, Coins,
} from "lucide-react";
import { PageHeader } from "@hamza/shared/ui/PageHeader";
import { Card } from "@hamza/shared/ui/Card";
import { Button } from "@hamza/shared/ui/Button";
import { Input, Label, FieldError } from "@hamza/shared/ui/Input";
import { Select } from "@hamza/shared/ui/Select";
import { Drawer } from "@hamza/shared/ui/Drawer";
import { ConfirmDialog } from "@hamza/shared/ui/ConfirmDialog";
import { StatusPill } from "@hamza/shared/ui/StatusPill";
import { EmptyState } from "@hamza/shared/ui/EmptyState";
import { useToast } from "@hamza/shared/ui/Toast";
import { ExportMenu } from "@hamza/shared/ui/ExportMenu";
import { cn, formatPKR } from "@hamza/shared/utils";
import { createProduct, updateProduct, updateVariant, bulkSetPrice, searchProducts, searchAllProducts, setProductActive, permanentlyDeleteProduct, uploadProductImage, uploadVariantImage, removeVariantImage, getVariantCostContext, correctVariantCost, type ProductInput, type VariantInput, type VariantCostContext } from "./actions";

const UNIT_OPTIONS = ["pcs", "kg", "g", "litre", "ml", "pack", "dozen", "box", "metre"];
import { PRODUCTS_PAGE_SIZE, type ProductRow, type VariantRow, type ProductsPage } from "@/lib/products-query";
import { LabelDialog, type LabelTarget } from "./LabelDialog";
import { ImportDrawer } from "./ImportDrawer";
import { ImageGallery } from "./ImageGallery";
import { useScanHandler } from "@/components/scan/ScanProvider";
import { CategoryMultiSelect } from "@/components/CategoryMultiSelect";
import { expandCategorySelection } from "@/lib/categories";
import { parseScan } from "@/lib/barcode";
import { MAX_SKU_LENGTH } from "@hamza/shared/validation";
import { ensureCatalog, lookupBarcodeLoose } from "@/lib/catalog-cache";
import { beepOk, beepError } from "@/lib/sound";

/**
 * The SKU reaches the printed shelf label: a variant with no option values
 * falls back to its SKU for its label, and the label prints
 * "<product name> · <label>". Past MAX_SKU_LENGTH it eats the name block and,
 * on a fixed-height die-cut label, gets CLIPPED — and a clipped SKU on a shelf
 * is indistinguishable from a different SKU. So it is refused at entry rather
 * than silently truncated. See lib/label-print.ts for where the number is
 * derived from the label geometry.
 */
function skuTooLong(sku: string): string {
  return `SKU is ${sku.trim().length} characters — the printed label fits ${MAX_SKU_LENGTH}. Shorten it so the sticker stays readable.`;
}

/** Live character budget under a SKU field; turns a warning colour near the cap. */
function SkuHint({ value, id }: { value: string; id?: string }) {
  const n = value.trim().length;
  if (!n) return null;
  const over = n > MAX_SKU_LENGTH;
  const near = !over && n > MAX_SKU_LENGTH - 4;
  return (
    <p
      id={id}
      className={cn(
        "mt-1 text-[11px]",
        over ? "font-medium text-coral-text" : near ? "text-amber-600" : "text-text-tertiary",
      )}
    >
      {over ? skuTooLong(value) : `${n}/${MAX_SKU_LENGTH} characters — fits the printed label`}
    </p>
  );
}

export type { ProductRow, VariantRow };

type CatOption = { id: string; name: string; isParent: boolean };
type CatTreeRow = { id: string; name: string; parent_id: string | null };

function variantTone(v: VariantRow) {
  if (v.available <= 0) return "out_of_stock";
  if (v.available <= v.reorder_point) return "low_stock";
  return "in_stock";
}
/** Discounted selling price from a variant's default discount. */
function discountedPrice(v: VariantRow) {
  const off = v.default_discount_type === "PERCENT"
    ? (v.sale_price * v.default_discount_value) / 100
    : v.default_discount_type === "FIXED" ? v.default_discount_value : 0;
  return Math.max(Math.round((v.sale_price - off) * 100) / 100, 0);
}
function productStatus(p: ProductRow) {
  if (p.out) return "out_of_stock";
  if (p.low) return "low_stock";
  return "in_stock";
}

export function ProductsClient({
  initialPage,
  categories,
  catTree,
  isOwner,
  lowStockDefault = 3,
}: {
  initialPage: ProductsPage;
  categories: CatOption[];
  catTree: CatTreeRow[];
  isOwner: boolean;
  /** Store-wide default low-stock threshold for new products (Part 3). */
  lowStockDefault?: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const sp = useSearchParams();
  const initialQ = sp.get("q") ?? ""; // deep link from global search
  const addParam = sp.get("add");     // scanner: add this (unknown) barcode
  const editParam = sp.get("edit");   // scanner: edit this product id
  const [q, setQ] = useState(initialQ);
  const [debouncedQ, setDebouncedQ] = useState(initialQ);
  // Phase I — multi-select category filter, the SAME component and rollup rule
  // Low Stock (Stock page) already uses: picking a main category also matches
  // every product in its sub-categories.
  const [catIds, setCatIds] = useState<string[]>([]);
  const expandedCats = useMemo(
    () => (catIds.length ? [...expandCategorySelection(catIds, catTree)] : []),
    [catIds, catTree],
  );
  // Stable cache key for the expanded set (arrays are new objects every render).
  const catKey = expandedCats.join(",");
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editVariant, setEditVariant] = useState<VariantRow | null>(null);
  const [correctCostFor, setCorrectCostFor] = useState<VariantRow | null>(null);
  const [labelTarget, setLabelTarget] = useState<LabelTarget | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProductRow | null>(null);
  const [editProduct, setEditProduct] = useState<ProductRow | null>(null);
  // Barcode pre-fill for Add, sourced from a live scan (vs. the ?add= URL param).
  const [scanBarcode, setScanBarcode] = useState<string | null>(null);

  // Scanner → open the SAME Add page, prefilled with the unknown barcode.
  useEffect(() => { if (addParam) setOpen(true); }, [addParam]);

  // Scanner → open the SAME page in Edit mode, fully prefilled for the product.
  useEffect(() => {
    if (!editParam) return;
    let cancelled = false;
    (async () => {
      const page = await searchProducts({ productId: editParam, limit: 1 });
      if (cancelled) return;
      const row = page.rows[0];
      if (row) { setEditProduct(row); setExpanded((s) => new Set(s).add(row.id)); }
      else toast("That product could not be found.", "error");
    })();
    return () => { cancelled = true; };
  }, [editParam, toast]);

  // Drop the scan params from the URL once the drawer is dismissed/saved, so the
  // same scan can re-open it later.
  const clearScanParam = useCallback(() => {
    if (addParam || editParam) router.replace("/admin/products");
  }, [addParam, editParam, router]);

  // Context-aware scan on the Products screen (Part 2): a known barcode opens
  // that product in Edit mode; an unknown one opens Add Product pre-filled with
  // the scanned code. Resolves instantly from the in-memory catalogue.
  useScanHandler(async (raw) => {
    const parsed = parseScan(raw);
    await ensureCatalog();
    const hit = lookupBarcodeLoose(parsed.lookupKey) ?? lookupBarcodeLoose(parsed.barcode);
    try {
      if (typeof window !== "undefined" && window.localStorage.getItem("scanDebug") === "1") {
        console.info("[scan] products handler", { raw, lookupKey: parsed.lookupKey, barcode: parsed.barcode, matched: hit ? hit.product_name : null });
      }
    } catch { /* ignore */ }
    if (hit) {
      beepOk();
      const page = await searchProducts({ productId: hit.product_id, limit: 1 });
      const row = page.rows[0];
      if (row) {
        setEditProduct(row);
        setExpanded((s) => new Set(s).add(row.id));
        toast(`Editing ${row.name}`);
      } else {
        beepError();
        toast("That product could not be found.", "error");
      }
    } else {
      beepError();
      setScanBarcode(parsed.barcode);
      setOpen(true);
      toast(`New barcode ${parsed.barcode} — add this product`);
    }
  });

  async function archive(p: ProductRow, active: boolean) {
    const res = await setProductActive(p.id, active);
    if (res?.error) return toast(res.error, "error");
    toast(active ? "Product restored" : "Product archived");
    refreshList();
  }

  // Debounce the search box so we hit the server (indexed columns) at most
  // ~4×/sec while typing instead of on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const isDefaultView = debouncedQ === "" && catIds.length === 0;

  const {
    data, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage, isLoading,
  } = useInfiniteQuery({
    queryKey: ["products", debouncedQ, catKey],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      searchProducts({
        q: debouncedQ || undefined,
        categoryIds: expandedCats.length ? expandedCats : undefined,
        offset: pageParam as number,
        limit: PRODUCTS_PAGE_SIZE,
      }),
    getNextPageParam: (last) => {
      const loaded = last.offset + last.rows.length;
      return loaded < last.total ? loaded : undefined;
    },
    // Seed the default (unfiltered) view from the server-rendered first page so
    // first paint is instant and we don't refetch on mount.
    initialData: isDefaultView ? { pages: [initialPage], pageParams: [0] } : undefined,
    staleTime: 10_000,
  });

  // Trust fresh server data on navigation. The global QueryClient keeps the
  // ["products"] cache for the whole session (gcTime 30m, refetchOnMount:false),
  // so after a POS sale or a stock write — which server-revalidate this route —
  // a re-navigated Products tab would otherwise keep showing the STALE cached
  // on-hand. Because the SSR page always re-renders `initialPage` from the DB
  // after those writes, we overwrite the default-view cache with it on mount,
  // so on-hand reflects the sale immediately without a manual refresh.
  const seededPage = useRef<ProductsPage | null>(null);
  useEffect(() => {
    if (isDefaultView && seededPage.current !== initialPage) {
      seededPage.current = initialPage;
      queryClient.setQueryData(["products", "", ""], { pages: [initialPage], pageParams: [0] });
    }
  }, [isDefaultView, initialPage, queryClient]);

  const filtered = useMemo(() => data?.pages.flatMap((p) => p.rows) ?? initialPage.rows, [data, initialPage.rows]);
  const total = data?.pages[0]?.total ?? initialPage.total;

  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const refreshList = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["products"] });
    router.refresh();
    // Keep the scan catalogue in sync so a freshly added/edited barcode resolves.
    void ensureCatalog({ force: true });
  }, [queryClient, router]);

  // Infinite scroll: load the next page when the sentinel scrolls into view.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting && !isFetchingNextPage) fetchNextPage(); },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Export reflects the full filtered set, not just the loaded pages. Pages
  // through the ENTIRE catalogue server-side (no silent 1000-row cap).
  const fetchExportRows = useCallback(async () => {
    const { rows } = await searchAllProducts({
      q: debouncedQ || undefined, categoryIds: expandedCats.length ? expandedCats : undefined,
    });
    return rows.flatMap((p) =>
      p.variants.map((v) => ({
        product: p.name, brand: p.brand ?? "", category: p.category, variant: v.label,
        sku: v.sku, barcode: v.barcode ?? "", cost: Math.round(v.avg_cost || v.cost),
        price: v.sale_price, on_hand: v.on_hand,
      })),
    );
  }, [debouncedQ, catKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <PageHeader
        title="Products"
        subtitle={`${total} product${total === 1 ? "" : "s"}${isDefaultView ? "" : " match"}`}
        actions={
          <div className="flex gap-2">
            <ExportMenu
              filename="products"
              title="Products & variants"
              columns={[
                { key: "product", header: "Product" }, { key: "brand", header: "Brand" },
                { key: "category", header: "Category" }, { key: "variant", header: "Variant" },
                { key: "sku", header: "SKU" }, { key: "barcode", header: "Barcode" },
                { key: "cost", header: "Avg cost" }, { key: "price", header: "Price" },
                { key: "on_hand", header: "On hand" },
              ]}
              rows={[]}
              fetchRows={fetchExportRows}
            />
            <Button variant="secondary" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4" /> Import
            </Button>
            <Button onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" /> Add Product
            </Button>
          </div>
        }
      />

      <Card className="mb-4 flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search product, brand, SKU or barcode…"
            className="pl-9"
          />
        </div>
        <CategoryMultiSelect
          categories={catTree}
          selected={catIds}
          onChange={setCatIds}
          className="sm:w-64"
        />
      </Card>

      {isLoading ? (
        <Card className="flex items-center justify-center py-16 text-sm text-text-tertiary">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading products…
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={Package}
            title="No products found"
            description="Try a different search, or add a new product."
            action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add Product</Button>}
          />
        </Card>
      ) : (
        <Card className={cn("overflow-hidden transition-opacity", isFetching && !isFetchingNextPage && "opacity-60")}>
          {/* header */}
          <div className="hidden border-b border-border bg-surface-2 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-tertiary sm:grid sm:grid-cols-[1.6fr_1fr_0.8fr_0.9fr_0.7fr_2.2rem]">
            <span>Product</span>
            <span>Category</span>
            <span className="text-right">Price</span>
            <span className="text-right">On hand</span>
            <span>Status</span>
            <span />
          </div>
          {filtered.map((p) => (
            <ProductGroup
              key={p.id}
              p={p}
              isOpen={expanded.has(p.id)}
              onToggle={() => toggle(p.id)}
              onEditVariant={(v) => setEditVariant(v)}
              onLabel={(v) => setLabelTarget({
                variant_id: v.id, product_id: p.id, name: p.name, label: v.label,
                sku: v.sku, barcode: v.barcode,
                is_variable_weight: p.is_variable_weight,
              })}
              onImageChanged={refreshList}
              isOwner={isOwner}
              onEdit={() => setEditProduct(p)}
              onArchive={(active) => archive(p, active)}
              onDelete={() => setDeleteTarget(p)}
              onBulkPrice={async (price) => {
                const res = await bulkSetPrice(p.id, price);
                if (res?.error) return toast(res.error, "error");
                toast("Prices updated for all variants");
                refreshList();
              }}
            />
          ))}
          {/* infinite-scroll sentinel + manual fallback */}
          {hasNextPage && (
            <div ref={sentinelRef} className="flex justify-center p-4">
              <Button variant="secondary" size="sm" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
                {isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" />} Load more
              </Button>
            </div>
          )}
        </Card>
      )}

      <AddProductDrawer
        open={open}
        onClose={() => { setOpen(false); setScanBarcode(null); clearScanParam(); }}
        catTree={catTree}
        lowStockDefault={lowStockDefault}
        initialBarcode={addParam ?? scanBarcode}
        onSaved={() => { setOpen(false); setScanBarcode(null); clearScanParam(); toast("Product added"); refreshList(); }}
        onError={(m) => toast(m, "error")}
      />

      <VariantEditDrawer
        variant={editVariant}
        onClose={() => setEditVariant(null)}
        onSaved={() => { setEditVariant(null); toast("Variant updated"); refreshList(); }}
        onCorrectCost={() => editVariant && setCorrectCostFor(editVariant)}
        onError={(m) => toast(m, "error")}
      />

      <CorrectCostDialog
        variant={correctCostFor}
        isOwner={isOwner}
        onClose={() => setCorrectCostFor(null)}
        onDone={(msg) => { setCorrectCostFor(null); setEditVariant(null); toast(msg); refreshList(); }}
        onError={(m) => toast(m, "error")}
      />

      <LabelDialog
        target={labelTarget}
        onClose={() => setLabelTarget(null)}
        onChanged={refreshList}
      />

      <ImportDrawer open={importOpen} onClose={() => setImportOpen(false)} onDone={refreshList} />

      <DeleteProductDialog
        product={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onArchive={() => { if (deleteTarget) archive(deleteTarget, false); setDeleteTarget(null); }}
        onDeleted={() => { setDeleteTarget(null); refreshList(); }}
      />

      <EditProductDrawer
        product={editProduct}
        catTree={catTree}
        onClose={() => { setEditProduct(null); clearScanParam(); }}
        onSaved={() => { setEditProduct(null); clearScanParam(); toast("Product updated"); refreshList(); }}
        onError={(m) => toast(m, "error")}
      />
    </div>
  );
}

/* ---------------- Expandable product group ---------------- */

function ProductGroup({
  p, isOpen, onToggle, onEditVariant, onLabel, onBulkPrice, onImageChanged, isOwner, onEdit, onArchive, onDelete,
}: {
  p: ProductRow;
  isOpen: boolean;
  onToggle: () => void;
  onEditVariant: (v: VariantRow) => void;
  onLabel: (v: VariantRow) => void;
  onBulkPrice: (price: number) => void;
  onImageChanged: () => void;
  isOwner: boolean;
  onEdit: () => void;
  onArchive: (active: boolean) => void;
  onDelete: () => void;
}) {
  const [bulk, setBulk] = useState("");
  const price = p.price_min === p.price_max
    ? formatPKR(p.price_min)
    : `${formatPKR(p.price_min)} – ${formatPKR(p.price_max)}`;

  return (
    <div className="border-b border-border/70 last:border-0">
      <button
        onClick={onToggle}
        className="grid w-full grid-cols-[1fr_auto] items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-surface-2 sm:grid-cols-[1.6fr_1fr_0.8fr_0.9fr_0.7fr_2.2rem]"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2 text-text-tertiary">
            {p.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.image_url} alt="" className="h-full w-full object-cover" />
            ) : (
              <Package className="h-4 w-4" />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn("truncate font-medium text-text-primary", !p.active && "text-text-tertiary line-through")}>{p.name}</span>
              {!p.active && (
                <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-tertiary">
                  <Archive className="h-3 w-3" /> Archived
                </span>
              )}
              {p.has_variants && (
                <span className="inline-flex items-center gap-1 rounded-full bg-purple-tile px-2 py-0.5 text-[11px] font-medium text-purple-text">
                  <Layers className="h-3 w-3" /> {p.variant_count}
                </span>
              )}
            </div>
            <div className="truncate text-xs text-text-tertiary">
              {p.brand ? `${p.brand} · ` : ""}{p.sku}
            </div>
          </div>
        </div>
        <span className="hidden text-sm text-text-secondary sm:block">{p.category}</span>
        <span className="hidden tnum text-right text-sm text-text-primary sm:block">{price}</span>
        <span className="hidden tnum text-right text-sm text-text-secondary sm:block">{p.on_hand} {p.base_unit}</span>
        <span className="hidden sm:block"><StatusPill status={productStatus(p)} /></span>
        <span className="flex justify-end text-text-tertiary">
          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
      </button>

      {isOpen && (
        <div className="bg-surface-2/50 px-4 pb-4 pt-1">
          <div className="flex items-center justify-end pt-3">
            <Button variant="secondary" size="sm" onClick={onEdit}><Pencil className="h-3.5 w-3.5" /> Edit product</Button>
          </div>
          <div className="pt-3">
            <ImageGallery productId={p.id} onChanged={onImageChanged} />
          </div>
          {/* bulk price */}
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
            <Tag className="h-3.5 w-3.5 text-text-tertiary" />
            <span className="text-xs text-text-secondary">Set price for all variants:</span>
            <Input
              type="number"
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
              placeholder="₨"
              className="h-8 w-28"
            />
            <Button
              variant="secondary"
              className="h-8 px-3 text-xs"
              disabled={!bulk}
              onClick={() => { onBulkPrice(Number(bulk)); setBulk(""); }}
            >
              Apply
            </Button>
          </div>

          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-2 text-xs uppercase tracking-wide text-text-tertiary">
                  <th className="px-3 py-2 text-left font-semibold">Variant</th>
                  <th className="px-3 py-2 text-left font-semibold">SKU / Barcode</th>
                  <th className="px-3 py-2 text-right font-semibold">Cost</th>
                  <th className="px-3 py-2 text-right font-semibold">Price</th>
                  <th className="px-3 py-2 text-right font-semibold">On hand</th>
                  <th className="px-3 py-2 text-right font-semibold">Reorder</th>
                  <th className="px-3 py-2 text-left font-semibold">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {p.variants.map((v) => (
                  <tr key={v.id} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2 font-medium text-text-primary">
                      <div className="flex items-center gap-2">
                        {(v.image_url ?? p.image_url) ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={v.image_url ?? p.image_url ?? ""} alt="" className="h-7 w-7 shrink-0 rounded object-cover" title={v.image_url ? "Variant photo" : "Product photo"} />
                        ) : null}
                        <span>{v.label}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-text-secondary">
                      <div>{v.sku}</div>
                      {v.barcode && (
                        <div className="flex items-center gap-1 text-xs text-text-tertiary">
                          <Barcode className="h-3 w-3" /> {v.barcode}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tnum text-text-secondary">{formatPKR(v.avg_cost || v.cost)}</td>
                    <td className="px-3 py-2 text-right tnum text-text-primary">
                      {v.default_discount_type ? (
                        <div className="flex flex-col items-end leading-tight">
                          <span className="text-xs text-text-tertiary line-through">{formatPKR(v.sale_price)}</span>
                          <span className="text-green-text">{formatPKR(discountedPrice(v))}</span>
                        </div>
                      ) : formatPKR(v.sale_price)}
                    </td>
                    <td className="px-3 py-2 text-right tnum">{v.on_hand}</td>
                    <td className="px-3 py-2 text-right tnum text-text-tertiary">{v.reorder_point}</td>
                    <td className="px-3 py-2"><StatusPill status={variantTone(v)} /></td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => onLabel(v)}
                          title={v.barcode ? "Print label" : "Generate barcode & print label"}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-surface-2"
                        >
                          <QrCode className="h-3 w-3" /> Label
                        </button>
                        <button
                          onClick={() => onEditVariant(v)}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-surface-2"
                        >
                          <Pencil className="h-3 w-3" /> Edit
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* archive / delete */}
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
            {p.active ? (
              <Button variant="secondary" size="sm" onClick={() => onArchive(false)}>
                <Archive className="h-3.5 w-3.5" /> Archive
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => onArchive(true)}>
                <ArchiveRestore className="h-3.5 w-3.5" /> Restore
              </Button>
            )}
            <span className="text-xs text-text-tertiary">Hides it from sale &amp; storefront, keeps history.</span>
            {isOwner && (
              <button onClick={onDelete} className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-coral-text hover:bg-coral-tile">
                <Trash2 className="h-3.5 w-3.5" /> Permanently delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Variant edit drawer ---------------- */

function VariantEditDrawer({
  variant, onClose, onSaved, onCorrectCost, onError,
}: {
  variant: VariantRow | null;
  onClose: () => void;
  onSaved: () => void;
  onCorrectCost: () => void;
  onError: (m: string) => void;
}) {
  const [form, setForm] = useState({ sku: "", barcode: "", sale_price: "", reorder_point: "", disc_type: "" as DiscType, disc_value: "" });
  const [saving, setSaving] = useState(false);

  // sync when a new variant is opened
  const [lastId, setLastId] = useState<string | null>(null);
  if (variant && variant.id !== lastId) {
    setLastId(variant.id);
    setForm({
      sku: variant.sku,
      barcode: variant.barcode ?? "",
      sale_price: String(variant.sale_price),
      reorder_point: String(variant.reorder_point),
      disc_type: (variant.default_discount_type ?? "") as DiscType,
      disc_value: variant.default_discount_value ? String(variant.default_discount_value) : "",
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!variant) return;
    if (!form.sku.trim()) return onError("SKU is required.");
    if (form.sku.trim().length > MAX_SKU_LENGTH) return onError(skuTooLong(form.sku));
    setSaving(true);
    // Cost is intentionally NOT sent here — it changes only through purchases or
    // the audited "Correct cost price" action (see CorrectCostDialog).
    const res = await updateVariant(variant.id, {
      sku: form.sku,
      barcode: form.barcode || null,
      sale_price: Number(form.sale_price) || 0,
      reorder_point: Number(form.reorder_point) || 0,
      default_discount_type: form.disc_type || null,
      default_discount_value: form.disc_type ? Number(form.disc_value) || 0 : 0,
    });
    setSaving(false);
    if (res?.error) return onError(res.error);
    onSaved();
  }

  return (
    <Drawer
      open={!!variant}
      onClose={onClose}
      title={variant ? `Edit · ${variant.label}` : "Edit variant"}
      footer={
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="edit-variant-form" className="flex-1" disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </Button>
        </div>
      }
    >
      <form id="edit-variant-form" onSubmit={submit} className="space-y-4">
        {variant && <VariantImageField variant={variant} onError={onError} />}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>SKU *</Label>
            <Input
              value={form.sku}
              onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
              maxLength={MAX_SKU_LENGTH}
              aria-describedby="sku-limit"
            />
            <SkuHint id="sku-limit" value={form.sku} />
          </div>
          <div>
            <Label className="flex items-center gap-1.5"><Barcode className="h-3.5 w-3.5" /> Barcode</Label>
            <Input data-scan-input value={form.barcode} onChange={(e) => setForm((f) => ({ ...f, barcode: e.target.value }))} placeholder="Scan or type" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Selling price (₨)</Label>
            <Input type="number" value={form.sale_price} onChange={(e) => setForm((f) => ({ ...f, sale_price: e.target.value }))} />
          </div>
          <div>
            <Label>Cost price (₨)</Label>
            {/* Read-only: cost is driven by purchases (weighted-average). Fixing a
                mistake goes through the audited "Correct" action, not a free edit. */}
            <div className="flex h-[42px] items-center justify-between gap-2 rounded-lg border border-border bg-surface-2 px-3">
              <span className="tnum text-sm font-medium text-text-primary">
                {formatPKR(variant ? variant.avg_cost || variant.cost : 0)}
              </span>
              <button type="button" onClick={onCorrectCost} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline">
                <Coins className="h-3.5 w-3.5" /> Correct
              </button>
            </div>
            <p className="mt-1 text-xs text-text-tertiary">Set by purchases. Use “Correct” only to fix a wrong cost.</p>
          </div>
        </div>
        <div>
          <Label>Low-stock alert at (qty)</Label>
          <Input type="number" value={form.reorder_point} onChange={(e) => setForm((f) => ({ ...f, reorder_point: e.target.value }))} />
          <p className="mt-1 text-xs text-text-tertiary">Get a low-stock alert when on-hand drops to this number.</p>
        </div>
        <DiscountField
          type={form.disc_type}
          value={form.disc_value}
          price={Number(form.sale_price) || 0}
          onType={(v) => setForm((f) => ({ ...f, disc_type: v }))}
          onValue={(v) => setForm((f) => ({ ...f, disc_value: v }))}
        />
        <p className="-mt-1 text-xs text-text-tertiary">Auto-fills at the till; the cashier can change or remove it per sale.</p>
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-[11px] text-text-tertiary">
          On-hand quantity isn’t edited here — it changes only through the Stock area
          (every movement is recorded in the ledger).
        </p>
      </form>
    </Drawer>
  );
}

/* ---------------- Correct cost price (fix a data-entry mistake) ----------------
   Weighted-average cost normally comes from purchases. This is the controlled
   correction: it fixes the cost going forward (inventory value + FUTURE sales'
   COGS) without altering the profit already recorded on past sales.
   - Case A (no sales/purchase history): owner or manager may fix the initial cost.
   - Case B (history exists): OWNER ONLY, with a required reason.                 */
function CorrectCostDialog({
  variant, isOwner, onClose, onDone, onError,
}: {
  variant: VariantRow | null;
  isOwner: boolean;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (m: string) => void;
}) {
  const [ctx, setCtx] = useState<VariantCostContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newCost, setNewCost] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!variant) return;
    let cancelled = false;
    setLoading(true); setCtx(null); setReason(""); setNewCost("");
    getVariantCostContext(variant.id).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if ("error" in r) { onError(r.error); onClose(); return; }
      setCtx(r);
      setNewCost(String(r.cost || r.avgCost || ""));
    });
    return () => { cancelled = true; };
  }, [variant, onError, onClose]);

  const caseB = ctx?.hasHistory ?? false;
  const blocked = caseB && !isOwner; // history + not owner → read-only

  async function submit() {
    if (!variant || !ctx) return;
    const n = Number(newCost);
    if (!Number.isFinite(n) || n < 0) return onError("Enter a valid cost (0 or more).");
    if (caseB && !reason.trim()) return onError("Please add a short reason for the correction.");
    setSaving(true);
    const res = await correctVariantCost(variant.id, n, reason);
    setSaving(false);
    if (res?.error) return onError(res.error);
    onDone(res.hadHistory
      ? "Cost corrected going forward — past sales’ profit is unchanged."
      : "Cost price fixed.");
  }

  return (
    <ConfirmDialog
      open={!!variant}
      onCancel={onClose}
      onConfirm={blocked ? onClose : submit}
      loading={saving}
      tone={caseB ? "danger" : "default"}
      icon={<Coins className="h-5 w-5" />}
      title="Correct cost price"
      confirmLabel={blocked ? "Close" : caseB ? "Correct cost" : "Save cost"}
      cancelLabel={blocked ? "Cancel" : "Cancel"}
      message={
        loading || !ctx ? (
          <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Checking history…</span>
        ) : (
          <div className="space-y-3 text-left">
            <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-text-secondary">
              <div className="flex justify-between"><span>Entered cost</span><b className="tnum text-text-primary">{formatPKR(ctx.cost)}</b></div>
              <div className="flex justify-between"><span>Weighted-avg (stock)</span><b className="tnum text-text-primary">{formatPKR(ctx.avgCost)}</b></div>
              <div className="flex justify-between"><span>On hand</span><b className="tnum text-text-primary">{ctx.onHand}</b></div>
            </div>

            {caseB ? (
              <div className="rounded-lg bg-coral-tile px-3 py-2 text-xs text-coral-text">
                This product already has sales/purchase history. Past sales keep their
                recorded profit — this only fixes the cost used for stock value and
                <b> future</b> sales.{!isOwner && " Only the owner can do this."}
              </div>
            ) : (
              <div className="rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-600">
                No purchases or sales yet — this safely fixes the initial (opening) cost.
              </div>
            )}

            {!blocked && (
              <>
                <div>
                  <Label>Corrected cost price (₨)</Label>
                  <Input type="number" inputMode="decimal" value={newCost} autoFocus
                    onChange={(e) => setNewCost(e.target.value)} />
                </div>
                {caseB && (
                  <div>
                    <Label>Reason *</Label>
                    <Input value={reason} placeholder="e.g. wrong cost entered at setup"
                      onChange={(e) => setReason(e.target.value)} />
                  </div>
                )}
              </>
            )}

            {ctx.lastCorrection && (
              <p className="text-[11px] text-text-tertiary">
                Last corrected to {formatPKR(ctx.lastCorrection.new_cost)}
                {ctx.lastCorrection.reason ? ` — “${ctx.lastCorrection.reason}”` : ""}.
              </p>
            )}
          </div>
        )
      }
    />
  );
}

/* ---------------- Optional per-variant image ---------------- */

function VariantImageField({ variant, onError }: { variant: VariantRow; onError: (m: string) => void }) {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(variant.image_url);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  // reset when a different variant is opened
  const [lastId, setLastId] = useState(variant.id);
  if (variant.id !== lastId) { setLastId(variant.id); setUrl(variant.image_url); }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    const res = await uploadVariantImage(variant.id, fd);
    setBusy(false);
    if (res?.error) return onError(res.error);
    if (res && "image_url" in res && res.image_url) { setUrl(res.image_url); toast("Variant photo updated"); }
  }
  async function clear() {
    setBusy(true);
    const res = await removeVariantImage(variant.id);
    setBusy(false);
    if (res?.error) return onError(res.error);
    setUrl(null);
    toast("Variant photo removed");
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center gap-3">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-2 text-text-tertiary">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImagePlus className="h-5 w-5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-primary">Variant photo <span className="font-normal text-text-tertiary">· optional</span></p>
          <p className="text-xs text-text-tertiary">{url ? "This variant shows its own photo." : "Using the product photo. Add one to override it for this variant."}</p>
        </div>
        <input ref={ref} type="file" accept="image/*" onChange={onFile} className="hidden" />
        <div className="flex shrink-0 gap-1.5">
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => ref.current?.click()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />} {url ? "Replace" : "Add"}
          </Button>
          {url && (
            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={clear} title="Remove variant photo">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Add product drawer (with matrix generator) ---------------- */

interface VariantDraft {
  combo: string[];
  sku: string;
  barcode: string;
  sale_price: string;
  cost: string;
  reorder: string;
  disc_type: "" | "PERCENT" | "FIXED";
  disc_value: string;
  opening_qty: string;
}

type DiscType = "" | "PERCENT" | "FIXED";

/** Compact "Default discount" control: type (none/%/Rs) + value. */
function DiscountField({
  type, value, price, onType, onValue,
}: {
  type: DiscType; value: string; price: number;
  onType: (v: DiscType) => void; onValue: (v: string) => void;
}) {
  const p = Number(price) || 0;
  const v = Number(value) || 0;
  const off = type === "PERCENT" ? (p * v) / 100 : type === "FIXED" ? v : 0;
  const net = Math.max(p - off, 0);
  return (
    <div>
      <Label>Default discount</Label>
      <div className="flex gap-2">
        <Select value={type} onChange={(e) => onType(e.target.value as DiscType)} className="w-32">
          <option value="">No discount</option>
          <option value="PERCENT">Percent %</option>
          <option value="FIXED">Fixed ₨</option>
        </Select>
        {type && (
          <Input type="number" value={value} onChange={(e) => onValue(e.target.value)} placeholder={type === "PERCENT" ? "e.g. 10" : "e.g. 50"} className="w-28" />
        )}
        {type && p > 0 && v > 0 && (
          <span className="flex items-center text-xs text-text-tertiary">
            → sells at <span className="ml-1 font-medium text-green-text">{formatPKR(net)}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function cartesian(lists: string[][]): string[][] {
  return lists.reduce<string[][]>(
    (acc, list) => acc.flatMap((a) => list.map((x) => [...a, x])),
    [[]],
  );
}

function AddProductDrawer({
  open, onClose, catTree, lowStockDefault, initialBarcode, onSaved, onError,
}: {
  open: boolean;
  onClose: () => void;
  catTree: CatTreeRow[];
  lowStockDefault: number;
  /** Barcode to pre-fill when the scanner opened this for an unknown code. */
  initialBarcode?: string | null;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const reorderDefault = String(lowStockDefault);
  const [base, setBase] = useState({ name: "", brand: "", category_id: "", base_sku: "", base_price: "", unit: "pcs", description: "" });
  const [parentCat, setParentCat] = useState("");
  const [hasVariants, setHasVariants] = useState(false);
  const [images, setImages] = useState<File[]>([]);

  const [single, setSingle] = useState({ sku: "", barcode: "", cost: "", reorder: reorderDefault, opening_qty: "", disc_type: "" as DiscType, disc_value: "" });
  const [options, setOptions] = useState<{ name: string; values: string }[]>([{ name: "", values: "" }]);
  const [matrix, setMatrix] = useState<VariantDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string>();

  // Opened from a scan of an unknown barcode → prefill it as a simple product.
  useEffect(() => {
    if (open && initialBarcode) {
      setHasVariants(false);
      setSingle((s) => ({ ...s, barcode: initialBarcode }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialBarcode]);

  const reset = () => {
    setBase({ name: "", brand: "", category_id: "", base_sku: "", base_price: "", unit: "pcs", description: "" });
    setParentCat("");
    setHasVariants(false);
    setImages([]);
    setSingle({ sku: "", barcode: "", cost: "", reorder: reorderDefault, opening_qty: "", disc_type: "", disc_value: "" });
    setOptions([{ name: "", values: "" }]);
    setMatrix([]);
    setErr(undefined);
  };

  const definedOptions = options
    .map((o) => ({ name: o.name.trim(), values: o.values.split(",").map((v) => v.trim()).filter(Boolean) }))
    .filter((o) => o.name && o.values.length);

  function generate() {
    if (!definedOptions.length) { setErr("Add at least one option with values."); return; }
    setErr(undefined);
    const combos = cartesian(definedOptions.map((o) => o.values));
    const baseSku = base.base_sku.trim() || "SKU";
    setMatrix(
      combos.map((combo, i) => ({
        combo,
        sku: `${baseSku}-${i + 1}`,
        barcode: "",
        sale_price: base.base_price || "",
        cost: "",
        reorder: reorderDefault,
        disc_type: "" as DiscType,
        disc_value: "",
        opening_qty: "",
      })),
    );
  }

  const setMatrixField = (i: number, k: keyof VariantDraft, val: string) =>
    setMatrix((m) => m.map((row, idx) => (idx === i ? { ...row, [k]: val } : row)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(undefined);
    if (!base.name) { setErr("Product name is required."); return; }

    let payload: ProductInput;
    if (!hasVariants) {
      if (!single.sku) { setErr("SKU is required."); return; }
      const v: VariantInput = {
        sku: single.sku,
        barcode: single.barcode || null,
        sale_price: Number(base.base_price) || 0,
        cost: Number(single.cost) || 0,
        reorder_point: Number(single.reorder) || 0,
        default_discount_type: single.disc_type || null,
        default_discount_value: single.disc_type ? Number(single.disc_value) || 0 : 0,
        opening_qty: single.opening_qty ? Number(single.opening_qty) : null,
        option_values: [],
      };
      payload = {
        name: base.name, brand: base.brand || null, category_id: base.category_id || null,
        description: base.description || null, base_unit: base.unit, base_price: Number(base.base_price) || 0,
        has_variants: false, options: [], variants: [v],
      };
    } else {
      if (!matrix.length) { setErr("Generate the variant matrix first."); return; }
      if (matrix.some((m) => !m.sku)) { setErr("Every variant needs a SKU."); return; }
      payload = {
        name: base.name, brand: base.brand || null, category_id: base.category_id || null,
        description: base.description || null, base_unit: base.unit, base_price: Number(base.base_price) || 0,
        has_variants: true,
        options: definedOptions,
        variants: matrix.map((m) => ({
          sku: m.sku,
          barcode: m.barcode || null,
          sale_price: Number(m.sale_price) || Number(base.base_price) || 0,
          cost: Number(m.cost) || 0,
          reorder_point: Number(m.reorder) || 0,
          default_discount_type: m.disc_type || null,
          default_discount_value: m.disc_type ? Number(m.disc_value) || 0 : 0,
          opening_qty: m.opening_qty ? Number(m.opening_qty) : null,
          option_values: m.combo,
        })),
      };
    }

    setSaving(true);
    const res = await createProduct(payload);
    if (res?.error) { setSaving(false); setErr(res.error); onError(res.error); return; }
    // Upload any selected photos now that the product exists — one request per
    // file (same mechanism as the variant upload) so the body stays small.
    if (images.length && "id" in res && res.id) {
      for (const f of images) {
        const fd = new FormData();
        fd.append("file", f);
        const up = await uploadProductImage(res.id, fd);
        if (up && "error" in up && up.error) {
          onError(`Product saved, but a photo failed: ${up.error}`);
          break;
        }
      }
    }
    setSaving(false);
    reset();
    onSaved();
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Add Product"
      width="max-w-2xl"
      footer={
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="add-product-form" className="flex-1" disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save Product
          </Button>
        </div>
      }
    >
      <form id="add-product-form" onSubmit={submit} className="space-y-4">
        {/* 1 · Basics */}
        <Section title="Basics" hint="What the product is and where it lives in your catalogue.">
          <div>
            <Label>Product name *</Label>
            <Input value={base.name} onChange={(e) => setBase((b) => ({ ...b, name: e.target.value }))} placeholder="e.g. Maybelline SuperStay Lipstick" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Brand</Label>
              <Input value={base.brand} onChange={(e) => setBase((b) => ({ ...b, brand: e.target.value }))} placeholder="e.g. Maybelline" />
            </div>
            <div>
              <Label>Sold by (unit)</Label>
              <Select value={base.unit} onChange={(e) => setBase((b) => ({ ...b, unit: e.target.value }))}>
                {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
              </Select>
            </div>
          </div>
          <CategoryPicker
            catTree={catTree}
            parentCat={parentCat}
            setParentCat={setParentCat}
            categoryId={base.category_id}
            setCategoryId={(v) => setBase((b) => ({ ...b, category_id: v }))}
          />
          <div>
            <Label>Description</Label>
            <textarea
              value={base.description}
              onChange={(e) => setBase((b) => ({ ...b, description: e.target.value }))}
              rows={2}
              placeholder="Short description (shown on the storefront)"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:border-brand-500 focus-visible:outline-none"
            />
          </div>
          <div>
            <Label>Product image(s)</Label>
            <ImageFilePicker files={images} onChange={setImages} />
          </div>
        </Section>

        {/* variant toggle */}
        <div className="flex items-center justify-between rounded-xl border border-border bg-surface-2 p-3">
          <div>
            <p className="text-sm font-medium text-text-primary">This product has variants</p>
            <p className="text-xs text-text-tertiary">Size, Shade, Flavor, Color…</p>
          </div>
          <button
            type="button"
            onClick={() => setHasVariants((v) => !v)}
            className={cn("relative h-6 w-11 rounded-full transition-colors", hasVariants ? "bg-brand-500" : "bg-border")}
            aria-pressed={hasVariants}
          >
            <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all", hasVariants ? "left-[1.375rem]" : "left-0.5")} />
          </button>
        </div>

        {!hasVariants ? (
          <>
            {/* 2 · Pricing */}
            <Section title="Pricing" hint="Cost is what you pay; selling price is what the customer pays.">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Selling price (₨)</Label>
                  <Input type="number" value={base.base_price} onChange={(e) => setBase((b) => ({ ...b, base_price: e.target.value }))} placeholder="0" />
                </div>
                <div>
                  <Label>Cost price (₨)</Label>
                  <Input type="number" value={single.cost} onChange={(e) => setSingle((s) => ({ ...s, cost: e.target.value }))} placeholder="0" />
                </div>
              </div>
              <DiscountField
                type={single.disc_type}
                value={single.disc_value}
                price={Number(base.base_price) || 0}
                onType={(v) => setSingle((s) => ({ ...s, disc_type: v }))}
                onValue={(v) => setSingle((s) => ({ ...s, disc_value: v }))}
              />
              <Help>The default discount auto-fills at the till — the cashier can change or remove it per sale.</Help>
            </Section>

            {/* 3 · Stock */}
            <Section title="Stock" hint="How many you have now, and when to warn you it&rsquo;s running low.">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Opening stock (qty)</Label>
                  <Input type="number" value={single.opening_qty} onChange={(e) => setSingle((s) => ({ ...s, opening_qty: e.target.value }))} placeholder="0" />
                </div>
                <div>
                  <Label>Low-stock alert at (qty)</Label>
                  <Input type="number" value={single.reorder} onChange={(e) => setSingle((s) => ({ ...s, reorder: e.target.value }))} />
                </div>
              </div>
              <Help>This product&rsquo;s own threshold — you&rsquo;re warned when on-hand drops to it.</Help>
            </Section>

            {/* 4 · Identifiers */}
            <Section title="Identifiers" hint="Codes used to find and scan the product.">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Product code (SKU) *</Label>
                  <Input
                    value={single.sku}
                    onChange={(e) => setSingle((s) => ({ ...s, sku: e.target.value }))}
                    placeholder="GFT-BOX-02"
                    maxLength={MAX_SKU_LENGTH}
                  />
                  <SkuHint value={single.sku} />
                </div>
                <div>
                  <Label className="flex items-center gap-1.5"><Barcode className="h-3.5 w-3.5" /> Barcode</Label>
                  <Input data-scan-input value={single.barcode} onChange={(e) => setSingle((s) => ({ ...s, barcode: e.target.value }))} placeholder="Scan or type" />
                </div>
              </div>
              <Help>SKU is a unique internal code. Barcode is the printed number you scan at the till (leave blank to generate one later).</Help>
            </Section>
          </>
        ) : (
          <Section title="Variants" hint="Define options, generate the combinations, then set each one's details.">
            {/* base price + sku used as defaults for the generated variants */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Default selling price (₨)</Label>
                <Input type="number" value={base.base_price} onChange={(e) => setBase((b) => ({ ...b, base_price: e.target.value }))} placeholder="0" />
              </div>
              <div>
                <Label>Base SKU</Label>
                <Input
                  value={base.base_sku}
                  onChange={(e) => setBase((b) => ({ ...b, base_sku: e.target.value }))}
                  placeholder="COS-LIP"
                  // Generated variant SKUs append "-1", "-2", ... so the base
                  // must leave room for the suffix or every row it makes is
                  // over the label limit.
                  maxLength={MAX_SKU_LENGTH - 4}
                />
              </div>
            </div>
            <Help>Each generated variant starts from these, then you fine-tune per row below.</Help>

            {/* options builder */}
            <div className="rounded-xl border border-border bg-surface-2/40 p-3">
              <p className="mb-2 text-xs font-medium text-text-secondary">Step 1 — define options (up to 2, e.g. Size, Shade)</p>
              {options.map((o, i) => (
                <div key={i} className="mb-2 grid grid-cols-[1fr_1.6fr] gap-2">
                  <Input
                    value={o.name}
                    onChange={(e) => setOptions((arr) => arr.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x))}
                    placeholder={i === 0 ? "Shade" : "Size"}
                  />
                  <Input
                    value={o.values}
                    onChange={(e) => setOptions((arr) => arr.map((x, idx) => idx === i ? { ...x, values: e.target.value } : x))}
                    placeholder="Comma separated: Ruby Red, Nude, Coral"
                  />
                </div>
              ))}
              {options.length < 2 && (
                <button type="button" onClick={() => setOptions((a) => [...a, { name: "", values: "" }])} className="text-xs font-medium text-brand-600 hover:underline">
                  + Add option
                </button>
              )}
              <div className="mt-3">
                <Button type="button" variant="secondary" className="h-8 px-3 text-xs" onClick={generate}>
                  <Wand2 className="h-3.5 w-3.5" /> Generate variants
                </Button>
              </div>
            </div>

            {/* matrix */}
            {matrix.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-border">
                <p className="border-b border-border bg-surface-2/60 px-2 py-1.5 text-xs font-medium text-text-secondary">Step 2 — set each variant&rsquo;s details</p>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-surface-2 text-text-tertiary">
                      <th className="px-2 py-2 text-left font-semibold">Variant</th>
                      <th className="px-2 py-2 text-left font-semibold">SKU</th>
                      <th className="px-2 py-2 text-left font-semibold">Barcode</th>
                      <th className="px-2 py-2 text-right font-semibold">Sell ₨</th>
                      <th className="px-2 py-2 text-right font-semibold">Cost ₨</th>
                      <th className="px-2 py-2 text-left font-semibold">Discount</th>
                      <th className="px-2 py-2 text-right font-semibold">Reorder</th>
                      <th className="px-2 py-2 text-right font-semibold">Opening</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matrix.map((m, i) => (
                      <tr key={i} className="border-b border-border/60 last:border-0">
                        <td className="whitespace-nowrap px-2 py-1.5 font-medium text-text-primary">{m.combo.join(" / ")}</td>
                        <td className="px-2 py-1.5">
                          <Input
                            value={m.sku}
                            onChange={(e) => setMatrixField(i, "sku", e.target.value)}
                            maxLength={MAX_SKU_LENGTH}
                            className={cn("h-7 w-24 text-xs", m.sku.trim().length > MAX_SKU_LENGTH && "border-coral-text")}
                            title={m.sku.trim().length > MAX_SKU_LENGTH ? skuTooLong(m.sku) : undefined}
                          />
                        </td>
                        <td className="px-2 py-1.5"><Input data-scan-input value={m.barcode} onChange={(e) => setMatrixField(i, "barcode", e.target.value)} className="h-7 w-28 text-xs" /></td>
                        <td className="px-2 py-1.5"><Input type="number" value={m.sale_price} onChange={(e) => setMatrixField(i, "sale_price", e.target.value)} className="h-7 w-16 text-xs" /></td>
                        <td className="px-2 py-1.5"><Input type="number" value={m.cost} onChange={(e) => setMatrixField(i, "cost", e.target.value)} className="h-7 w-16 text-xs" /></td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-1">
                            <select value={m.disc_type} onChange={(e) => setMatrixField(i, "disc_type", e.target.value)} className="h-7 rounded-md border border-border bg-surface px-1 text-xs">
                              <option value="">—</option>
                              <option value="PERCENT">%</option>
                              <option value="FIXED">₨</option>
                            </select>
                            {m.disc_type && <Input type="number" value={m.disc_value} onChange={(e) => setMatrixField(i, "disc_value", e.target.value)} className="h-7 w-14 text-xs" />}
                          </div>
                        </td>
                        <td className="px-2 py-1.5"><Input type="number" value={m.reorder} onChange={(e) => setMatrixField(i, "reorder", e.target.value)} className="h-7 w-14 text-xs" /></td>
                        <td className="px-2 py-1.5"><Input type="number" value={m.opening_qty} onChange={(e) => setMatrixField(i, "opening_qty", e.target.value)} className="h-7 w-14 text-xs" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        )}

        <FieldError message={err} />
      </form>
    </Drawer>
  );
}

function Help({ children }: { children: React.ReactNode }) {
  return <p className="-mt-1 text-xs leading-relaxed text-text-tertiary">{children}</p>;
}

/** A titled group of fields — keeps the long product form scannable. */
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border p-3.5">
      <div className="mb-3">
        <h3 className="font-heading text-sm font-semibold text-text-primary">{title}</h3>
        {hint && <p className="text-xs text-text-tertiary">{hint}</p>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/** Category + Sub-category selector. Lists admin-created categories; the
 *  sub-category list is filtered by the chosen parent. Shared by Add & Edit. */
function CategoryPicker({
  catTree, parentCat, setParentCat, categoryId, setCategoryId,
}: {
  catTree: CatTreeRow[];
  parentCat: string; setParentCat: (v: string) => void;
  categoryId: string; setCategoryId: (v: string) => void;
}) {
  const topCats = catTree.filter((c) => !c.parent_id);
  const subCats = catTree.filter((c) => c.parent_id === parentCat);
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <Label>Category</Label>
        <Select
          value={parentCat}
          onChange={(e) => { const id = e.target.value; setParentCat(id); setCategoryId(id); }}
        >
          <option value="">— None —</option>
          {topCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        {topCats.length === 0 && <p className="mt-1 text-xs text-text-tertiary">No categories yet — add them in the Categories screen.</p>}
      </div>
      <div>
        <Label>Sub-category</Label>
        <Select
          value={categoryId === parentCat ? "" : categoryId}
          onChange={(e) => setCategoryId(e.target.value || parentCat)}
          disabled={!parentCat || subCats.length === 0}
        >
          <option value="">{!parentCat ? "Pick a category first" : subCats.length ? "— None —" : "No sub-categories"}</option>
          {subCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </div>
    </div>
  );
}

/* ---------------- Local image picker (before product exists) ---------------- */

function ImageFilePicker({ files, onChange }: { files: File[]; onChange: (f: File[]) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  function add(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/") && f.size <= 5_242_880);
    e.target.value = "";
    onChange([...files, ...picked].slice(0, 8));
  }

  return (
    <div>
      <input ref={ref} type="file" accept="image/*" multiple onChange={add} className="hidden" />
      <div className="flex flex-wrap gap-2">
        {files.map((f, i) => (
          <div key={i} className="group relative h-16 w-16 overflow-hidden rounded-md border border-border bg-surface-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previews[i]} alt="" className="h-full w-full object-cover" />
            {i === 0 && <span className="absolute left-0 top-0 bg-brand-500 px-1 text-[8px] font-medium text-white">Cover</span>}
            <button type="button" onClick={() => onChange(files.filter((_, idx) => idx !== i))} className="absolute right-0 top-0 bg-black/50 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100">
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <button type="button" onClick={() => ref.current?.click()} className="flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-text-tertiary hover:border-brand-500">
          <ImagePlus className="h-4 w-4" /><span className="text-[10px]">Add</span>
        </button>
      </div>
      <p className="mt-1 text-[11px] text-text-tertiary">First photo is the cover. JPG/PNG/WebP, up to 5 MB each.</p>
    </div>
  );
}

/* ---------------- Edit product (all product-level fields) ---------------- */

function EditProductDrawer({
  product, catTree, onClose, onSaved, onError,
}: {
  product: ProductRow | null;
  catTree: CatTreeRow[];
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [form, setForm] = useState({ name: "", brand: "", category_id: "", unit: "pcs", description: "", active: true });
  const [parentCat, setParentCat] = useState("");
  const [saving, setSaving] = useState(false);
  const [lastId, setLastId] = useState<string | null>(null);

  if (product && product.id !== lastId) {
    setLastId(product.id);
    const cat = catTree.find((c) => c.id === product.category_id);
    setParentCat(cat ? (cat.parent_id ?? cat.id) : "");
    setForm({
      name: product.name, brand: product.brand ?? "", category_id: product.category_id ?? "",
      unit: product.base_unit || "pcs", description: product.description ?? "", active: product.active,
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!product) return;
    if (!form.name.trim()) return onError("Product name is required.");
    setSaving(true);
    const res = await updateProduct(product.id, {
      name: form.name, brand: form.brand || null, category_id: form.category_id || null,
      description: form.description || null, base_unit: form.unit, active: form.active,
    });
    setSaving(false);
    if (res?.error) return onError(res.error);
    onSaved();
  }

  return (
    <Drawer
      open={!!product}
      onClose={onClose}
      title="Edit product"
      width="max-w-2xl"
      footer={
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="edit-product-form" className="flex-1" disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save changes
          </Button>
        </div>
      }
    >
      {product && (
        <form id="edit-product-form" onSubmit={submit} className="space-y-4">
          <Section title="Basics" hint="Name, brand, category and how it&rsquo;s sold.">
            <div>
              <Label>Product name *</Label>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Brand</Label>
                <Input value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))} />
              </div>
              <div>
                <Label>Sold by (unit)</Label>
                <Select value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}>
                  {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                </Select>
              </div>
            </div>
            <CategoryPicker
              catTree={catTree}
              parentCat={parentCat}
              setParentCat={setParentCat}
              categoryId={form.category_id}
              setCategoryId={(v) => setForm((f) => ({ ...f, category_id: v }))}
            />
            <div>
              <Label>Description</Label>
              <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:border-brand-500 focus-visible:outline-none" />
            </div>
          </Section>

          <Section title="Image(s)">
            <ImageGallery productId={product.id} />
          </Section>

          <Section title="Status">
            <label className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-sm">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} className="h-4 w-4 rounded border-border" />
              <span className="text-text-primary">Active</span>
              <span className="text-text-tertiary">— unchecking archives it (hidden from sale &amp; storefront, history kept)</span>
            </label>
          </Section>

          <p className="rounded-lg bg-surface-2 px-3 py-2 text-[11px] text-text-tertiary">
            Pricing, default discount, SKU, barcode, cost and low-stock are edited per variant from each variant&rsquo;s <strong>Edit</strong> button. On-hand quantity changes only through the Stock area.
          </p>
        </form>
      )}
    </Drawer>
  );
}

/* ---------------- Permanent delete dialog ---------------- */

function DeleteProductDialog({
  product, onClose, onArchive, onDeleted,
}: {
  product: ProductRow | null;
  onClose: () => void;
  onArchive: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => { setTyped(""); setBlocked(false); }, [product]);

  if (!product) return null;
  const match = typed.trim() === product.name.trim();

  async function confirmDelete() {
    if (!product || !match) return;
    setBusy(true);
    const res = await permanentlyDeleteProduct(product.id, typed);
    setBusy(false);
    if (res && "error" in res && res.error) {
      if ("hasHistory" in res) setBlocked(true);
      else toast(res.error, "error");
      return;
    }
    toast("Product permanently deleted");
    onDeleted();
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 animate-fade-in" onClick={busy ? undefined : onClose} />
      <div className="relative z-10 w-full max-w-md rounded-2xl bg-surface p-5 shadow-drawer animate-fade-in">
        <div className="mb-3 flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-coral-tile text-coral-icon">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <h2 className="font-heading text-lg font-semibold text-text-primary">Permanently delete</h2>
            <p className="text-sm text-text-secondary">{product.name}</p>
          </div>
        </div>

        {blocked ? (
          <>
            <p className="rounded-lg bg-amber-tile px-3 py-2 text-sm text-amber-text">
              This product has transaction history, so it can’t be permanently deleted — that would corrupt your reports.
              You can <strong>archive</strong> it instead to hide it from sale and the storefront while keeping history intact.
            </p>
            <div className="mt-4 flex gap-2">
              <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
              <Button type="button" className="flex-1" onClick={onArchive}><Archive className="h-4 w-4" /> Archive instead</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-text-secondary">
              This permanently removes the product, its variants, barcodes and storefront listing. <strong>This can’t be undone.</strong>
            </p>
            <label className="mt-4 block">
              <span className="text-xs text-text-tertiary">Type <span className="font-medium text-text-primary">{product.name}</span> to confirm</span>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={product.name} autoFocus className="mt-1" />
            </label>
            <div className="mt-4 flex gap-2">
              <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
              <Button type="button" variant="danger" className="flex-1" disabled={!match || busy} onClick={confirmDelete}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete forever
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
