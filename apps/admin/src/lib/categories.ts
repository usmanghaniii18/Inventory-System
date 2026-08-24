export interface CategoryRef { id: string; parent_id: string | null }

/**
 * Expand a set of selected category ids so a selected MAIN category also
 * matches every one of its sub-categories (recursive, in case nesting ever
 * goes deeper than the current one-level constraint). Used wherever a
 * category filter needs to roll up sub-category products into the parent.
 */
export function expandCategorySelection(selectedIds: string[], categories: CategoryRef[]): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const c of categories) if (c.parent_id) childrenOf.set(c.parent_id, [...(childrenOf.get(c.parent_id) ?? []), c.id]);
  const out = new Set<string>();
  const add = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    for (const child of childrenOf.get(id) ?? []) add(child);
  };
  for (const id of selectedIds) add(id);
  return out;
}
