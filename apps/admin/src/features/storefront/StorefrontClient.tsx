"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Store, Globe, EyeOff } from "lucide-react";
import { PageHeader } from "@hamza/shared/ui/PageHeader";
import { Card } from "@hamza/shared/ui/Card";
import { Input } from "@hamza/shared/ui/Input";
import { StatTile } from "@hamza/shared/ui/StatTile";
import { DataTable, type Column } from "@hamza/shared/ui/DataTable";
import { useToast } from "@hamza/shared/ui/Toast";
import { formatPKR } from "@hamza/shared/utils";
import { updateListing } from "./actions";

export interface ListingRow {
  id: string; product_id: string; name: string; sku: string;
  is_published: boolean; online_price: number; slug: string;
}

export function StorefrontClient({ rows }: { rows: ListingRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return rows.filter((r) => !t || r.name.toLowerCase().includes(t) || r.sku.toLowerCase().includes(t));
  }, [rows, q]);

  const published = rows.filter((r) => r.is_published).length;

  async function toggle(r: ListingRow) {
    setBusy(r.id);
    const res = await updateListing(r.id, { is_published: !r.is_published });
    setBusy(null);
    if (res?.error) { toast(res.error, "error"); return; }
    toast(!r.is_published ? "Published to storefront" : "Unpublished");
    router.refresh();
  }

  async function savePrice(r: ListingRow, value: string) {
    const price = Number(value);
    if (Number.isNaN(price) || price === r.online_price) return;
    const res = await updateListing(r.id, { online_price: price });
    if (res?.error) { toast(res.error, "error"); return; }
    toast("Price updated");
    router.refresh();
  }

  const columns: Column<ListingRow>[] = [
    {
      key: "name", header: "Product",
      cell: (r) => (
        <div>
          <div className="font-medium text-text-primary">{r.name}</div>
          <div className="text-xs text-text-tertiary">/{r.slug}</div>
        </div>
      ),
    },
    {
      key: "online_price", header: "Online price", align: "right",
      cell: (r) => (
        <Input
          type="number"
          defaultValue={r.online_price}
          onBlur={(e) => savePrice(r, e.target.value)}
          className="ml-auto h-8 w-28 text-right"
        />
      ),
    },
    {
      key: "is_published", header: "Status", align: "center",
      cell: (r) => (
        <button
          onClick={() => toggle(r)}
          disabled={busy === r.id}
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            r.is_published ? "bg-green-tile text-green-text" : "bg-surface-2 text-text-tertiary"
          }`}
        >
          {r.is_published ? <Globe className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          {r.is_published ? "Published" : "Hidden"}
        </button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Storefront Manager" subtitle="Control what customers see on your online store" />

      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Published" value={published} icon={Globe} accent="green" />
        <StatTile label="Hidden" value={rows.length - published} icon={EyeOff} accent="amber" />
        <StatTile label="Total Listings" value={rows.length} icon={Store} accent="blue" />
      </div>

      <Card className="mb-4 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search listings…" className="pl-9" />
        </div>
      </Card>

      <Card><DataTable columns={columns} rows={filtered} /></Card>
      <p className="mt-3 text-center text-xs text-text-tertiary">
        The customer storefront reads these published listings from the same database (product pages refresh at least every 30 seconds).
      </p>
    </div>
  );
}
