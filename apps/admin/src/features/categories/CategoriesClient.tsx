"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FolderTree, Plus, Pencil, Trash2, Check, X, Loader2, CornerDownRight,
  Archive, ChevronDown, ChevronRight, ArchiveRestore, History,
} from "lucide-react";
import { PageHeader } from "@hamza/shared/ui/PageHeader";
import { Card } from "@hamza/shared/ui/Card";
import { Button } from "@hamza/shared/ui/Button";
import { Input } from "@hamza/shared/ui/Input";
import { EmptyState } from "@hamza/shared/ui/EmptyState";
import { useToast } from "@hamza/shared/ui/Toast";
import { formatPKR, formatNumber } from "@hamza/shared/utils";
import { createCategory, updateCategory, deleteCategory } from "./actions";
import {
  getArchivedProductsForCategory, restoreArchivedProduct, type ArchivedProductRow,
} from "./archived";

/** Bucket id for archived products that have no category at all. */
const UNCATEGORISED = "__uncategorised__";

export interface CategoryNode {
  id: string;
  name: string;
  parent_id: string | null;
  /** Active products in this category (roll-up incl. sub-categories). */
  product_count: number;
  /** Phase J — archived products filed DIRECTLY under this category. */
  archived_count: number;
  /** Archived products incl. every sub-category. */
  archived_rollup: number;
}

