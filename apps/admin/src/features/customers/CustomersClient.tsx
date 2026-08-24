"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Plus, Search, Users, Loader2, Wallet, BookUser,
  ChevronDown, ChevronRight, Trash2, Pencil, Check, AlertTriangle,
} from "lucide-react";
import { PageHeader } from "@hamza/shared/ui/PageHeader";
import { Card } from "@hamza/shared/ui/Card";
import { Button } from "@hamza/shared/ui/Button";
import { Input, Label, FieldError } from "@hamza/shared/ui/Input";
import { Drawer } from "@hamza/shared/ui/Drawer";
import { DataTable, type Column } from "@hamza/shared/ui/DataTable";
import { StatTile } from "@hamza/shared/ui/StatTile";
import { Avatar } from "@hamza/shared/ui/Avatar";
import { StatusPill } from "@hamza/shared/ui/StatusPill";
import { useToast } from "@hamza/shared/ui/Toast";
import { ExportMenu } from "@hamza/shared/ui/ExportMenu";
import { formatPKR } from "@hamza/shared/utils";
import { createCustomer, recordPayment } from "./actions";
import {
  getCustomerUdhaarHistory, deleteUdhaarEntry, renameCustomer,
  clearCustomerUdhaar, deleteCustomer, type UdhaarHistory,
} from "./udhaar";

export interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  credit_limit: number;
  credit_balance: number;
}

