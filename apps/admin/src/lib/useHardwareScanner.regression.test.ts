/**
 * The two till failures reported straight after the 63d9c49 / 4e52315 deploy,
 * pinned as tests against the real detector.
 *
 *   1. "Unknown code: 961100001019" on the first scan, correct on the second.
 *      The product's real barcode is 8961100001019 (TIBET SNOW CREAM, live
 *      catalogue). The leading digit was being lost, and the remainder was then
 *      routed as though it were a whole code.
 *
 *   2. "Scan not read — scan again", permanently, on the shop's own short
 *      printed codes while bought-in 12/13-digit EANs read perfectly on the
 *      same scanner.
 *
 * Both are timing rules, not print or data faults: the catalogue holds
 * 8961100001019 and 258256, and the printed geometry for both was measured
 * correct (see label-print.test.ts).
 */
import { describe, it, expect } from "vitest";
import { createScanDetector, type FocusKind, type ScanKeyEvent } from "./useHardwareScanner";

/**
 * A rig that models the ONE thing the old detector got wrong: the browser
 * stamps a key when it is created, and delivers it whenever the main thread is
 * free. `blockedFor` makes those two clocks come apart exactly as a busy page
 * does.
 */
function rig(opts: { focus?: FocusKind; known?: string[] } = {}) {
  let created = 0; // the scanner's clock — what KeyboardEvent.timeStamp carries
  let delivered = 0; // the handler's clock — what performance.now() reads
  let block = 0; // main-thread work still owed before delivery catches up
  const known = new Set(opts.known ?? []);
  const codes: string[] = [];
  const partials: string[] = [];
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextTimer = 1;

  const detector = createScanDetector({
    now: () => delivered,
    focus: () => opts.focus ?? "none",
    stripLeaked: () => {},
    onScan: (c) => codes.push(c),
    onPartial: (f) => partials.push(f),
    isKnownCode: (c) => known.has(c),
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: delivered + ms }); return id; },
    clearTimer: (t) => { timers.delete(t as number); },
    debug: false,
  });

  /** Run any timer now due on the DELIVERY clock (as a blocked page would). */
  function drainTimers() {
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= delivered).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      due[1].fn();
    }
  }

  function key(k: string, gapMs: number) {
    created += gapMs;
    // Delivery cannot precede creation, and cannot happen while the thread is
    // still busy: a blocked page hands the whole queue over at once.
    delivered = Math.max(delivered, created) + block;
    block = 0;
    drainTimers();
    const e: ScanKeyEvent = {
      key: k,
      timeStamp: created,
      preventDefault: () => {},
      stopPropagation: () => {},
    };
    detector.handleKeyDown(e);
  }

  return {
    codes,
    partials,
    /** The page freezes for `ms` before the NEXT key is delivered. */
    blockFor: (ms: number) => { block = ms; },
    scan(code: string, gapMs: number, sendEnter = true) {
      for (const ch of code) key(ch, gapMs);
      if (sendEnter) key("Enter", gapMs);
    },
    /** Nothing arrives for a while; any timer due in that window runs. */
    idle(ms: number) { created += ms; delivered = Math.max(delivered, created); drainTimers(); },
  };
}

/** The real product from the report; the client's screenshot showed it minus the 8. */
const REAL_EAN = "8961100001019";
const TRUNCATED = "961100001019";

