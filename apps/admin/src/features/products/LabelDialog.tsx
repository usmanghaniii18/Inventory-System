"use client";

import { useEffect, useState } from "react";
import { Barcode, Loader2, Printer, Wand2 } from "lucide-react";
import { Drawer } from "@hamza/shared/ui/Drawer";
import { Button } from "@hamza/shared/ui/Button";
import { Input, Label } from "@hamza/shared/ui/Input";
import { Select } from "@hamza/shared/ui/Select";
import { useToast } from "@hamza/shared/ui/Toast";
import {
  barcodeSvg, barcodeLabelSvg, labelWidthMm, symbologyOf,
  EAN13_MODULE_MM, CODE128_MODULE_MM, LABEL_BAR_HEIGHT_MM, LABEL_DPI,
} from "@/lib/barcode";
import { ensureCatalog } from "@/lib/catalog-cache";
import { formatPKR } from "@hamza/shared/utils";
import { assignInternalBarcode } from "./actions";

export interface LabelTarget {
  variant_id: string;
  product_id: string;
  name: string;
  label: string;
  sku: string;
  sale_price: number;
  barcode: string | null;
  is_variable_weight: boolean;
}

// Label stock. "roll" prints ONE label per page sized to the die-cut label (a
// dedicated barcode/label printer); "sheet" lays labels out on A4 (the previous
// behaviour, kept as the default so nothing regresses for existing users).
type Stock = "sheet" | "roll";
const LABEL_W_MM = 50;
const LABEL_H_MM = 30;