export function CustomersClient({ rows }: { rows: CustomerRow[] }) {
  const router = useRouter();
  const sp = useSearchParams();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [ledgerOf, setLedgerOf] = useState<CustomerRow | null>(null);

  // Deep link from the dashboard "Top Customers" rows: ?customer=<id> opens that
  // customer's khata (where a repayment can be recorded), then clears the param.
  const customerParam = sp.get("customer");
  useEffect(() => {
    if (!customerParam) return;
    const match = rows.find((r) => r.id === customerParam);
    if (match) setLedgerOf(match);
    router.replace("/admin/customers");
  }, [customerParam, rows, router]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return rows.filter((r) => !t || r.name.toLowerCase().includes(t) || (r.phone ?? "").includes(t));
  }, [rows, q]);

  const totalOutstanding = rows.reduce((s, r) => s + Math.max(r.credit_balance, 0), 0);
  const debtors = rows.filter((r) => r.credit_balance > 0).length;

  const columns: Column<CustomerRow>[] = [
    {
      key: "name", header: "Customer",
      cell: (r) => (
        <div className="flex items-center gap-3">
          <Avatar name={r.name} size={34} />
          <div>
            <div className="font-medium text-text-primary">{r.name}</div>
            <div className="text-xs text-text-tertiary">{r.phone ?? "—"}</div>
          </div>
        </div>
      ),
    },
    { key: "credit_limit", header: "Limit", align: "right", cell: (r) => <span className="tnum">{formatPKR(r.credit_limit)}</span> },
    {
      key: "credit_balance", header: "Owes (udhaar)", align: "right",
      cell: (r) => <span className={`tnum font-medium ${r.credit_balance > 0 ? "text-coral-text" : "text-text-primary"}`}>{formatPKR(r.credit_balance)}</span>,
    },
    {
      key: "status", header: "Status",
      cell: (r) =>
        r.credit_balance <= 0 ? <StatusPill tone="green">Clear</StatusPill>
        : r.credit_limit > 0 && r.credit_balance > r.credit_limit ? <StatusPill tone="coral">Over limit</StatusPill>
        : <StatusPill tone="amber">Outstanding</StatusPill>,
    },
    {
      key: "actions", header: "", align: "right",
      cell: (r) => <Button size="sm" variant="secondary" onClick={() => setLedgerOf(r)}>Khata</Button>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Customers"
        subtitle={`${rows.length} customers · full udhaar history per customer`}
        actions={
          <div className="flex gap-2">
            <ExportMenu
              filename="customers"
              title="Customers & udhaar"
              columns={[
                { key: "name", header: "Customer" }, { key: "phone", header: "Phone" },
                { key: "credit_limit", header: "Credit limit" }, { key: "credit_balance", header: "Owes (udhaar)" },
              ]}
              rows={filtered.map((r) => ({ name: r.name, phone: r.phone ?? "", credit_limit: r.credit_limit, credit_balance: r.credit_balance }))}
            />
            <Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add Customer</Button>
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Total Outstanding" value={formatPKR(totalOutstanding, { compact: true })} fullValue={formatPKR(totalOutstanding)} icon={Wallet} accent="coral" sensitive />
        <StatTile label="Customers with Udhaar" value={debtors} icon={BookUser} accent="amber" />
        <StatTile label="Total Customers" value={rows.length} icon={Users} accent="blue" />
      </div>

      <Card className="mb-4 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or phone…" className="pl-9" />
        </div>
      </Card>

      <Card><DataTable columns={columns} rows={filtered} /></Card>

      <AddCustomerDrawer open={addOpen} onClose={() => setAddOpen(false)}
        onSaved={() => { setAddOpen(false); toast("Customer added"); router.refresh(); }}
        onError={(m) => toast(m, "error")} />

      <LedgerDrawer customer={ledgerOf} onClose={() => setLedgerOf(null)}
        onPaid={() => { toast("Payment recorded"); router.refresh(); }}
        onError={(m) => toast(m, "error")} />
    </div>
  );
}

function AddCustomerDrawer({ open, onClose, onSaved, onError }: {
  open: boolean; onClose: () => void; onSaved: () => void; onError: (m: string) => void;
}) {
  const [form, setForm] = useState({ name: "", phone: "", address: "", credit_limit: "0" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string>();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(undefined);
    if (!form.name) { setErr("Name is required."); return; }
    setSaving(true);
    const res = await createCustomer({ name: form.name, phone: form.phone, address: form.address, credit_limit: Number(form.credit_limit) || 0 });
    setSaving(false);
    if (res?.error) { setErr(res.error); onError(res.error); return; }
    setForm({ name: "", phone: "", address: "", credit_limit: "0" }); onSaved();
  }

  return (
    <Drawer open={open} onClose={onClose} title="Add Customer"
      footer={<div className="flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
        <Button form="add-cust" type="submit" className="flex-1" disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Save</Button>
      </div>}>
      <form id="add-cust" onSubmit={submit} className="space-y-4">
        <div><Label>Name *</Label><Input value={form.name} onChange={set("name")} placeholder="Customer name" /></div>
        <div><Label>Phone</Label><Input value={form.phone} onChange={set("phone")} placeholder="03xx-xxxxxxx" /></div>
        <div><Label>Address</Label><Input value={form.address} onChange={set("address")} placeholder="Optional" /></div>
        <div><Label>Udhaar limit (₨)</Label><Input type="number" value={form.credit_limit} onChange={set("credit_limit")} /><p className="mt-1 text-xs text-text-tertiary">Most this customer is allowed to owe on credit. 0 = cash only.</p></div>
        <FieldError message={err} />
      </form>
    </Drawer>
  );
}

function LedgerDrawer({ customer, onClose, onPaid, onError }: {
  customer: CustomerRow | null; onClose: () => void; onPaid: () => void; onError: (m: string) => void;
}) {
  const [history, setHistory] = useState<UdhaarHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [confirm, setConfirm] = useState<null | { mode: "clear" | "delete" }>(null);
  const [confirmText, setConfirmText] = useState("");

  const load = useCallback(async () => {
    if (!customer) return;
    setLoading(true);
    const res = await getCustomerUdhaarHistory(customer.id);
    setLoading(false);
    if ("error" in res) { onError(res.error); return; }
    setHistory(res);
  }, [customer, onError]);

  useEffect(() => {
    setHistory(null); setOpen(new Set()); setEditingName(false); setConfirm(null); setConfirmText("");
    if (customer) { setNameDraft(customer.name); void load(); }
  }, [customer, load]);

  if (!customer) return null;

  const balance = history?.customer.credit_balance ?? customer.credit_balance;
  const entries = history?.entries ?? [];
  const charges = entries.filter((e) => e.kind === "CHARGE");

  const toggle = (id: string) =>
    setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    if (!customer || !amount) return;
    setSaving(true);
    const res = await recordPayment({ customer_id: customer.id, amount: Number(amount) });
    setSaving(false);
    if (res?.error) { onError(res.error); return; }
    setAmount("");
    await load();
    onPaid();
  }

  async function removeEntry(id: string) {
    setBusyId(id);
    const res = await deleteUdhaarEntry(id);
    setBusyId(null);
    if ("error" in res) { onError(res.error); return; }
    await load();
    onPaid();
  }

  async function saveName() {
    if (!customer) return;
    const res = await renameCustomer(customer.id, nameDraft);
    if ("error" in res) { onError(res.error); return; }
    setEditingName(false);
    await load();
    onPaid();
  }

  async function runConfirm() {
    if (!customer || !confirm) return;
    setSaving(true);
    const res = confirm.mode === "clear"
      ? await clearCustomerUdhaar(customer.id, confirmText)
      : await deleteCustomer(customer.id, confirmText);
    setSaving(false);
    if ("error" in res) { onError(res.error); return; }
    setConfirm(null); setConfirmText("");
    onPaid();
    onClose();
  }

  return (
    <Drawer open={!!customer} onClose={onClose} width="max-w-2xl" title={`Khata — ${history?.customer.name ?? customer.name}`}>
      <div className="space-y-5">
        {/* balance + record repayment */}
        <div className="rounded-xl border border-border bg-surface-2 p-4">
          <div className="text-xs text-text-tertiary">Current balance (owes us)</div>
          <div className={`tnum font-heading text-2xl font-bold ${balance > 0 ? "text-coral-text" : "text-text-primary"}`}>
            {formatPKR(balance)}
          </div>
          <div className="mt-1 text-xs text-text-tertiary">
            {charges.length} credit purchase{charges.length !== 1 ? "s" : ""} · {entries.length - charges.length} repayment{entries.length - charges.length !== 1 ? "s" : ""}
          </div>
        </div>

        {/* rename */}
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label>Customer name</Label>
            {editingName ? (
              <Input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") saveName(); if (e.key === "Escape") setEditingName(false); }} />
            ) : (
              <div className="flex h-10 items-center rounded-lg border border-border bg-surface px-3 text-sm text-text-primary">
                {history?.customer.name ?? customer.name}
              </div>
            )}
          </div>
          {editingName ? (
            <>
              <Button size="sm" onClick={saveName}><Check className="h-4 w-4" /> Save</Button>
              <Button size="sm" variant="secondary" onClick={() => { setEditingName(false); setNameDraft(history?.customer.name ?? customer.name); }}>Cancel</Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setEditingName(true)}><Pencil className="h-4 w-4" /> Rename</Button>
          )}
        </div>

        <form onSubmit={pay} className="flex items-end gap-2">
          <div className="flex-1">
            <Label>Record repayment (₨)</Label>
            <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </div>
          <Button type="submit" disabled={saving || !amount}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Receive</Button>
        </form>

        {/* dated itemised history */}
        <div>
          <h4 className="mb-2 text-sm font-semibold text-text-primary">History</h4>
          {loading ? (
            <p className="text-sm text-text-tertiary">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-text-tertiary">No transactions yet.</p>
          ) : (
            <div className="space-y-2">
              {entries.map((e) => {
                const id = e.ledger_id ?? `sale:${e.sale_id}`;
                const isOpen = open.has(id);
                const isCharge = e.kind === "CHARGE";
                return (
                  <div key={id} className="overflow-hidden rounded-xl border border-border">
                    <div className="flex items-center gap-2 px-3 py-2">
                      <button
                        type="button"
                        onClick={() => isCharge && e.items.length > 0 && toggle(id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        disabled={!isCharge || e.items.length === 0}
                      >
                        {isCharge && e.items.length > 0 && (
                          isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-text-tertiary" /> : <ChevronRight className="h-4 w-4 shrink-0 text-text-tertiary" />
                        )}
                        <StatusPill tone={isCharge ? "amber" : "green"}>{isCharge ? "CREDIT" : "PAID"}</StatusPill>
                        <div className="min-w-0">
                          <div className="truncate text-sm text-text-primary">
                            {new Date(e.date).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" })}
                          </div>
                          <div className="truncate text-[11px] text-text-tertiary">
                            {e.receipt_no ? `${e.receipt_no}` : e.reference ?? "—"}
                            {isCharge && e.items.length > 0 ? ` · ${e.items.length} item${e.items.length !== 1 ? "s" : ""}` : ""}
                            {e.orphan ? " · not on ledger" : ""}
                          </div>
                        </div>
                      </button>
                      <div className="text-right">
                        <div className={`tnum text-sm font-semibold ${isCharge ? "text-coral-text" : "text-green-text"}`}>
                          {isCharge ? "+" : "−"}{formatPKR(e.amount)}
                        </div>
                        {!e.orphan && <div className="text-[11px] text-text-tertiary">bal {formatPKR(e.balance_after)}</div>}
                      </div>
                      {e.ledger_id && (
                        <button
                          type="button"
                          title={isCharge ? "Remove this credit from the khata (the sale itself is kept)" : "Undo this repayment"}
                          onClick={() => removeEntry(e.ledger_id!)}
                          disabled={busyId === e.ledger_id}
                          className="rounded-md p-1.5 text-text-tertiary hover:bg-coral-tile hover:text-coral-text disabled:opacity-40"
                        >
                          {busyId === e.ledger_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                        </button>
                      )}
                    </div>

                    {isOpen && e.items.length > 0 && (
                      <div className="border-t border-border bg-surface-2/40 px-3 py-2">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-text-tertiary">
                              <th className="py-1 text-left font-medium">Product</th>
                              <th className="py-1 text-right font-medium">Qty</th>
                              <th className="py-1 text-right font-medium">Price</th>
                              <th className="py-1 text-right font-medium">Disc</th>
                              <th className="py-1 text-right font-medium">Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {e.items.map((it, i) => (
                              <tr key={i} className="border-t border-border/50">
                                <td className="py-1 pr-2 text-text-primary">{it.name}{it.label ? ` (${it.label})` : ""}</td>
                                <td className="py-1 text-right tnum">{it.qty}{it.unit ? ` ${it.unit}` : ""}</td>
                                <td className="py-1 text-right tnum">{formatPKR(it.unit_price)}</td>
                                <td className="py-1 text-right tnum">{it.discount > 0 ? `−${formatPKR(it.discount)}` : "—"}</td>
                                <td className="py-1 text-right tnum font-medium text-text-primary">{formatPKR(it.line_total)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="mt-1.5 flex justify-end gap-4 border-t border-border pt-1.5 text-xs">
                          <span className="text-text-tertiary">Subtotal <span className="tnum text-text-primary">{formatPKR(e.bill_subtotal)}</span></span>
                          {e.bill_discount > 0 && <span className="text-text-tertiary">Bill discount <span className="tnum text-text-primary">−{formatPKR(e.bill_discount)}</span></span>}
                          <span className="font-semibold text-text-primary">Invoice total <span className="tnum">{formatPKR(e.bill_total)}</span></span>
                        </div>
                        {Math.abs(e.bill_total - e.amount) > 0.5 && (
                          <p className="mt-1 text-[11px] text-text-tertiary">
                            {formatPKR(e.amount)} of this bill went on the khata; the rest was paid at the till.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* destructive actions */}
        <div className="rounded-xl border border-coral-icon/30 bg-coral-tile/30 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-coral-text">
            <AlertTriangle className="h-4 w-4" /> Danger zone
          </div>
          {confirm ? (
            <div className="space-y-2">
              <p className="text-xs text-text-secondary">
                {confirm.mode === "clear"
                  ? "This deletes EVERY khata entry for this customer and resets their balance to zero. Their sales, stock and reports are not affected. This cannot be undone."
                  : "This permanently deletes the customer record. Only possible if they have no sales history."}
              </p>
              <Label>Type “{history?.customer.name ?? customer.name}” to confirm</Label>
              <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={history?.customer.name ?? customer.name} />
              <div className="flex gap-2">
                <Button size="sm" variant="danger" onClick={runConfirm} disabled={saving || !confirmText.trim()}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {confirm.mode === "clear" ? "Clear khata" : "Delete customer"}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => { setConfirm(null); setConfirmText(""); }}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => setConfirm({ mode: "clear" })}>Clear udhaar record…</Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirm({ mode: "delete" })}>Delete customer…</Button>
            </div>
          )}
        </div>
      </div>
    </Drawer>
  );
}
