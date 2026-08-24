"use client";

import { useEffect, useRef, useState } from "react";
import {
  Banknote, NotebookPen, Smartphone,
  X, Plus, Trash2, Loader2, Check,
} from "lucide-react";
import { Button } from "@hamza/shared/ui/Button";
import { Input } from "@hamza/shared/ui/Input";
import { Select } from "@hamza/shared/ui/Select";
import { CustomerSelect } from "./CustomerSelect";
import { useToast } from "@hamza/shared/ui/Toast";
import { cn, formatPKR } from "@hamza/shared/utils";
import { quickAddCustomer, type PayMethod, type PaymentInput } from "./actions";

const METHODS: { m: PayMethod; label: string; Icon: typeof Banknote }[] = [
  { m: "CASH", label: "Cash", Icon: Banknote },
  { m: "EASYPAISA", label: "Easypaisa", Icon: Smartphone },
  { m: "JAZZCASH", label: "JazzCash", Icon: Smartphone },
  { m: "UDHAAR", label: "Udhaar", Icon: NotebookPen },
];
const LABEL: Record<PayMethod, string> = {
  CASH: "Cash", JAZZCASH: "JazzCash", EASYPAISA: "Easypaisa", UDHAAR: "Udhaar", COD: "COD",
};
const round2 = (n: number) => Math.round(n * 100) / 100;

type Customer = { id: string; name: string; phone: string | null };

