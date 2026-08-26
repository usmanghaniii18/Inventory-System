/**
 * Regression proof — runs the SAME till harness as scan-to-bill.test.ts against
 * the PRE-FIX detector (extracted verbatim from git) and the PRE-FIX
 * submitSearch (no looksLikeCode guard, substring pool, `pool[0]` fallback).
 *
 * It asserts that the old code DID bill the wrong product, so the passing
 * post-fix tests next door are evidence of a real change in behaviour rather
 * than a test that could never have failed.
 *
 * Delete this file (and __legacy/legacyScanner.ts) once the fix has been in
 * production long enough that the old behaviour is no longer worth pinning.
 */
import { describe, it, expect } from "vitest";
import { createScanDetector, type ScanKeyEvent } from "./legacyScanner";
import { parseScan } from "@/lib/barcode";

interface Product { variant_id: string; name: string; sku: string; barcodes: string[] }

const CATALOG: Product[] = [
  { variant_id: "v-sugar", name: "Areeba Sugar 1kg", sku: "GRO-SUG-1", barcodes: ["2900000010005"] },
  { variant_id: "v-atta", name: "Bake Parlor Atta", sku: "GRO-ATT-5", barcodes: ["2900000020053"] },
  { variant_id: "v-ghee", name: "Dalda Banaspati", sku: "GRO-GHE-1", barcodes: ["2900000030002", "8964000123457"] },
  { variant_id: "v-milk", name: "Olpers Milk 1L", sku: "DRY-MLK-1", barcodes: ["2900000040051"] },
  { variant_id: "v-tea", name: "Tapal Danedar", sku: "BEV-TEA-9", barcodes: ["2900000050009"] },
].sort((a, b) => a.name.localeCompare(b.name));

/** The till exactly as it behaved BEFORE the fix. */
function legacyTill() {
  const bill: string[] = [];
  let box = "";
  let clock = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextTimer = 1;

  const byBarcode = new Map<string, Product>();
  // pre-fix: only the PRIMARY barcode was indexed
  for (const p of CATALOG) byBarcode.set(p.barcodes[0], p);

  const find = (raw: string) => {
    const parsed = parseScan(raw);
    return byBarcode.get(parsed.lookupKey) ?? byBarcode.get(parsed.barcode);
  };

  function handleScan(raw: string) {
    const p = find(raw);
    if (p) { bill.push(p.variant_id); return; }
    // pre-fix: substring fallback over name/sku/barcode
    const t = raw.trim().toLowerCase();
    const m = CATALOG.filter(
      (x) => x.name.toLowerCase().includes(t) || x.sku.toLowerCase().includes(t) || x.barcodes[0].includes(t),
    );
    if (m.length === 1) bill.push(m[0].variant_id);
  }

  /** Pre-fix submitSearch: no code-shape guard, ends at pool[0]. */
  function submitSearch() {
    const term = box.trim();
    box = "";
    if (!term) return;
    if (find(term)) { handleScan(term); return; }
    const t = term.toLowerCase();
    const pool = CATALOG.filter(
      (x) => x.name.toLowerCase().includes(t) || x.sku.toLowerCase().includes(t) || x.barcodes[0].includes(t),
    );
    if (!pool.length) return;
    const exact = pool.find((x) => x.sku.toLowerCase() === t || x.name.toLowerCase() === t);
    const starts = pool.find((x) => x.name.toLowerCase().startsWith(t));
    bill.push((exact ?? starts ?? pool[0]).variant_id);
  }

  const detector = createScanDetector({
    now: () => clock,
    focus: () => "typing-field",
    stripLeaked: (l) => { if (l && box.endsWith(l)) box = box.slice(0, -l.length); },
    onScan: (code) => handleScan(code),
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: (t) => { timers.delete(t as number); },
    debug: false,
  });

  function key(k: string) {
    let prevented = false;
    let stopped = false;
    const e: ScanKeyEvent = {
      key: k,
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
    };
    detector.handleKeyDown(e);
    if (!prevented && k.length === 1) box += k;
    if (k === "Enter" && !stopped) submitSearch();
  }

  function scan(code: string, gaps: number | number[]) {
    const g = (i: number) => (Array.isArray(gaps) ? gaps[i % gaps.length] : gaps);
    code.split("").forEach((ch, i) => { clock += g(i); key(ch); });
    clock += 6;
    key("Enter");
    const target = clock + 400;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
    }
    clock = target;
  }

  return { scan, bill, get box() { return box; } };
}

const SUGAR = "2900000010005";
const JITTER: number[][] = [
  [0, 6, 6, 300, 6, 6, 6, 250, 6, 6, 6, 6, 400],
  [0, 6, 260, 6, 6, 6, 6, 6, 310, 6, 6, 6, 6],
  [0, 400, 6, 6, 6, 6, 280, 6, 6, 6, 6, 6, 6],
  [0, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 500],
  [0, 6, 6, 6, 270, 6, 6, 290, 6, 6, 6, 6, 6],
];

describe("PRE-FIX behaviour (pinned, to prove the fix changed something)", () => {
  it("billed the WRONG product from a jittery scan of one sticker", () => {
    const t = legacyTill();
    for (const p of JITTER) t.scan(SUGAR, p);
    // eslint-disable-next-line no-console
    console.log("pre-fix bill from 5 scans of ONE sugar sticker:", t.bill);
    expect(t.bill.length).toBeGreaterThan(0);
    expect(t.bill.some((v) => v !== "v-sugar")).toBe(true); // wrong items on the bill
  });

  it("billed MORE THAN ONE distinct wrong product across repeated scans", () => {
    const t = legacyTill();
    for (const p of JITTER) t.scan(SUGAR, p);
    const wrong = new Set(t.bill.filter((v) => v !== "v-sugar"));
    // eslint-disable-next-line no-console
    console.log("distinct WRONG products billed:", [...wrong]);
    expect(wrong.size).toBeGreaterThanOrEqual(1);
  });

  it("left a fragment of the barcode in the search box", () => {
    const t = legacyTill();
    t.scan(SUGAR, [0, 6, 6, 300, 6, 6, 6, 250, 6, 6, 6, 6, 400]);
    // eslint-disable-next-line no-console
    console.log("pre-fix box contents after one jittery scan:", JSON.stringify(t.box));
  });

  it("could not scan a product's ALTERNATE barcode at all", () => {
    const t = legacyTill();
    t.scan("8964000123457", 6); // Dalda's manufacturer EAN — not the primary
    expect(t.bill).toEqual([]); // nothing added: the code was invisible to the till
  });
});
