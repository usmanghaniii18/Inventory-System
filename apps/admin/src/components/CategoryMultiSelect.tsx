"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@hamza/shared/utils";

export interface CategoryOption { id: string; name: string; parent_id: string | null }

/**
 * Checkbox dropdown for picking main categories and/or sub-categories
 * together. Selecting a main category is a rollup filter (its own products
 * PLUS every sub-category's) — see expandCategorySelection in lib/categories.
 * Shared by the Stock page and the Inventory Valuation report.
 */
export function CategoryMultiSelect({
  categories, selected, onChange, className, placeholder = "All categories",
}: {
  categories: CategoryOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const parents = categories.filter((c) => !c.parent_id);
  const childrenOf = new Map<string, CategoryOption[]>();
  for (const c of categories) if (c.parent_id) {
    const arr = childrenOf.get(c.parent_id) ?? [];
    arr.push(c);
    childrenOf.set(c.parent_id, arr);
  }

  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const label = selected.length === 0
    ? placeholder
    : selected.length === 1
      ? (categories.find((c) => c.id === selected[0])?.name ?? "1 selected")
      : `${selected.length} categories`;

  return (
    <div className={cn("relative", className)} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-10 w-full items-center justify-between rounded-lg border border-border bg-surface px-3 text-sm text-text-primary",
          "focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 max-h-80 w-64 overflow-y-auto rounded-lg border border-border bg-surface shadow-drawer">
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full border-b border-border px-3 py-2 text-left text-xs font-medium text-brand-600 hover:bg-surface-2"
            >
              Clear all
            </button>
          )}
          {parents.length === 0 ? (
            <p className="px-3 py-3 text-sm text-text-tertiary">No categories</p>
          ) : parents.map((p) => (
            <div key={p.id}>
              <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-surface-2">
                <input type="checkbox" checked={selected.includes(p.id)} onChange={() => toggle(p.id)} className="h-4 w-4 rounded border-border" />
                <span className="font-medium text-text-primary">{p.name}</span>
              </label>
              {(childrenOf.get(p.id) ?? []).map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-2 py-2 pl-9 pr-3 text-sm hover:bg-surface-2">
                  <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} className="h-4 w-4 rounded border-border" />
                  <span className="text-text-secondary">{c.name}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
