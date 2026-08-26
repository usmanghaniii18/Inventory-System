"use client";

import { useEffect, useState } from "react";
import { Barcode, Loader2, Printer, Wand2 } from "lucide-react";
import { Drawer } from "@hamza/shared/ui/Drawer";
import { Button } from "@hamza/shared/ui/Button";
import { Input, Label } from "@hamza/shared/ui/Input";
import { Select } from "@hamza/shared/ui/Select";
import { useToast } from "@hamza/shared/ui/Toast";
import {
  barcodeSvg, symbologyOf,
} from "@/lib/barcode";
import {
  labelDocument, fitLabel, STOCK, DEFAULT_DPI,
  type LabelStock, type LabelDpi,
} from "@/lib/label-print";
import { ensureCatalog } from "@/lib/catalog-cache";
import { assignInternalBarcode } from "./actions";

export interface LabelTarget {
  variant_id: string;
  product_id: string;
  name: string;
  label: string;
  sku: string;
  barcode: string | null;
  is_variable_weight: boolean;
}

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
  const [stock, setStock] = useState<LabelStock>("2x2");
  const [dpi, setDpi] = useState<LabelDpi>(DEFAULT_DPI);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBarcode(target?.barcode ?? null);
    setCopies("12");
  }, [target]);

  if (!target) return null;
  const sub = target.label && target.label !== "Default" ? ` · ${target.label}` : "";
  const symbology = barcode ? symbologyOf(barcode) : null;
  // Geometry is computed from the stock and the print head, not hard-coded, so
  // choosing a bigger label or a finer printer actually makes the symbol bigger.
  const fit = barcode ? fitLabel(barcode, stock, dpi) : null;

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

  function print() {
    if (!barcode || !target) return;
    const w = window.open("", "_blank", "width=800,height=600");
    if (!w) return toast("Allow pop-ups to print labels", "error");
    // Markup + stylesheet come from lib/label-print.ts, which is where the
    // "name and barcode only, never a price" rule lives and is unit-tested.
    w.document.write(labelDocument({
      name: target.name + sub,
      code: barcode,
      copies: Number(copies) || 1,
      stock,
      dpi,
      title: target.sku,
    }));
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
            {/* Preview of the actual label: product name + symbol, no price. */}
            <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-white p-3">
              <div className="max-w-full text-center text-sm font-semibold leading-tight text-black">{target.name}{sub}</div>
              {/* On-screen preview only — the printed symbol is sized in mm. */}
              <div className="w-full [&_svg]:mx-auto" dangerouslySetInnerHTML={{ __html: barcodeSvg(barcode, { height: 52, moduleWidth: 2, showText: true }) }} />
            </div>
            <p className="rounded-lg bg-surface-2 px-3 py-2 text-[11px] leading-relaxed text-text-tertiary">
              <strong className="text-text-secondary">{symbology}</strong> · module {fit!.moduleMm.toFixed(3)}mm
              ({fit!.dots} dots @ {dpi}dpi) · symbol {fit!.symbolWidthMm.toFixed(1)}mm wide
              incl. quiet zones · bars {fit!.barHeightMm}mm on a {STOCK[stock].widthMm}×{STOCK[stock].heightMm}mm label.
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
              <Select value={stock} onChange={(e) => setStock(e.target.value as LabelStock)}>
                {(Object.keys(STOCK) as LabelStock[]).map((k) => (
                  <option key={k} value={k}>{STOCK[k].label}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Printer</Label>
              <Select value={String(dpi)} onChange={(e) => setDpi(Number(e.target.value) as LabelDpi)}>
                <option value="203">203 dpi</option>
                <option value="300">300 dpi</option>
              </Select>
            </div>
          </div>
        )}
      </div>
    </Drawer>
  );
}
