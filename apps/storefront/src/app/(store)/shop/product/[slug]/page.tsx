import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getProductBySlug, getProductVariants, getRelated } from "@/lib/storefront";
import { ProductGallery } from "@/components/store/ProductGallery";
import { ProductCard } from "@/components/store/ProductCard";
import { AddToBag } from "@/components/store/AddToBag";
import { WishlistButton } from "@/components/store/WishlistButton";

// This page reads via the service client (no cookies()/headers()/searchParams),
// so Next.js would otherwise treat it as static and cache it indefinitely after
// the first visit — a POS sale that drops stock to 0 wouldn't be reflected in
// the "In stock"/availability shown here until the next deploy. Revalidate
// every 30s so stock/availability never goes stale for more than that.
export const revalidate = 30;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const p = await getProductBySlug(slug);
  if (!p) return { title: "Not found" };
  return {
    title: p.title,
    description: p.description ?? `Buy ${p.title} at our store.`,
    openGraph: { title: p.title, description: p.description ?? undefined },
  };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) notFound();

  const [variants, related] = await Promise.all([
    getProductVariants(product.product_id),
    getRelated(product.category_name, slug, 4),
  ]);

  const gallery = product.images.length ? product.images : [product.image_url].filter(Boolean) as string[];

  return (
    <div className="mx-auto max-w-7xl px-5 py-8 lg:px-10">
      {/* breadcrumb */}
      <nav className="mb-6 flex items-center gap-2 text-xs text-store-muted">
        <Link href="/shop" className="hover:text-store-ink">Home</Link>
        <span>/</span>
        {product.category_name && (
          <>
            <Link href={`/shop?category=${encodeURIComponent(product.category_name)}`} className="hover:text-store-ink">{product.category_name}</Link>
            <span>/</span>
          </>
        )}
        <span className="text-store-charcoal">{product.title}</span>
      </nav>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-16">
        {/* media */}
        <ProductGallery images={gallery} title={product.title} slug={product.slug} />

        {/* info (sticky) */}
        <div className="lg:py-4">
          <div className="lg:sticky lg:top-28">
            {product.category_name && <p className="text-[11px] uppercase tracking-[0.18em] text-store-muted">{product.category_name}</p>}
            <h1 className="mt-2 font-serif text-4xl leading-tight text-store-ink">{product.title}</h1>
            {product.brand && <p className="mt-1 text-sm text-store-muted">by {product.brand}</p>}

            <div className="my-7 h-px bg-store-line" />

            <AddToBag product={product} variants={variants} />

            <div className="mt-5">
              <WishlistButton
                variant="inline"
                product={{ slug: product.slug, title: product.title, price: product.price, image: gallery[0] ?? null, category: product.category_name }}
              />
            </div>

            <div className="my-7 h-px bg-store-line" />

            {/* details */}
            <dl className="space-y-3 text-sm">
              <Row label="Sold by" value={product.is_variable_weight ? "Weight" : `Per ${product.base_unit}`} />
              {product.brand && <Row label="Brand" value={product.brand} />}
              <Row label="Availability" value={product.available > 0 ? "In stock" : "Out of stock"} />
            </dl>

            {product.description && (
              <div className="mt-7">
                <h3 className="mb-2 text-[11px] font-medium uppercase tracking-[0.15em] text-store-ink">Description</h3>
                <p className="text-sm leading-relaxed text-store-muted">{product.description}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* related */}
      {related.length > 0 && (
        <section className="mt-24">
          <h2 className="mb-8 text-center font-serif text-2xl text-store-ink">You may also like</h2>
          <div className="grid grid-cols-2 gap-x-5 gap-y-10 sm:grid-cols-4">
            {related.map((r) => <ProductCard key={r.product_id} p={r} />)}
          </div>
        </section>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-store-line/60 pb-2.5">
      <dt className="text-store-muted">{label}</dt>
      <dd className="text-store-charcoal">{value}</dd>
    </div>
  );
}
