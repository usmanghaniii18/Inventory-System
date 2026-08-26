/**
 * Simulates a real USB/Bluetooth barcode scanner — no hardware required.
 *
 * A wedge scanner is an HID keyboard: it "types" the code as a fast, evenly
 * spaced keystroke burst and ends with Enter. These tests drive the detector
 * with the exact timings real scanners produce, at the speeds cheap and
 * expensive units actually run at, and assert the two things that matter:
 *   1. every plausible scanner speed is recognised and routed, and
 *   2. a person typing is still never mistaken for a scan.
 *
 * The clock, focus state and timers are injected, so this runs in the project's
 * existing node test environment with no DOM and no extra dependencies.
 */
import { describe, it, expect } from "vitest";
import { createScanDetector, type FocusKind, type ScanKeyEvent } from "./useHardwareScanner";

/** A test rig standing in for the browser: virtual clock, focus and timers. */
function rig(focus: FocusKind = "none", known: string[] = []) {
  let clock = 0;
  const catalogue = new Set(known);
  const codes: string[] = [];
  const stripped: string[] = [];
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextTimer = 1;
  let currentFocus = focus;

  const detector = createScanDetector({
    now: () => clock,
    focus: () => currentFocus,
    stripLeaked: (l) => { if (l) stripped.push(l); },
    onScan: (c) => codes.push(c),
    isKnownCode: (c) => catalogue.has(c),
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: (t) => { timers.delete(t as number); },
    debug: false,
  });

  /** Advance the virtual clock, firing any timer that comes due. */
  function advance(ms: number) {
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

  /** One keydown, tracking whether the detector consumed it. */
  function key(k: string): { defaultPrevented: boolean } {
    let prevented = false;
    const e: ScanKeyEvent = {
      key: k,
      preventDefault: () => { prevented = true; },
      stopPropagation: () => {},
    };
    detector.handleKeyDown(e);
    return { defaultPrevented: prevented };
  }

  /** Type `code` at `gapMs` per character, then (optionally) press Enter. */
  function scan(code: string, gapMs: number, sendEnter = true) {
    const consumed: boolean[] = [];
    for (const ch of code) {
      clock += gapMs;
      consumed.push(key(ch).defaultPrevented);
    }
    if (sendEnter) {
      clock += gapMs;
      key("Enter");
    }
    return consumed;
  }

  return {
    codes, stripped, scan, key, advance,
    setFocus: (f: FocusKind) => { currentFocus = f; },
    idle: (ms = 300) => advance(ms),
    tick: (ms: number) => { clock += ms; },
  };
}

const EAN = "2900000010005";

describe("wedge scanner simulation — nothing focused", () => {
  it("reads a fast scanner (5ms/char)", () => {
    const r = rig();
    r.scan(EAN, 5);
    expect(r.codes).toEqual([EAN]);
  });

  it("reads a typical scanner (25ms/char)", () => {
    const r = rig();
    r.scan("5449000000996", 25);
    expect(r.codes).toEqual(["5449000000996"]);
  });

  it("reads a slow scanner (85ms/char) — previously dropped", () => {
    const r = rig();
    r.scan("8964000201022", 85);
    expect(r.codes).toEqual(["8964000201022"]);
  });

  it("reads a very slow all-digit burst (130ms/char) via the digit-run rule", () => {
    const r = rig();
    r.scan("8964000201022", 130);
    expect(r.codes).toEqual(["8964000201022"]);
  });

  it("reads an alphanumeric Code-128 SKU scan", () => {
    const r = rig();
    r.scan("GRO-SUG-1", 20);
    expect(r.codes).toEqual(["GRO-SUG-1"]);
  });

  it("flushes a burst that arrives with NO trailing Enter", () => {
    const r = rig();
    r.scan(EAN, 12, false);
    r.advance(200); // idle-flush window
    expect(r.codes).toEqual([EAN]);
  });

  it("handles a Tab-terminated scanner", () => {
    const r = rig();
    for (const ch of EAN) { r.tick(10); r.key(ch); }
    r.tick(10); r.key("Tab");
    expect(r.codes).toEqual([EAN]);
  });
});

describe("human typing is never mistaken for a scan", () => {
  it("ignores a word typed at 300ms/char", () => {
    const r = rig();
    r.scan("sugar packet", 300);
    expect(r.codes).toEqual([]);
  });

  it("ignores a short hand-typed number", () => {
    const r = rig();
    r.scan("250", 180);
    expect(r.codes).toEqual([]);
  });

  it("ignores 13 digits typed at a realistic human 200ms/char", () => {
    const r = rig();
    r.scan(EAN, 200);
    expect(r.codes).toEqual([]);
  });
});

describe("focused fields", () => {
  it("consumes the burst so it cannot land in the search box", () => {
    const r = rig("typing-field");
    const consumed = r.scan(EAN, 8);
    // The first char can't be judged yet; every one after it is consumed.
    expect(consumed[0]).toBe(false);
    expect(consumed.slice(1).every(Boolean)).toBe(true);
    expect(r.codes).toEqual([EAN]);
    // and the one leaked char is cleaned back out of the field
    expect(r.stripped).toEqual([EAN[0]]);
  });

  it("leaves a dedicated data-scan-input field to receive the scan itself", () => {
    const r = rig("scan-target");
    r.scan(EAN, 8);
    expect(r.codes).toEqual([]);
  });
});

describe("repeat scans", () => {
  it("suppresses a scanner double-firing one trigger pull", () => {
    const r = rig();
    r.scan(EAN, 8);
    r.tick(40); // same pull, echoed by the hardware
    r.scan(EAN, 8);
    expect(r.codes).toEqual([EAN]);
  });

  it("accepts a DELIBERATE re-scan of the same item (customer buying two)", () => {
    const r = rig();
    r.scan(EAN, 8);
    r.tick(500); // cashier scans the second unit
    r.scan(EAN, 8);
    expect(r.codes).toEqual([EAN, EAN]);
  });

  it("reads a run of different items back to back", () => {
    const r = rig();
    r.scan(EAN, 8);
    r.tick(300);
    r.scan("5449000000996", 8);
    r.tick(300);
    r.scan("8964000201022", 8);
    expect(r.codes).toEqual([EAN, "5449000000996", "8964000201022"]);
  });
});

// ---------------------------------------------------------------------------
// Short barcodes (live-data fix)
//
// An audit of the production catalogue found 794 of 2335 barcodes shorter than
// MIN_SCAN_LENGTH — hand-entered shelf codes like "3DX", "09F", "411" covering
// 758 active sellable variants. Their printed labels are valid Code-128; the
// length threshold alone was refusing them. A short burst is now accepted when,
// and only when, all three of terminator + machine speed + EXACT catalogue
// match hold.
// ---------------------------------------------------------------------------

const SHORT_CATALOGUE = ["3DX", "09F", "411", "AB", "1KC", "7g"];

describe("short barcodes that exactly match the catalogue DO scan", () => {
  it("reads a 3-character shelf code", () => {
    const r = rig("none", SHORT_CATALOGUE);
    r.scan("3DX", 8);
    expect(r.codes).toEqual(["3DX"]);
  });

  it("reads a 2-character shelf code", () => {
    const r = rig("none", SHORT_CATALOGUE);
    r.scan("AB", 8);
    expect(r.codes).toEqual(["AB"]);
  });

  it("reads an all-digit short code", () => {
    const r = rig("none", SHORT_CATALOGUE);
    r.scan("411", 8);
    expect(r.codes).toEqual(["411"]);
  });

  it("reads a mixed-case short code exactly as stored", () => {
    const r = rig("none", SHORT_CATALOGUE);
    r.scan("7g", 8);
    expect(r.codes).toEqual(["7g"]);
  });

  it("still works with the search box focused, and cleans the field", () => {
    const r = rig("typing-field", SHORT_CATALOGUE);
    r.scan("09F", 8);
    expect(r.codes).toEqual(["09F"]);
    expect(r.stripped.join("")).toBe("0"); // the one char that leaked before we were sure
  });

  it("reads several short codes back to back", () => {
    const r = rig("none", SHORT_CATALOGUE);
    r.scan("3DX", 8);
    r.idle();
    r.scan("411", 8);
    r.idle();
    r.scan("1KC", 8);
    expect(r.codes).toEqual(["3DX", "411", "1KC"]);
  });

  it("does not disturb ordinary full-length scans", () => {
    const r = rig("none", SHORT_CATALOGUE);
    r.scan(EAN, 8);
    expect(r.codes).toEqual([EAN]);
  });
});

describe("short input that is NOT a barcode is never mistaken for a scan", () => {
  it("ignores fast-typed text of the same length that is not in the catalogue", () => {
    const r = rig("none", SHORT_CATALOGUE);
    r.scan("XYZ", 8); // same length, same speed — simply not a known code
    expect(r.codes).toEqual([]);
  });

  it("ignores a fast-typed short number that is not a barcode", () => {
    const r = rig("none", SHORT_CATALOGUE);
    r.scan("412", 8); // one digit away from the real "411"
    expect(r.codes).toEqual([]);
  });

  it("refuses a PREFIX of a known code — exact equality only", () => {
    const r = rig("none", SHORT_CATALOGUE);
    r.scan("3D", 8); // prefix of "3DX"
    expect(r.codes).toEqual([]);
  });

  it("refuses a known code with anything appended", () => {
    const r = rig("none", SHORT_CATALOGUE);
    r.scan("3DXQ", 8);
    expect(r.codes).toEqual([]);
  });

  it("refuses a single character, even one that is a known code", () => {
    const r = rig("none", ["7"]);
    r.scan("7", 8);
    expect(r.codes).toEqual([]);
  });

  it("refuses a known short code typed at HUMAN speed", () => {
    const r = rig("none", SHORT_CATALOGUE);
    r.scan("3DX", 200);
    expect(r.codes).toEqual([]);
  });

  it("refuses a known short code that arrives with NO terminator", () => {
    // The idle-flush path is excluded on purpose: a cashier typing "3DXY" who
    // pauses after "3DX" must not have an item billed mid-word.
    const r = rig("none", SHORT_CATALOGUE);
    r.scan("3DX", 8, false);
    r.idle(400);
    expect(r.codes).toEqual([]);
  });

  it("accepts nothing short when the host offers no catalogue at all", () => {
    const r = rig("none"); // no isKnownCode data — pre-existing behaviour
    r.scan("3DX", 8);
    expect(r.codes).toEqual([]);
  });
});

describe("the short-burst rule does not reopen the wrong-product bug", () => {
  it("a half-read LONG scan is still discarded, never resolved as a short code", () => {
    // "2900000010005" jittered so the buffer is wiped mid-code, leaving a tail
    // that happens to be a real short barcode. It must NOT be billed as that
    // product: the tail arrives with no terminator of its own and the burst
    // that produced it was a broken long scan.
    const r = rig("typing-field", ["005", ...SHORT_CATALOGUE]);
    const gaps = [0, 6, 6, 300, 6, 6, 6, 250, 6, 6, 6, 6, 400];
    EAN.split("").forEach((ch, i) => { r.tick(gaps[i]); r.key(ch); });
    r.tick(6);
    r.key("Enter");
    expect(r.codes).not.toContain("005");
  });

  it("never routes a code the catalogue does not hold, at any length", () => {
    const r = rig("none", SHORT_CATALOGUE);
    for (const s of ["QQ", "ZZZ", "9999", "3D", "3DXQ"]) { r.scan(s, 8); r.idle(); }
    expect(r.codes).toEqual([]);
  });
});