export function PaymentSheet({
  open, total, customers, customerId, customerName, setCustomer, onClose, onConfirm, processing,
}: {
  open: boolean;
  total: number;
  customers: Customer[];
  customerId: string;
  customerName: string;
  setCustomer: (name: string, id: string) => void;
  onClose: () => void;
  onConfirm: (payments: PaymentInput[], change: number) => void;
  processing: boolean;
}) {
  const toast = useToast();
  const [lines, setLines] = useState<PaymentInput[]>([{ method: "CASH", amount: total }]);
  const [split, setSplit] = useState(false);
  const [tendered, setTendered] = useState(String(total));
  const [extra, setExtra] = useState<Customer[]>([]);

  useEffect(() => {
    if (open) {
      setLines([{ method: "CASH", amount: round2(total) }]);
      setSplit(false);
      setTendered(String(round2(total)));
    }
  }, [open, total]);

  // `confirm()` is declared further down (it closes over values computed after
  // the `if (!open) return null` guard), so the keydown listener reaches it
  // through this ref. The useRef MUST live up here with the other hooks: React
  // requires every hook to run on every render, and this component returns
  // early when it is closed. Declaring it next to `confirm()` meant the closed
  // sheet ran 6 hooks and the open sheet ran 7, which threw
  // "Rendered more hooks than during the previous render" the moment Charge was
  // pressed. The assignment below the guard is a plain assignment, not a hook,
  // so it is fine where it is.
  const confirmRef = useRef<() => void>(() => {});

  // Phase C — Enter confirms the payment from anywhere in the sheet (including
  // the amount fields), Esc backs out. F4 → Enter now completes a bill.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (processing) return;
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); confirmRef.current(); }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, processing]);

  if (!open) return null;

  const paid = round2(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));
  const remaining = round2(total - paid);
  const cashApplied = round2(lines.filter((l) => l.method === "CASH").reduce((s, l) => s + (Number(l.amount) || 0), 0));
  const change = Math.max(0, round2((Number(tendered) || 0) - cashApplied));
  const hasUdhaar = lines.some((l) => l.method === "UDHAAR");
  const allCustomers = [...extra, ...customers];

  function pickSingle(m: PayMethod) {
    setLines([{ method: m, amount: round2(total) }]);
    setSplit(false);
    if (m === "CASH") setTendered(String(round2(total)));
  }
  function addSplit() {
    setSplit(true);
    setLines((ls) => [...ls, { method: "EASYPAISA", amount: Math.max(0, remaining) }]);
  }
  function setLineMethod(i: number, m: PayMethod) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, method: m } : l)));
  }
  function setLineAmount(i: number, v: string) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, amount: Number(v) || 0 } : l)));
  }
  function removeLine(i: number) {
    setLines((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : ls));
  }

  // quick-tender suggestions for cash (exact + next round notes)
  const notes = [cashApplied, Math.ceil(cashApplied / 100) * 100, Math.ceil(cashApplied / 500) * 500, 1000, 5000]
    .map(round2)
    .filter((n, i, a) => n >= cashApplied && a.indexOf(n) === i)
    .slice(0, 4);

  function confirm() {
    if (Math.abs(remaining) > 0.5) return toast(`Rs ${Math.abs(remaining).toFixed(0)} ${remaining > 0 ? "still unpaid" : "overpaid — reduce a line"}`, "error");
    if (hasUdhaar && !customerId) return toast("Attach a customer for udhaar", "error");
    onConfirm(lines.filter((l) => Number(l.amount) > 0), change);
  }
  confirmRef.current = confirm;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/45 animate-fade-in" onClick={processing ? undefined : onClose} />
      <div className="relative z-10 flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface shadow-drawer animate-fade-in sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="font-heading text-lg font-semibold text-text-primary">Payment</span>
          <div className="flex items-center gap-3">
            <span className="tnum font-heading text-lg font-bold text-text-primary">{formatPKR(total)}</span>
            <button onClick={onClose} disabled={processing} className="rounded-lg p-1.5 text-text-tertiary hover:bg-surface-2"><X className="h-5 w-5" /></button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 scrollbar-thin">
          {/* customer — one search-or-add field, walk-in by default */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-text-secondary">Customer {hasUdhaar && <span className="text-coral-text">· required for udhaar</span>}</span>
            </div>
            <CustomerSelect
              customers={allCustomers}
              name={customerName}
              customerId={customerId}
              onPick={setCustomer}
              onCreate={async (name, phone) => {
                const res = await quickAddCustomer(name, phone);
                if (res && "error" in res && res.error) { toast(res.error, "error"); return null; }
                if (res && "customer" in res && res.customer) {
                  setExtra((x) => [res.customer, ...x]);
                  toast("Customer added");
                  return res.customer;
                }
                return null;
              }}
            />
          </div>

          {/* method chips */}
          <div className="grid grid-cols-4 gap-2">
            {METHODS.map(({ m, label, Icon }) => {
              const active = !split && lines.length === 1 && lines[0].method === m;
              return (
                <button
                  key={m}
                  onClick={() => pickSingle(m)}
                  className={cn("flex flex-col items-center gap-1 rounded-xl border px-1 py-2.5 text-xs font-medium transition-colors",
                    active ? "border-brand-500 bg-brand-50 text-brand-700" : "border-border bg-surface text-text-secondary hover:bg-surface-2")}
                >
                  <Icon className="h-4 w-4" /> {label}
                </button>
              );
            })}
            <button onClick={addSplit} className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-border px-1 py-2.5 text-xs font-medium text-text-secondary hover:bg-surface-2">
              <Plus className="h-4 w-4" /> Split
            </button>
          </div>

          {/* split lines (editable amounts) */}
          {split && (
            <div className="space-y-2 rounded-xl border border-border p-2">
              {lines.map((l, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Select value={l.method} onChange={(e) => setLineMethod(i, e.target.value as PayMethod)} className="h-9 flex-1">
                    {METHODS.map(({ m, label }) => <option key={m} value={m}>{label}</option>)}
                  </Select>
                  <Input type="number" value={String(l.amount)} onChange={(e) => setLineAmount(i, e.target.value)} className="h-9 w-28 text-right" />
                  <button onClick={() => removeLine(i)} className="rounded-md p-1.5 text-text-tertiary hover:text-coral-text"><Trash2 className="h-4 w-4" /></button>
                </div>
              ))}
              <button onClick={() => setLines((ls) => [...ls, { method: "CASH", amount: Math.max(0, remaining) }])} className="text-xs font-medium text-brand-600 hover:underline">+ Add payment</button>
            </div>
          )}

          {/* cash received + change */}
          {cashApplied > 0 && (
            <div className="rounded-xl border border-border p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm text-text-secondary">Cash received</span>
                <Input type="number" value={tendered} onChange={(e) => setTendered(e.target.value)} className="h-9 w-32 text-right" />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {notes.map((n) => (
                  <button key={n} onClick={() => setTendered(String(n))}
                    className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface-2">
                    {n === cashApplied ? "Exact" : formatPKR(n)}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                <span className="text-sm font-medium text-text-primary">Change due</span>
                <span className="tnum font-heading text-lg font-bold text-green-text">{formatPKR(change)}</span>
              </div>
            </div>
          )}
        </div>

        {/* footer */}
        <div className="border-t border-border p-4">
          {split && (
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="text-text-secondary">Remaining</span>
              <span className={cn("tnum font-semibold", Math.abs(remaining) < 0.5 ? "text-green-text" : "text-coral-text")}>{formatPKR(remaining)}</span>
            </div>
          )}
          <Button onClick={confirm} disabled={processing} className="w-full py-3 text-base">
            {processing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />}
            Charge {formatPKR(total)}
            {lines.length > 0 && <span className="opacity-80">· {lines.map((l) => LABEL[l.method]).join(" + ")}</span>}
            <kbd className="ml-1 rounded border border-white/40 px-1 text-[10px] font-normal opacity-80">Enter</kbd>
          </Button>
        </div>
      </div>
    </div>
  );
}
