/**
 * End-to-end scan -> bill test for the wrong-product bug.
 *
 * Wires the REAL wedge detector (createScanDetector) to a stand-in POS that
 * reproduces the resolve/add logic exactly as PosClient does it: the same
 * barcode index, the same findByBarcode -> handleScan -> submitSearch ordering,
 * the same looksLikeCode guard. What it adds is a browser: an input element
 * that receives whatever the detector does not consume, and an Enter key that
 * reaches the box's submit handler only when the detector did not stop it.
 *
 * That is where the bug lived. A jittery scanner burst — some keys fast enough
 * to be consumed, some slow enough to land in the box — was abandoned by the
 * detector without cleaning up, leaving a FRAGMENT of the barcode in the search
 * box and letting the scanner's Enter through to submit it. The fragment then
 * substring-matched an unrelated 13-digit barcode and that product was billed.
 * Different jitter left a different fragment, so a repeated scan of one sticker
 * added a different wrong product each time, until a clean burst finally got
 * through with the whole code.
 */
import { describe, it, expect } from "vitest";
import { createScanDetector, type ScanKeyEvent } from "@/lib/useHardwareScanner";
import { looksLikeCode, parseScan } from "@/lib/barcode";

interface Product { variant_id: string; name: string; sku: string; barcodes: string[] }

// Codes that deliberately share digit runs, so any fragment-based match has
// plenty of wrong products to land on — exactly the live catalogue's shape,
// where every internal code starts "29" and is 13 digits long.
const CATALOG: Product[] = [
  { variant_id: "v-sugar", name: "Areeba Sugar 1kg", sku: "GRO-SUG-1", barcodes: ["2900000010005"] },
  { variant_id: "v-atta", name: "Bake Parlor Atta", sku: "GRO-ATT-5", barcodes: ["2900000020053"] },
  { variant_id: "v-ghee", name: "Dalda Banaspati", sku: "GRO-GHE-1", barcodes: ["2900000030002", "8964000123457"] },
  { variant_id: "v-milk", name: "Olpers Milk 1L", sku: "DRY-MLK-1", barcodes: ["2900000040051"] },
  { variant_id: "v-tea", name: "Tapal Danedar", sku: "BEV-TEA-9", barcodes: ["2900000050009"] },
].sort((a, b) => a.name.localeCompare(b.name)); // the grid order pool[0] used to pick from

/** A POS till: the search box, the resolve path, and the bill. */
function till() {
  const bill: string[] = [];
  const rejected: string[] = [];
  let box = ""; // the text actually in the search box
  let clock = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextTimer = 1;

  const byBarcode = new Map<string, Product>();
  for (const p of CATALOG) for (const c of p.barcodes) byBarcode.set(c, p);

  const find = (raw: string) => {
    const parsed = parseScan(raw);
    return byBarcode.get(parsed.lookupKey) ?? byBarcode.get(parsed.barcode);
  };

  /** Machine input: resolve exactly or report. Never guesses. */
  function handleScan(raw: string) {
    const p = find(raw);
    if (!p) { rejected.push(raw); return; }
    bill.push(p.variant_id);
  }

  /** Enter in the search box — PosClient.submitSearch(), same ordering. */
  function submitSearch() {
    const term = box.trim();
    box = "";
    if (!term) return;
    if (find(term)) { handleScan(term); return; }

    const t = term.toLowerCase();
    const exact = CATALOG.filter((x) => x.sku.toLowerCase() === t || x.name.toLowerCase() === t);
    if (exact.length === 1) { bill.push(exact[0].variant_id); return; }

    // The guard. Without it, control falls into the fuzzy pool pick below.
    if (looksLikeCode(term)) { rejected.push(term); return; }

    const pool = CATALOG.filter(
      (x) => x.name.toLowerCase().includes(t) || x.sku.toLowerCase().includes(t) || x.barcodes.some((b) => b.includes(t)),
    );
    if (pool.length) bill.push(pool[0].variant_id); // <- the old wrong-product path
  }

  const detector = createScanDetector({
    now: () => clock,
    focus: () => "typing-field", // the POS box is focused, as it always is
    stripLeaked: (l) => { if (l && box.endsWith(l)) box = box.slice(0, -l.length); },
    onScan: (code) => handleScan(code),
    onPartial: () => { box = ""; rejected.push("(partial)"); },
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
    if (!prevented && k.length === 1) box += k; // browser default
    if (k === "Enter" && !stopped) submitSearch(); // React onKeyDown
  }

  /** Let any pending idle-flush timer come due. */
  function settle(ms: number) {
    const target = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
    }
    clock = target;
  }

  /** Drive one scan. `gaps` supplies a per-character inter-key delay in ms. */
  function scan(code: string, gaps: number | number[]) {
    const g = (i: number) => (Array.isArray(gaps) ? gaps[i % gaps.length] : gaps);
    code.split("").forEach((ch, i) => { clock += g(i); key(ch); });
    clock += 6;
    key("Enter");
    settle(400);
  }

  return { scan, settle, bill, rejected, get box() { return box; } };
}

