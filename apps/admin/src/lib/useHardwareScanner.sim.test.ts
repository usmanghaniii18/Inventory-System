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
function rig(focus: FocusKind = "none") {
  let clock = 0;
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