/** Generate (if needed) and print scanner-standard shelf labels for a variant. */
export function LabelDialog({
  target,
  onClose,
  onChanged,
}: {
  target: LabelTarget | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [barcode, setBarcode] = useState<string | null>(null);
  const [copies, setCopies] = useState("12");
  const [stock, setStock] = useState<Stock>("sheet");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBarcode(target?.barcode ?? null);
    setCopies("12");
  }, [target]);

  if (!target) return null;
  const sub = target.label && target.label !== "Default" ? ` · ${target.label}` : "";
  const symbology = barcode ? symbologyOf(barcode) : null;
  const moduleMm = barcode && symbology === "EAN-13" ? EAN13_MODULE_MM : CODE128_MODULE_MM;

  async function generate() {
    if (!target) return;
    setBusy(true);
    const res = await assignInternalBarcode(target.variant_id, target.product_id, target.is_variable_weight);
    setBusy(false);
    if (res && "error" in res && res.error) return toast(res.error, "error");
    if (res && "barcode" in res && res.barcode) {
      setBarcode(res.barcode);
      await ensureCatalog({ force: true });
      onChanged();
      toast("Internal barcode generated");
    }
  }

  function labelHtml(code: string) {
    return (
      `<div class="lbl">` +
      `<div class="nm">${escapeHtml(target!.name + sub)}</div>` +
      `<div class="pr">${escapeHtml(formatPKR(target!.sale_price))}</div>` +
      // Rendered at an exact millimetre size. The symbol must NOT be scaled by
      // the surrounding CSS box: squeezing it is what used to drop the module
      // width below the minimum a scanner can resolve.
      barcodeLabelSvg(code, LABEL_BAR_HEIGHT_MM) +
      `</div>`
    );
  }

  function print() {
    if (!barcode) return;
    const n = Math.max(1, Math.min(200, Number(copies) || 1));
    const w = window.open("", "_blank", "width=800,height=600");
    if (!w) return toast("Allow pop-ups to print labels", "error");

    // One label per page on a roll; a flowed grid on an A4 sheet. Either way the
    // barcode keeps its exact printed dimensions (width:auto, max-width:none).
    const page = stock === "roll"
      ? `@page{size:${LABEL_W_MM}mm ${LABEL_H_MM}mm;margin:0}` +
        `.lbl{width:${LABEL_W_MM}mm;height:${LABEL_H_MM}mm;page-break-after:always;` +
        `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.5mm;border:0}` +
        `.grid{display:block}`
      : `@page{size:A4;margin:8mm}` +
        `.grid{display:flex;flex-wrap:wrap;gap:3mm}` +
        `.lbl{width:${LABEL_W_MM}mm;border:0.2mm solid #eee;border-radius:1mm;padding:1.5mm;` +
        `display:flex;flex-direction:column;align-items:center;gap:0.5mm;page-break-inside:avoid}`;

    w.document.write(
      `<html><head><title>Labels — ${escapeHtml(target!.sku)}</title><style>` +
        `*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;margin:0;color:#000;background:#fff;` +
        `-webkit-print-color-adjust:exact;print-color-adjust:exact}` +
        page +
        `.nm{font-size:2.4mm;font-weight:600;line-height:1.15;text-align:center;max-width:100%;` +
        `overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}` +
        `.pr{font-size:3.2mm;font-weight:700}` +
        // Critical: never let the layout resize the symbol.
        `svg{width:auto!important;max-width:none!important;height:auto!important;display:block}` +
        `</style></head><body><div class="grid">${Array(n).fill(labelHtml(barcode)).join("")}</div>` +
        `<script>window.onload=function(){window.print()}</script></body></html>`,
    );
    w.document.close();
  }

  return (
    <Drawer
      open={!!target}
      onClose={onClose}
      title="Print label"
      footer={
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>Close</Button>
          <Button type="button" className="flex-1" disabled={!barcode} onClick={print}>
            <Printer className="h-4 w-4" /> Print {copies}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <div className="font-medium text-text-primary">{target.name}{sub}</div>
          <div className="text-xs text-text-tertiary">{target.sku}{target.is_variable_weight ? " · variable weight" : ""}</div>
        </div>

        {barcode ? (
          <>
            <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-white p-3">
              {/* On-screen preview only — the printed symbol is sized in mm. */}
              <div className="w-full [&_svg]:mx-auto" dangerouslySetInnerHTML={{ __html: barcodeSvg(barcode, { height: 52, moduleWidth: 2, showText: true }) }} />
              <div className="text-sm font-semibold text-text-primary">{formatPKR(target.sale_price)}</div>
            </div>
            <p className="rounded-lg bg-surface-2 px-3 py-2 text-[11px] leading-relaxed text-text-tertiary">
              <strong className="text-text-secondary">{symbology}</strong> · module {moduleMm.toFixed(3)}mm
              ({Math.round(moduleMm / (25.4 / LABEL_DPI))} dots @ {LABEL_DPI}dpi) · symbol {labelWidthMm(barcode).toFixed(1)}mm wide
              incl. quiet zones · bars {LABEL_BAR_HEIGHT_MM}mm.
              Print at <strong className="text-text-secondary">100% scale</strong> (no “fit to page”) so these
              dimensions survive to the paper.
            </p>
          </>
        ) : (
          <div className="space-y-3 rounded-xl border border-dashed border-border p-4 text-center">
            <Barcode className="mx-auto h-6 w-6 text-text-tertiary" />
            <p className="text-sm text-text-secondary">This item has no barcode yet.</p>
            <Button type="button" onClick={generate} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              Generate internal barcode
            </Button>
            <p className="text-[11px] text-text-tertiary">
              {target.is_variable_weight
                ? "A weight template (GS1 prefix-2) is created so the scale’s weight labels scan."
                : "A GS1 prefix-2 EAN-13 is created and saved so the item becomes scannable."}
            </p>
          </div>
        )}

        {barcode && (
          <div className="flex gap-3">
            <div>
              <Label>Copies to print</Label>
              <Input type="number" value={copies} onChange={(e) => setCopies(e.target.value)} className="w-32" />
            </div>
            <div className="flex-1">
              <Label>Label stock</Label>
              <Select value={stock} onChange={(e) => setStock(e.target.value as Stock)}>
                <option value="sheet">A4 sheet (many per page)</option>
                <option value="roll">Label roll ({LABEL_W_MM}×{LABEL_H_MM}mm, one per label)</option>
              </Select>
            </div>
          </div>
        )}
      </div>
    </Drawer>
  );
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
