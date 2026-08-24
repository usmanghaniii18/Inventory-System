import type { Metadata } from "next";
import { ClipboardList } from "lucide-react";
import { createClient } from "@hamza/shared/supabase/server";
import { resolveRange } from "@hamza/shared/dates";
import { fetchAll, fetchAllByIds } from "@/lib/fetch-all";
import { PageHeader } from "@hamza/shared/ui/PageHeader";
import { Card } from "@hamza/shared/ui/Card";
import { EmptyState } from "@hamza/shared/ui/EmptyState";
import { FilterBar } from "@hamza/shared/ui/FilterBar";
import { ExportMenu } from "@hamza/shared/ui/ExportMenu";
import { OrdersClient, type OrderFull } from "@/features/orders/OrdersClient";

export const metadata: Metadata = { title: "Orders" };

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function OrdersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const range = resolveRange(one(sp.preset) || "this_year", one(sp.from), one(sp.to));
  const supabase = await createClient();

  // Opportunistically free stock from abandoned orders so the board is accurate
  // even between the scheduled (pg_cron) runs — run it in parallel with the
  // orders read instead of blocking on it first (it doesn't gate the list).
  // Paginated (not `.limit(300)`) — a wide range with more than 300 orders used
  // to silently truncate to the newest 300, so widening the range could show
  // FEWER orders (and the CSV export, built from this same array, inherited the
  // truncation).
  const [, orders] = await Promise.all([
    supabase.rpc("release_expired_reservations"),
    fetchAll<{
      id: string; order_no: string; customer_name: string; customer_phone: string; address: string | null;
      status: string; payment_type: string; subtotal: number; delivery_fee: number; total: number; created_at: string;
    }>((from, to) => supabase
      .from("orders")
      .select("id, order_no, customer_name, customer_phone, address, status, payment_type, subtotal, delivery_fee, total, created_at")
      .gte("created_at", range.from.toISOString())
      .lte("created_at", range.to.toISOString())
      .order("id").range(from, to)),
  ]);

  const all = orders;

  // line items for the loaded orders, with the product name embedded via the
  // FK join so there's no second round-trip (was an N+1: items → products).
  // Chunked + paginated (fetchAllByIds) rather than a single `.in()` — once
  // `orders` above is fully paginated, a wide range can hold hundreds of order
  // ids, which would blow past PostgREST's URL/header limit.
  const orderIds = all.map((o) => o.id);
  const items = orderIds.length
    ? await fetchAllByIds<{ order_id: string; qty: number; unit_price: number; line_total: number; products: { name: string } | { name: string }[] | null }>(
        orderIds,
        (chunk, from, to) => supabase.from("order_items")
          .select("order_id, qty, unit_price, line_total, products(name)")
          .in("order_id", chunk).order("id").range(from, to),
      )
    : [];
  const itemsByOrder = new Map<string, OrderFull["items"]>();
  for (const it of items) {
    const arr = itemsByOrder.get(it.order_id) ?? [];
    const prod = it.products as { name: string } | { name: string }[] | null;
    const title = Array.isArray(prod) ? prod[0]?.name : prod?.name;
    arr.push({ title: title ?? "Item", qty: Number(it.qty), unit_price: Number(it.unit_price), line_total: Number(it.line_total) });
    itemsByOrder.set(it.order_id, arr);
  }

  const full: OrderFull[] = all.map((o) => ({
    id: o.id,
    order_no: o.order_no,
    customer_name: o.customer_name,
    customer_phone: o.customer_phone,
    address: o.address,
    status: o.status,
    payment_type: o.payment_type,
    subtotal: Number(o.subtotal),
    delivery_fee: Number(o.delivery_fee),
    total: Number(o.total),
    created_at: o.created_at,
    items: itemsByOrder.get(o.id) ?? [],
  }));

  return (
    <div>
      <PageHeader
        title="Orders & Delivery"
        subtitle="Online orders flow here from the storefront — confirm, pack, ship and deliver"
        actions={
          <ExportMenu
            filename="orders"
            title={`Orders · ${range.label}`}
            columns={[
              { key: "order_no", header: "Order" }, { key: "customer", header: "Customer" },
              { key: "status", header: "Status" }, { key: "payment", header: "Payment" },
              { key: "total", header: "Total" }, { key: "date", header: "Date" },
            ]}
            rows={full.map((o) => ({
              order_no: o.order_no, customer: o.customer_name, status: o.status,
              payment: o.payment_type, total: o.total,
              date: new Date(o.created_at).toLocaleDateString("en-PK"),
            }))}
          />
        }
      />

      <FilterBar className="mb-4" />

      {full.length === 0 ? (
        <Card>
          <EmptyState
            icon={ClipboardList}
            title="No online orders in this period"
            description="When customers order from the storefront, orders appear here grouped by status — needs confirmation, ready to pack, in transit, delivered."
          />
        </Card>
      ) : (
        <OrdersClient orders={full} />
      )}
    </div>
  );
}
