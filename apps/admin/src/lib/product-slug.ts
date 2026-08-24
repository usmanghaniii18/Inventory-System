/**
 * Storefront listing slug for a newly created product.
 *
 * `store_listings.slug` is UNIQUE NOT NULL, and the slugifier keeps only
 * [a-z0-9] — so a product named in Urdu or Arabic, or named with nothing but
 * punctuation or an emoji, slugifies to "". Combined with a SKU that does the
 * same, the FIRST such product would be created and every one after it rejected
 * on the unique constraint. That product then fails to create at all, which
 * means it never reaches ensureVariantBarcodes() and ends up with no barcode —
 * the item arrives at the till with nothing to scan.
 *
 * This lives in lib/ rather than in the products server action because every
 * export from a "use server" module must be an async function, and because a
 * plain module can be unit-tested directly.
 */

/** Lowercase, strip to [a-z0-9], collapse runs to single hyphens. */
export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/**
 * Never returns an empty string. A short random suffix is appended ONLY when
 * there is nothing printable to build from, so ordinary Latin-named products
 * keep exactly the slugs (and storefront URLs) they have today.
 */
export function productSlug(name: string, sku: string): string {
  const base = [slugify(name), slugify(sku)].filter(Boolean).join("-");
  return base || `item-${Math.random().toString(36).slice(2, 10)}`;
}
