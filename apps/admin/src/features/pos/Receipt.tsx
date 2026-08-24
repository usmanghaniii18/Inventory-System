"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Printer, Plus, Loader2 } from "lucide-react";
import { Button } from "@hamza/shared/ui/Button";
import { useToast } from "@hamza/shared/ui/Toast";
import { type ReceiptData } from "@/lib/receipt";
import { receiptHtml, printReceiptHtml, isPrintableReceipt } from "@/lib/receipt-html";

/**
 * Post-sale receipt. The preview and the Print action render the SAME 80mm
 * thermal invoice (one template — lib/receipt-html.ts): the preview is a passive
 * HTML render inside an <iframe>, Print opens the identical document in a pop-up
 * and calls window.print(). All client-side — no server PDF generation.
 */
export function Receipt({
  data,
  onClose,
}: {
  data: ReceiptData | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const [printing, setPrinting] = useState(false);

  // Render the invoice once per sale as a passive preview (no auto-print script);
  // the same template backs the Print action below.
  const previewHtml = useMemo(() => (data ? receiptHtml(data, { autoPrint: false }) : null), [data]);

  function printPdf() {
    // Same guard as the F9 shortcut — this button is also reachable by Enter
    // while the dialog is open, so it must be equally unable to throw.
    if (!isPrintableReceipt(data)) {
      toast("Nothing to print yet", "error");
      return;
    }
    setPrinting(true);
    try {
      // Print a compact 80mm thermal receipt (HTML + @page size) — not an A4 PDF.
      printReceiptHtml(data);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not open the receipt for printing", "error");
    } finally {
      setPrinting(false);
    }
  }

  // Phase C — with the receipt up, Enter prints straight away (the Print button
  // is focused on open) and Esc starts the next sale. Together with F4 → Enter
  // in the payment sheet that makes a full bill+print two Enter presses, no
  // menu walking. F9 / Ctrl+P still work here because PosClient listens on
  // window and this modal doesn't swallow them.
  const printRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!data) return;
    const t = setTimeout(() => printRef.current?.focus(), 60);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); printPdf(); }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("keydown", onKey, true);
    return () => { clearTimeout(t); window.removeEventListener("keydown", onKey, true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (!data) return null;

  return (
    <div className="fixed inset-0 z-[65] flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/50 animate-fade-in" onClick={onClose} />
      <div className="relative z-10 flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl bg-surface shadow-drawer animate-fade-in sm:rounded-2xl">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-green-text">
          <CheckCircle2 className="h-5 w-5" />
          <span className="font-heading text-lg font-semibold">Sale complete</span>
          <span className="ml-auto tnum text-sm text-text-tertiary">{data.receipt_no}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden bg-surface-2 p-4">
          {previewHtml ? (
            <iframe
              srcDoc={previewHtml}
              title={`Invoice ${data.receipt_no}`}
              className="h-[55vh] w-full rounded-lg border border-border bg-white shadow-card"
            />
          ) : (
            <div className="flex h-[55vh] w-full items-center justify-center rounded-lg border border-border bg-white text-text-tertiary">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2 border-t border-border p-4">
          <Button ref={printRef} onClick={printPdf} disabled={printing} className="py-3">
            {printing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />} Print
            <kbd className="ml-1 rounded border border-white/40 px-1 text-[10px] font-normal opacity-80">Enter</kbd>
          </Button>
          <Button variant="secondary" onClick={onClose}>
            <Plus className="h-4 w-4" /> New sale
            <kbd className="ml-1 rounded border border-border px-1 text-[10px] font-normal opacity-70">Esc</kbd>
          </Button>
        </div>
      </div>
    </div>
  );
}
