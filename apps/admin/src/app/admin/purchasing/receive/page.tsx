import type { Metadata } from "next";
import { createClient } from "@hamza/shared/supabase/server";
import { getVariantOptions } from "@/lib/catalog";
import { fetchAllByIds } from "@/lib/fetch-all";
import { ReceiveClient, type OpenPO } from "@/features/purchasing/ReceiveClient";

export const metadata: Metadata = { title: "Receive Stock" };

export default async function ReceivePage() {
  const supabase = await createClient();
  const [variants, { data: suppliers }, { data: pos }, { data: locations }] = await Promise.all([
    getVariantOptions(supabase),
    supabase.from("suppliers").select("id, name").eq("active", true).order("name"),
    supabase.from("purchase_orders").select("id, po_no, supplier_id, status, expected_at").in("status", ["SENT", "PARTIAL"]).order("created_at", { ascending: false }),
    supabase.from("locations").select("code, name").eq("type", "PHYSICAL").order("code"),
  ]);

  // Scoped to open POs' ids (chunked + paginated) rather than a plain unbounded
  // .select() over the whole purchase_order_items table — that used to silently
  // cap at 1000 rows and drop open-PO line items from the Receive Stock screen
  // as purchasing history grew.
  const poIds = (pos ?? []).map((p) => p.id);
  const poItems = poIds.length
    ? await fetchAllByIds<{ id: string; po_id: string; variant_id: string; product_id: string; qty: number; received_qty: number; unit_cost: number }>(
        poIds,
        (chunk, from, to) => supabase.from("purchase_order_items")
          .select("id, po_id, variant_id, product_id, qty, received_qty, unit_cost")
          .in("po_id", chunk).order("id").range(from, to),
      )
    : [];

  const itemsByPo = new Map<string, OpenPO["items"]>();
  for (const it of poItems) {
    const arr = itemsByPo.get(it.po_id) ?? [];
    arr.push({
      id: it.id, variant_id: it.variant_id, product_id: it.product_id,
      qty: Number(it.qty), received_qty: Number(it.received_qty), unit_cost: Number(it.unit_cost),
    });
    itemsByPo.set(it.po_id, arr);
  }

  const openPOs: OpenPO[] = (pos ?? []).map((p) => ({
    id: p.id, po_no: p.po_no, supplier_id: p.supplier_id, status: p.status,
    expected_at: p.expected_at, items: itemsByPo.get(p.id) ?? [],
  }));

  return (
    <ReceiveClient
      variants={variants}
      suppliers={(suppliers ?? []).map((s) => ({ id: s.id, name: s.name }))}
      openPOs={openPOs}
      locations={(locations ?? []).map((l) => ({ code: l.code, name: l.name }))}
    />
  );
}