describe("issue 1 — a stalled page must not truncate a scan", () => {
  it("reads the whole code when nothing blocks", () => {
    const r = rig();
    r.scan(REAL_EAN, 5);
    expect(r.codes).toEqual([REAL_EAN]);
  });

  // The reported case: the catalogue reconcile lands mid-burst and re-renders
  // the till, so every remaining keystroke is delivered in one clump.
  for (const stallMs of [260, 400, 700, 1200, 2500]) {
    it(`survives a ${stallMs}ms freeze after the FIRST character`, () => {
      const r = rig();
      r.scan(REAL_EAN[0], 5, false);
      r.blockFor(stallMs);
      r.scan(REAL_EAN.slice(1), 5);
      expect(r.codes).toEqual([REAL_EAN]);
      expect(r.codes).not.toContain(TRUNCATED);
    });
  }

  it("survives a freeze in the MIDDLE of the burst", () => {
    const r = rig();
    r.scan(REAL_EAN.slice(0, 5), 5, false);
    r.blockFor(900);
    r.scan(REAL_EAN.slice(5), 5);
    expect(r.codes).toEqual([REAL_EAN]);
  });

  it("never routes the tail of a burst as if it were a whole code", () => {
    const r = rig();
    r.scan(REAL_EAN[0], 5, false);
    r.blockFor(600);
    r.scan(REAL_EAN.slice(1), 5);
    // Whatever else happens, a code the catalogue does not hold must not be
    // presented to the till as a successful read.
    expect(r.codes.every((c) => c === REAL_EAN)).toBe(true);
  });

  it("a freeze longer than the idle flush does not close the burst early", () => {
    const r = rig();
    r.scan(REAL_EAN.slice(0, 4), 5, false);
    r.blockFor(500); // > FLUSH_IDLE_MS, so the idle timer comes due mid-burst
    r.scan(REAL_EAN.slice(4), 5);
    expect(r.codes).toEqual([REAL_EAN]);
  });

  it("still treats a REAL pause as a new sequence", () => {
    const r = rig();
    r.scan("111", 5, false);
    r.idle(800); // genuine silence — the thread was free throughout
    r.scan(REAL_EAN, 5);
    expect(r.codes).toEqual([REAL_EAN]);
  });
});

describe("issue 2 — a scanner's speed must not decide WHICH codes scan", () => {
  // The shop's own codes, and the bought-in ones, on the SAME hardware.
  const SHORT = ["258256", "411", "3DX", "25717", "2586700"];
  const LONG = ["8961100001019", "2900000010024"];
  const known = [...SHORT, ...LONG];

  // A jittery wedge straddling the machine-speed bar: this is the profile that
  // produced "Scan not read — scan again" on every short code while every long
  // one read first time.
  const jitter = [60, 130];

  function scanJittered(code: string, focus: FocusKind) {
    const r = rig({ focus, known });
    code.split("").forEach((ch, i) => r.scan(ch, jitter[i % jitter.length], false));
    r.scan("", 40); // the terminating Enter
    return r;
  }

  for (const focus of ["none", "typing-field"] as FocusKind[]) {
    it(`short shop codes read on a jittery scanner (focus: ${focus})`, () => {
      for (const code of SHORT) {
        const r = scanJittered(code, focus);
        expect(r.codes, `${code} should scan`).toEqual([code]);
        expect(r.partials, `${code} should not report a broken scan`).toEqual([]);
      }
    });

    it(`long manufacturer codes still read on the same scanner (focus: ${focus})`, () => {
      for (const code of LONG) {
        const r = scanJittered(code, focus);
        expect(r.codes, `${code} should scan`).toEqual([code]);
      }
    });
  }

  it("a steady 130ms/char burst reads at every length", () => {
    for (const code of [...SHORT, ...LONG]) {
      const r = rig({ known });
      r.scan(code, 130);
      expect(r.codes, `${code} at 130ms/char`).toEqual([code]);
    }
  });

  it("the slow allowance still requires the catalogue to know the code", () => {
    // Same speed, same shape — but not a barcode. Typing must stay typing.
    const r = rig({ known });
    r.scan("SUGAR", 130);
    expect(r.codes).toEqual([]);
  });

  it("ordinary typing is still never taken for a scan", () => {
    const r = rig({ known, focus: "typing-field" });
    r.scan("411", 220); // human speed, and it IS a real barcode
    expect(r.codes).toEqual([]);
  });
});