export function CategoriesClient({
  categories,
  uncategorisedArchived = 0,
}: {
  categories: CategoryNode[];
  /** Archived products with no category, shown in their own bucket. */
  uncategorisedArchived?: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [addParent, setAddParent] = useState<string | null | undefined>(undefined); // undefined = idle, null = top-level
  const [addName, setAddName] = useState("");
  // Phase J — which category's archived history is expanded (one at a time, so
  // the on-demand fetch stays cheap on a large catalogue).
  const [archiveOpen, setArchiveOpen] = useState<string | null>(null);

  const tree = useMemo(() => {
    const parents = categories.filter((c) => !c.parent_id);
    const byParent = new Map<string, CategoryNode[]>();
    for (const c of categories) if (c.parent_id) {
      const arr = byParent.get(c.parent_id) ?? [];
      arr.push(c);
      byParent.set(c.parent_id, arr);
    }
    return parents.map((p) => ({ ...p, children: byParent.get(p.id) ?? [] }));
  }, [categories]);

  async function run<T extends { error?: string }>(fn: () => Promise<T>, ok: string) {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (res?.error) { toast(res.error, "error"); return false; }
    toast(ok);
    router.refresh();
    return true;
  }

  async function submitAdd() {
    if (!addName.trim()) return;
    const done = await run(() => createCategory({ name: addName, parent_id: addParent ?? null }), addParent ? "Sub-category added" : "Category added");
    if (done) { setAddName(""); setAddParent(undefined); }
  }
  async function submitEdit() {
    if (!editId || !editName.trim()) return;
    const done = await run(() => updateCategory(editId, { name: editName }), "Renamed");
    if (done) setEditId(null);
  }

  return (
    <div className="min-w-0">
      <PageHeader
        title="Categories"
        subtitle="Organise products into categories and sub-categories"
        actions={
          <Button size="sm" onClick={() => { setAddParent(null); setAddName(""); }}>
            <Plus className="h-4 w-4" /> New category
          </Button>
        }
      />

      <Card className="min-w-0 max-w-full divide-y divide-border">
        {/* add top-level */}
        {addParent === null && (
          <AddRow
            placeholder="New category name"
            value={addName}
            onChange={setAddName}
            onSave={submitAdd}
            onCancel={() => setAddParent(undefined)}
            busy={busy}
          />
        )}

        {tree.length === 0 && addParent === undefined ? (
          <EmptyState icon={FolderTree} title="No categories yet" description="Create your first category to organise products." />
        ) : tree.map((p) => (
          <div key={p.id}>
            {/* parent row */}
            <Row
              node={p}
              isEditing={editId === p.id}
              editName={editName}
              setEditName={setEditName}
              onStartEdit={() => { setEditId(p.id); setEditName(p.name); }}
              onSaveEdit={submitEdit}
              onCancelEdit={() => setEditId(null)}
              onDelete={() => run(() => deleteCategory(p.id), "Category deleted")}
              onAddSub={() => { setAddParent(p.id); setAddName(""); }}
              archiveOpen={archiveOpen === p.id}
              onToggleArchive={() => setArchiveOpen((c) => (c === p.id ? null : p.id))}
              busy={busy}
            />
            {archiveOpen === p.id && <ArchivedPanel categoryId={p.id} onRestored={() => router.refresh()} onError={(m) => toast(m, "error")} />}
            {/* children */}
            {p.children.map((c) => (
              <div key={c.id}>
                <Row
                  node={c}
                  indent
                  isEditing={editId === c.id}
                  editName={editName}
                  setEditName={setEditName}
                  onStartEdit={() => { setEditId(c.id); setEditName(c.name); }}
                  onSaveEdit={submitEdit}
                  onCancelEdit={() => setEditId(null)}
                  onDelete={() => run(() => deleteCategory(c.id), "Sub-category deleted")}
                  archiveOpen={archiveOpen === c.id}
                  onToggleArchive={() => setArchiveOpen((x) => (x === c.id ? null : c.id))}
                  busy={busy}
                />
                {archiveOpen === c.id && <ArchivedPanel categoryId={c.id} indent onRestored={() => router.refresh()} onError={(m) => toast(m, "error")} />}
              </div>
            ))}
            {/* add sub under this parent */}
            {addParent === p.id && (
              <AddRow
                indent
                placeholder={`New sub-category under ${p.name}`}
                value={addName}
                onChange={setAddName}
                onSave={submitAdd}
                onCancel={() => setAddParent(undefined)}
                busy={busy}
              />
            )}
          </div>
        ))}

        {/* Archived products that were never filed under a category */}
        {uncategorisedArchived > 0 && (
          <div>
            <div className="flex min-w-0 items-center gap-2 px-4 py-2.5">
              <span className="truncate text-sm text-text-secondary">Uncategorised</span>
              <button
                onClick={() => setArchiveOpen((c) => (c === UNCATEGORISED ? null : UNCATEGORISED))}
                className="flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-tertiary hover:bg-border/60"
              >
                <Archive className="h-3 w-3" /> {uncategorisedArchived} archived
              </button>
            </div>
            {archiveOpen === UNCATEGORISED && (
              <ArchivedPanel categoryId={UNCATEGORISED} onRestored={() => router.refresh()} onError={(m) => toast(m, "error")} />
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({
  node, indent, isEditing, editName, setEditName, onStartEdit, onSaveEdit, onCancelEdit, onDelete, onAddSub,
  archiveOpen, onToggleArchive, busy,
}: {
  node: CategoryNode;
  indent?: boolean;
  isEditing: boolean;
  editName: string;
  setEditName: (v: string) => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onAddSub?: () => void;
  archiveOpen: boolean;
  onToggleArchive: () => void;
  busy: boolean;
}) {
  const archived = indent ? node.archived_count : node.archived_rollup;
  return (
    <div className={`flex min-w-0 items-center gap-2 px-4 py-2.5 ${indent ? "pl-10" : ""}`}>
      {indent && <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />}
      {isEditing ? (
        <>
          <Input value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus className="h-8 max-w-xs"
            onKeyDown={(e) => { if (e.key === "Enter") onSaveEdit(); if (e.key === "Escape") onCancelEdit(); }} />
          <button onClick={onSaveEdit} disabled={busy} className="rounded-md p-1.5 text-green-text hover:bg-surface-2" title="Save"><Check className="h-4 w-4" /></button>
          <button onClick={onCancelEdit} className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-2" title="Cancel"><X className="h-4 w-4" /></button>
        </>
      ) : (
        <>
          <span className={`truncate ${indent ? "text-sm text-text-secondary" : "font-medium text-text-primary"}`}>{node.name}</span>
          <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-tertiary">{node.product_count} {node.product_count === 1 ? "product" : "products"}</span>
          {archived > 0 && (
            <button
              type="button"
              onClick={onToggleArchive}
              title="Show archived products and their history"
              className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors ${
                archiveOpen ? "bg-brand-500 text-white" : "bg-amber-tile text-amber-text hover:opacity-80"
              }`}
            >
              {archiveOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <Archive className="h-3 w-3" /> {archived} archived
            </button>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {onAddSub && (
              <button onClick={onAddSub} className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-2" title="Add sub-category"><Plus className="h-4 w-4" /></button>
            )}
            <button onClick={onStartEdit} className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-2" title="Rename"><Pencil className="h-4 w-4" /></button>
            <button onClick={onDelete} disabled={busy} className="rounded-md p-1.5 text-coral-text hover:bg-coral-tile" title="Delete"><Trash2 className="h-4 w-4" /></button>
          </div>
        </>
      )}
    </div>
  );
}

function AddRow({
  indent, placeholder, value, onChange, onSave, onCancel, busy,
}: {
  indent?: boolean;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className={`flex min-w-0 items-center gap-2 bg-surface-2/40 px-4 py-2.5 ${indent ? "pl-10" : ""}`}>
      {indent && <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />}
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus className="h-8 max-w-xs"
        onKeyDown={(e) => { if (e.key === "Enter") onSave(); if (e.key === "Escape") onCancel(); }} />
      <Button size="sm" onClick={onSave} disabled={busy || !value.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Add</Button>
      <button onClick={onCancel} className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-2" title="Cancel"><X className="h-4 w-4" /></button>
    </div>
  );
}

/**
 * Phase J — the archived products filed under one category, with the history
 * that archiving never deleted: lifetime units sold and revenue, when the item
 * last sold, when stock last moved, and any stock still on the shelf.
 *
 * Loaded on demand (one category at a time) so the Categories page itself stays
 * a cheap render however long the archive gets.
 */
function ArchivedPanel({
  categoryId, indent, onRestored, onError,
}: {
  categoryId: string;
  indent?: boolean;
  onRestored: () => void;
  onError: (m: string) => void;
}) {
  const [rows, setRows] = useState<ArchivedProductRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    (async () => {
      const res = await getArchivedProductsForCategory(categoryId);
      if (cancelled) return;
      if ("error" in res) { onError(res.error); setRows([]); return; }
      setRows(res.rows);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId]);

  async function restore(id: string) {
    setBusyId(id);
    const res = await restoreArchivedProduct(id);
    setBusyId(null);
    if ("error" in res) { onError(res.error); return; }
    setRows((r) => (r ? r.filter((x) => x.id !== id) : r));
    onRestored();
  }

  const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-PK", { day: "2-digit", month: "short", year: "numeric" }) : "—";

  return (
    <div className={`border-t border-border bg-surface-2/40 px-4 py-3 ${indent ? "pl-10" : ""}`}>
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-secondary">
        <History className="h-3.5 w-3.5" /> Archived products &amp; their history
      </div>
      {rows === null ? (
        <p className="flex items-center gap-2 text-sm text-text-tertiary"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-text-tertiary">No archived products in this category.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-xs">
            <thead>
              <tr className="text-text-tertiary">
                <th className="py-1 text-left font-medium">Product</th>
                <th className="py-1 text-right font-medium">Units sold</th>
                <th className="py-1 text-right font-medium">Revenue</th>
                <th className="py-1 text-left font-medium">Last sold</th>
                <th className="py-1 text-left font-medium">Last movement</th>
                <th className="py-1 text-right font-medium">Stock left</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border/60">
                  <td className="py-1.5 pr-2">
                    <div className="font-medium text-text-primary">{r.name}</div>
                    <div className="text-[11px] text-text-tertiary">
                      {r.brand ? `${r.brand} · ` : ""}{r.sku}
                      {r.variants.length > 1 ? ` · ${r.variants.length} variants` : ""}
                    </div>
                  </td>
                  <td className="py-1.5 text-right tnum">{formatNumber(r.units_sold, 2)}</td>
                  <td className="py-1.5 text-right tnum">{formatPKR(r.revenue)}</td>
                  <td className="py-1.5 text-text-secondary">{fmtDate(r.last_sold_at)}</td>
                  <td className="py-1.5 text-text-secondary">{fmtDate(r.last_movement_at)}</td>
                  <td className="py-1.5 text-right tnum">
                    {formatNumber(r.on_hand, 2)}
                    {r.on_hand > 0 && <span className="ml-1 text-[10px] text-text-tertiary">({formatPKR(r.stock_value)})</span>}
                  </td>
                  <td className="py-1.5 text-right">
                    <Button size="sm" variant="secondary" disabled={busyId === r.id} onClick={() => restore(r.id)}>
                      {busyId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArchiveRestore className="h-3.5 w-3.5" />}
                      Restore
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