const SUGAR = "2900000010005";
const GHEE = "2900000030002";
const TEA = "2900000050009";

describe("scanning the SAME barcode 5x in a row", () => {
  it("adds the same correct product every time — clean fast scanner", () => {
    const t = till();
    for (let i = 0; i < 5; i++) t.scan(SUGAR, 6);
    expect(t.bill).toEqual(["v-sugar", "v-sugar", "v-sugar", "v-sugar", "v-sugar"]);
    expect(t.rejected).toEqual([]);
    expect(t.box).toBe("");
  });

  it("adds the same correct product every time — slow scanner (85ms/char)", () => {
    const t = till();
    for (let i = 0; i < 5; i++) t.scan(SUGAR, 85);
    expect(t.bill).toEqual(Array(5).fill("v-sugar"));
    expect(t.box).toBe("");
  });

  it("never bills a WRONG product on a jittery scanner (the reported bug)", () => {
    // Five scans of one sticker, each with a different jitter pattern — this is
    // what produced "a different wrong product each time".
    const patterns: number[][] = [
      [0, 6, 6, 300, 6, 6, 6, 250, 6, 6, 6, 6, 400],
      [0, 6, 260, 6, 6, 6, 6, 6, 310, 6, 6, 6, 6],
      [0, 400, 6, 6, 6, 6, 280, 6, 6, 6, 6, 6, 6],
      [0, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 500],
      [0, 6, 6, 6, 270, 6, 6, 290, 6, 6, 6, 6, 6],
    ];
    const t = till();
    for (const p of patterns) t.scan(SUGAR, p);

    // The guarantee that matters: whatever the timing did, the bill contains
    // ONLY the scanned product. A refused scan is acceptable; a wrong item is not.
    expect(t.bill.every((v) => v === "v-sugar")).toBe(true);
    // and no fragment is left behind to poison the NEXT scan
    expect(t.box).toBe("");
  });

  it("leaves nothing billable behind when a burst is half-read", () => {
    const t = till();
    t.scan(SUGAR, [0, 6, 6, 300, 6, 6, 6, 250, 6, 6, 6, 6, 400]);
    expect(t.bill).not.toContain("v-atta");
    expect(t.bill).not.toContain("v-ghee");
    expect(t.bill).not.toContain("v-milk");
    expect(t.bill).not.toContain("v-tea");
    expect(t.box).toBe("");
  });
});

describe("three different barcodes back to back", () => {
  it("bills each to its own product, in order, with no bleed between scans", () => {
    const t = till();
    t.scan(SUGAR, 6);
    t.scan(GHEE, 6);
    t.scan(TEA, 6);
    expect(t.bill).toEqual(["v-sugar", "v-ghee", "v-tea"]);
    expect(t.rejected).toEqual([]);
  });

  it("holds up at a slow scan rate too", () => {
    const t = till();
    t.scan(SUGAR, 80);
    t.scan(GHEE, 80);
    t.scan(TEA, 80);
    expect(t.bill).toEqual(["v-sugar", "v-ghee", "v-tea"]);
  });

  it("resolves a product's ALTERNATE barcode to the same product as its primary", () => {
    const t = till();
    t.scan(GHEE, 6); // internal sticker
    t.scan("8964000123457", 6); // manufacturer EAN on the same variant
    expect(t.bill).toEqual(["v-ghee", "v-ghee"]);
  });

  it("reports an unknown code instead of guessing a product from it", () => {
    const t = till();
    t.scan("2900000099999", 6); // valid shape, not in the catalogue
    expect(t.bill).toEqual([]);
    expect(t.rejected).toContain("2900000099999");
  });

  it("still searches by name when a human types one", () => {
    const t = till();
    t.scan("Tapal Danedar", 200); // human speed — the detector leaves it alone
    expect(t.bill).toEqual(["v-tea"]);
  });
});
