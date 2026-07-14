import type { Metadata } from "next";
import { createClient } from "@hamza/shared/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import { CategoriesClient, type CategoryNode } from "@/features/categories/CategoriesClient";

export const metadata: Metadata = { title: "Categories" };

export default async function CategoriesPage() {
  const supabase = await createClient();
  const [{ data: cats }, prods] = await Promise.all([
    supabase.from("categories").select("id, name, parent_id, sort").order("sort").order("name"),
    // Paginated: a plain `.select("category_id")` silently caps at PostgREST's
    // 1000-row default, undercounting every category once the catalogue grows
    // past that (the same truncation bug fetchAll exists to prevent elsewhere).
    fetchAll<{ category_id: string | null }>((from, to) =>
      supabase.from("products").select("category_id").order("id").range(from, to)),
  ]);

  const direct = new Map<string, number>();
  for (const p of prods) if (p.category_id) direct.set(p.category_id, (direct.get(p.category_id) ?? 0) + 1);

  // Roll up: a category's count = its own direct products PLUS every
  // descendant sub-category's products (recursive, in case nesting ever goes
  // deeper than one level).
  const childrenOf = new Map<string, string[]>();
  for (const c of cats ?? []) if (c.parent_id) childrenOf.set(c.parent_id, [...(childrenOf.get(c.parent_id) ?? []), c.id]);
  const rollupCache = new Map<string, number>();
  function rollupCount(id: string): number {
    const cached = rollupCache.get(id);
    if (cached !== undefined) return cached;
    let total = direct.get(id) ?? 0;
    for (const childId of childrenOf.get(id) ?? []) total += rollupCount(childId);
    rollupCache.set(id, total);
    return total;
  }

  const nodes: CategoryNode[] = ((cats ?? []) as { id: string; name: string; parent_id: string | null }[])
    .map((c) => ({ id: c.id, name: c.name, parent_id: c.parent_id, product_count: rollupCount(c.id) }));

  return <CategoriesClient categories={nodes} />;
}
