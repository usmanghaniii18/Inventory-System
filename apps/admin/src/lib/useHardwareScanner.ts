"use client";

import { useEffect, useRef } from "react";

// Global hardware-scanner capture for USB/Bluetooth keyboard-wedge scanners.
//
// A wedge scanner "types" the barcode as a very fast keystroke burst, usually
// ending in Enter (sometimes Tab, sometimes nothing). We tell a scan apart from
// human typing purely by TIMING: the characters of one barcode arrive only a few
// ms apart — far faster, and far more evenly, than any person types.
//
//   • capture keydown at the document level (capture phase, before React),
//   • accumulate characters; a gap > NEW_SEQUENCE_GAP starts a fresh sequence,
//   • on Enter/Tab (or after FLUSH_IDLE_MS of silence) decide by the AVERAGE
//     inter-key time whether the buffer was a scan, and if so route it.
//
// Using the average (not a hard per-key cutoff) makes it tolerant of a scanner
// that runs a little slower or jitters, while still rejecting human typing.
//
// It works EVEN when a text input is focused: characters arriving at machine
// speed are consumed (preventDefault) so they don't land in the field; the few
// that may leak in before we're sure are stripped back out on flush. The cashier
// never has to click off a field. Dedicated barcode boxes opt out via
// `data-scan-input` so a scan there fills the field as intended.
//
// The decision itself lives in createScanDetector() below — a pure state
// machine with the clock, the focus state and the timers injected. That is what
// makes it testable without a scanner or a browser: the simulation tests drive
// it with exactly the keystroke timings real hardware produces.

// Timing thresholds. These were tightened around one fast scanner and, in the
// shop, a slower/jittery wedge routinely missed the AVG_GAP_MS cut — the burst
// was then treated as typing and, with nothing focused, dropped on the floor
// (the "press F2 first" symptom). A human sustains roughly 120-250ms between
// keystrokes, so there is a wide safety band above the old 55ms: 90ms still
// rejects typing comfortably while accepting a much broader range of hardware.
const CONSUME_GAP_MS = 80; // keep a key out of a focused field if it arrives this fast
const AVG_GAP_MS = 90; // a buffer whose mean inter-key gap is <= this is a scan
// A long, uniform, all-digit burst is accepted a bit slower still: nobody hand-
// types 8+ digits at a steady <=140ms/key, and if they somehow do, the code
// resolves through exactly the same lookup, so the outcome is identical.
const SLOW_DIGIT_GAP_MS = 140;
const SLOW_DIGIT_MIN_LENGTH = 8;
const NEW_SEQUENCE_GAP_MS = 250; // a longer pause starts a brand-new sequence
const FLUSH_IDLE_MS = 140; // flush a buffered burst this long after the last key
// Length below which a burst needs corroboration before it counts as a scan.
// The original comment here read "real barcodes are >=8 digits" — true of
// manufacturer EANs, and false of this shop: an audit of the live catalogue
// found 794 of 2335 barcodes (34%), covering 758 active sellable variants,
// shorter than this. They are hand-entered shelf codes like "3DX", "09F",
// "411". The printed labels are perfectly good Code-128; it was this threshold
// alone that made them unscannable.
const MIN_SCAN_LENGTH = 6;
// A shorter burst is accepted ONLY when it is, exactly, a barcode the
// catalogue already knows (see SHORT-BURST RULE on looksLikeScan). One
// character is never enough: a single keystroke carries no timing evidence at
// all — avgGap() is 0 for it, which would read as infinitely fast.
const SHORT_SCAN_MIN_LENGTH = 2;
// Duplicate suppression, measured as the QUIET GAP between the end of one burst
// and the start of the next — not flush-to-flush as before. That old measure
// scaled with the length of the code, so for a 13-digit barcode a 300ms window
// swallowed a DELIBERATE second scan of the same item (the everyday "customer
// is buying two of these" case), which read to the cashier as "it needed
// several tries". A scanner echoing one trigger pull re-fires within a few tens
// of ms; a person repositioning and pulling the trigger again takes far longer.
const DEDUP_GAP_MS = 250;
/**
 * How late a timer may run before we treat it as a BLOCKED PAGE rather than as
 * the silence it was scheduled to detect. Browsers routinely run timers a few
 * ms late under no load at all; tens of ms late means something occupied the
 * thread, and during that time the scanner's keys were queueing, not absent.
 */
const STALL_SLACK_MS = 50;

/** Strip CR/LF/Tab and surrounding whitespace the scanner may add. */
export function normalizeScan(raw: string): string {
  return raw.replace(/[\r\n\t]+/g, "").trim();
}

function debugOn(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem("scanDebug") === "1";
  } catch {
    return false;
  }
}

// ---- Pure detector --------------------------------------------------------

/** The minimum of a KeyboardEvent the detector needs. */
export interface ScanKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /**
   * When the BROWSER created the event, on the same time origin as
   * performance.now(). This is the scanner's own timing, and it is not the same
   * thing as when this handler got to run — see stampOf().
   */
  timeStamp?: number;
  preventDefault(): void;
  stopPropagation(): void;
}

/** What currently has keyboard focus, as far as the detector cares. */
export type FocusKind =
  /** A field that should RECEIVE the scan itself (barcode box / variant picker). */
  | "scan-target"
  /** Any other text input — characters can land in it, so leaks need cleaning. */
  | "typing-field"
  /** A button, the body, nothing — characters have nowhere to go. */
  | "none";

export interface ScanDetectorHost {
  now(): number;
  focus(): FocusKind;
  /** Remove characters that leaked into the focused field before we were sure. */
  stripLeaked(leaked: string): void;
  /**
   * Is this string EXACTLY a barcode in the catalogue? Exact equality only —
   * never a prefix, substring or fuzzy match. It is what lets a burst too
   * short to judge on timing alone be accepted, so the discipline has to be
   * the same one the resolve path uses: match exactly or do not match.
   *
   * Omitted (or false) simply means short bursts are never accepted, which is
   * the behaviour that existed before.
   */
  isKnownCode?(code: string): boolean;
  onScan(code: string): void;
  /**
   * A burst that carried machine-speed keystrokes but could NOT be read as a
   * whole code (jitter split it, or a stall wiped the buffer mid-scan). The
   * partial characters have been cleaned out of the field and the terminating
   * Enter swallowed, so nothing downstream can act on the fragment. The host
   * should tell the cashier to scan again.
   */
  onPartial?(fragment: string): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  debug?: boolean;
}

export interface ScanDetector {
  handleKeyDown(e: ScanKeyEvent): void;
  reset(): void;
}

/**
 * The wedge-scanner state machine, with every environment dependency injected.
 * Behaviour is identical to what ran inline in the hook before; pulling it out
 * is what lets the simulation tests reproduce real scanner timings exactly.
 */
export function createScanDetector(host: ScanDetectorHost): ScanDetector {
  const debug = () => host.debug ?? debugOn();

  /**
   * When the scanner sent this key — NOT when we got round to handling it.
   *
   * This distinction is the whole of one bug. Every gap in here is meant to
   * describe the SCANNER's rhythm, but reading the clock inside the handler
   * measures the browser's DISPATCH rhythm instead, and the two come apart the
   * moment the main thread is busy. A catalogue refresh landing mid-burst
   * re-renders the till's product grid; the keydowns the scanner already sent
   * sit in the queue meanwhile and are delivered in a clump the instant the
   * thread frees. Measured on the handler clock that clump looks like a long
   * pause followed by a fresh burst, so the characters buffered before the
   * stall were discarded as a stale sequence and the REMAINDER was flushed as
   * if it were a whole code: "8961100001019" reached the till as
   * "961100001019" and was reported as an unknown code.
   *
   * KeyboardEvent.timeStamp is stamped when the event is CREATED and shares
   * performance.now()'s time origin, so a queued burst keeps its real 5ms gaps
   * however long the page was blocked. That makes the detector immune to page
   * stalls rather than merely less likely to trip over them.
   *
   * Falls back to the handler clock whenever the stamp is missing or on some
   * other epoch (synthetic events, older engines): a stamp is only trusted when
   * it is finite, positive and lands in the recent past on our own clock.
   */
  const stampOf = (e: ScanKeyEvent): number => {
    const t = e.timeStamp;
    const n = host.now();
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) return n;
    // Must be on our clock: at most a hair in the future, at most a minute old.
    return t <= n + 1 && t > n - 60_000 ? t : n;
  };

  let buffer = "";
  let firstTs = 0; // timestamp of the first char in the buffer
  let lastTs = 0; // timestamp of the most recent char
  let leaked = ""; // chars that landed in a focused field this burst
  // True once a key in THIS burst arrived at machine speed. It is what tells a
  // half-read scan apart from a person typing: a fragment left behind by a
  // broken burst must never be allowed to reach a search box, whereas typed
  // text must be left completely alone.
  let sawMachineSpeed = false;
  let timer: unknown = null;
  let lastCode = "";
  let lastFlushAt = 0; // when the previous accepted burst ENDED

  const reset = () => {
    buffer = "";
    leaked = "";
    sawMachineSpeed = false;
    firstTs = 0;
    lastTs = 0;
    if (timer !== null) { host.clearTimer(timer); timer = null; }
  };

  // Mean gap between keys; 0 for a single char (treated as fast).
  const avgGap = () => (buffer.length > 1 ? (lastTs - firstTs) / (buffer.length - 1) : 0);
  /**
   * Is the buffered burst a scan?
   *
   * `terminated` is true only on an explicit Enter/Tab from the scanner, and
   * false on the idle-flush timer.
   *
   * SHORT-BURST RULE
   * ----------------
   * A burst under MIN_SCAN_LENGTH carries too little timing evidence to judge
   * on speed alone, so it must clear three independent bars at once:
   *
   *   1. it ENDED IN A TERMINATOR. Wedge scanners send Enter; the idle-flush
   *      path is excluded outright, because a cashier typing "3DXY" pauses
   *      after "3DX" often enough that flushing on silence would bill an item
   *      mid-word.
   *   2. it arrived at MACHINE SPEED, the same mean-gap bar as any other scan.
   *   3. it is EXACTLY a barcode the catalogue knows — not a prefix, not a
   *      substring, not a fuzzy match. This is the same exact-match discipline
   *      the resolve path uses, and for the same reason: guessing is what put
   *      the wrong product on a bill.
   *
   * Three-of-three keeps ordinary fast typing safe. A term that does clear all
   * three IS a barcode, and typing a barcode into the scan box and pressing
   * Enter already added that product anyway — so the outcome is unchanged, the
   * cashier just does not have to reach for Enter.
   *
   * WHY THE SLOW ALLOWANCE IS NOT LENGTH-GATED ANY MORE
   * ---------------------------------------------------
   * It used to be. A burst of 8+ digits was allowed up to SLOW_DIGIT_GAP_MS,
   * and everything shorter had to clear AVG_GAP_MS or be thrown away. That
   * turned one scanner's speed into a rule about WHICH PRODUCTS scan: on a
   * wedge whose mean gap sits between the two bars — a very ordinary speed for
   * a cheap or jittery unit — every 12/13-digit manufacturer EAN read fine and
   * every one of this shop's own shorter codes was refused, every time, on
   * perfectly good labels. 841 of the 2,222 live codes are under 8 characters,
   * so that split the catalogue almost in half along a line the cashier could
   * see ("bought-in barcodes work, ours don't") and no amount of reprinting
   * could fix, because nothing was wrong with the print.
   *
   * The slow allowance now applies at any length, but a burst that uses it must
   * be EXACTLY a barcode the catalogue holds. That corroboration is what keeps
   * it safe: the outcome of a false positive is the product the typed digits
   * name, which is what pressing Enter on those digits does anyway.
   */
  const looksLikeScan = (terminated: boolean) => {
    const mean = avgGap();
    if (buffer.length >= MIN_SCAN_LENGTH && mean <= AVG_GAP_MS) return true;
    // A long, uniform, all-digit burst needs no corroboration: nobody hand-types
    // 8+ digits at a steady <=140ms/key.
    if (buffer.length >= SLOW_DIGIT_MIN_LENGTH && mean <= SLOW_DIGIT_GAP_MS && /^\d+$/.test(buffer)) return true;
    if (!terminated) return false;
    if (buffer.length < SHORT_SCAN_MIN_LENGTH) return false;
    if (mean > SLOW_DIGIT_GAP_MS) return false;
    return host.isKnownCode?.(normalizeScan(buffer)) === true;
  };

  /**
   * Drop a burst we cannot read as a code, WITHOUT leaving debris behind.
   *
   * This is the fix for the wrong-product bug: previously a jittery wedge scan
   * (some keys fast enough to be consumed, some slow enough to land in the
   * field) was simply reset — leaving a random SUBSET of the barcode's digits
   * sitting in the POS search box, and letting the scanner's Enter through to
   * the box's submit handler, which then matched that fragment against the
   * catalogue and billed an arbitrary product. Now the fragment is stripped and
   * the caller is told, so the cashier is asked to scan again instead.
   *
   * Returns true when the burst was a real (broken) scan, meaning the caller
   * must also swallow the terminating key.
   */
  const abandon = (): boolean => {
    const fragment = leaked;
    const wasScan = sawMachineSpeed && buffer.length > 1;
    reset();
    // Only ever touch the field when this really was a machine burst. A person
    // typing produces no machine-speed keys, so their text is never disturbed —
    // which is why the strip is gated on wasScan and not simply on `leaked`.
    if (!wasScan) return false;
    if (fragment) host.stripLeaked(fragment);
    if (debug()) console.info("[scan] partial burst discarded", { fragment });
    host.onPartial?.(fragment);
    return true;
  };

  const flush = (at: number = host.now()) => {
    const raw = buffer;
    const hadLeak = leaked;
    const mean = avgGap();
    const startedAt = firstTs;
    reset();
    const code = normalizeScan(raw);
    if (!code) return;
    // Dedup compares against the scanner's own clock, so the moment the burst
    // ENDED has to come from the same clock the gaps did.
    const now = at;
    host.stripLeaked(hadLeak); // clean the field even if we end up deduping
    const quietGap = startedAt - lastFlushAt;
    if (code === lastCode && lastFlushAt > 0 && quietGap < DEDUP_GAP_MS) {
      if (debug()) console.info("[scan] dedup ignored", { code, quietGapMs: Math.round(quietGap) });
      lastFlushAt = now;
      return;
    }
    lastCode = code;
    lastFlushAt = now;
    if (debug()) console.info("[scan] ✓ scan", { raw, normalized: code, len: code.length, avgGapMs: Math.round(mean) });
    host.onScan(code);
  };

  /**
   * The idle flush exists to close a burst the scanner ended without a
   * terminator. It has to be able to tell SILENCE from a BLOCKED PAGE.
   *
   * A timer is not evidence that nothing happened — it is evidence that the
   * thread got round to us. When the main thread is busy the callback runs late
   * and the keys that arrived during the block are still queued behind it, so
   * firing on that late tick would cut a burst in half and flush the front of a
   * barcode as though it were the whole code. The deadline is therefore checked
   * on arrival: if we are meaningfully past it, the silence was never observed
   * and the wait simply starts again.
   */
  const scheduleIdleFlush = () => {
    if (timer !== null) host.clearTimer(timer);
    const deadline = host.now() + FLUSH_IDLE_MS;
    timer = host.setTimer(() => {
      timer = null;
      if (host.now() > deadline + STALL_SLACK_MS) {
        if (debug()) console.info("[scan] idle flush ran late — page was blocked, waiting again");
        scheduleIdleFlush();
        return;
      }
      // Idle flush: no terminator arrived, so a short burst can never qualify.
      if (looksLikeScan(false)) flush();
      else abandon();
    }, FLUSH_IDLE_MS);
  };

  function handleKeyDown(e: ScanKeyEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Let dedicated barcode/variant fields capture the scan themselves.
    if (host.focus() === "scan-target") { reset(); return; }

    // The SCANNER's clock, not the handler's — see stampOf().
    const now = stampOf(e);

    // Terminators — a wedge scanner usually ends the burst with Enter (or Tab).
    if (e.key === "Enter" || e.key === "Tab") {
      if (looksLikeScan(true)) {
        e.preventDefault();
        e.stopPropagation();
        flush(now);
      } else {
        if (debug() && buffer.length >= SHORT_SCAN_MIN_LENGTH) {
          console.info("[scan] ignored (looks like typing)", { buffer, len: buffer.length, avgGapMs: Math.round(avgGap()) });
        }
        // A half-read scan must not fall through to the field's Enter handler
        // with a fragment of the code still in it.
        if (abandon()) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
      return;
    }

    if (e.key.length !== 1) return; // Shift / arrows / F-keys etc.

    const gap = buffer === "" ? Infinity : now - lastTs;
    if (gap > NEW_SEQUENCE_GAP_MS) {
      // Long pause → this is the start of a new sequence. If the sequence being
      // abandoned was itself a machine burst, clean its characters out of the
      // field first — otherwise a stall mid-scan silently leaves the first half
      // of a barcode in the search box for the second half to be appended to.
      abandon();
      firstTs = now;
    }
    if (buffer === "") firstTs = now;
    lastTs = now;

    const machineSpeed = buffer !== "" && gap <= CONSUME_GAP_MS;
    buffer += e.key;
    if (machineSpeed) sawMachineSpeed = true;
    if (machineSpeed) {
      // Confident this is a scan in progress → keep it out of any focused field.
      e.preventDefault();
      e.stopPropagation();
    } else if (host.focus() === "typing-field") {
      // Might be a person typing; let it land for now (cleaned up if it flushes).
      leaked += e.key;
    }
    if (debug()) console.debug("[scan] key", { key: e.key, gapMs: gap === Infinity ? "∞" : Math.round(gap), buffer });
    scheduleIdleFlush();
  }

  return { handleKeyDown, reset };
}

// ---- Browser wiring -------------------------------------------------------

/** A field that should RECEIVE the scan itself (barcode box / variant picker). */
function isScanTarget(el: Element | null): boolean {
  return !!el && typeof (el as HTMLElement).hasAttribute === "function" && (el as HTMLElement).hasAttribute("data-scan-input");
}

function isTypingField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
}

/** React-aware value setter so controlled inputs see a programmatic change. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Remove characters that leaked into a focused field before we detected the burst. */
function stripLeakedFromDom(leaked: string) {
  if (!leaked) return;
  const el = document.activeElement;
  if (!isTypingField(el)) return;
  const input = el as HTMLInputElement;
  if (input.value.endsWith(leaked)) {
    setNativeValue(input, input.value.slice(0, input.value.length - leaked.length));
  }
}

export function useHardwareScanner(
  onScan: (code: string) => void,
  opts: {
    enabled?: boolean;
    onPartial?: (fragment: string) => void;
    /** Exact-equality catalogue membership test — see ScanDetectorHost. */
    isKnownCode?: (code: string) => boolean;
  } = {},
) {
  const { enabled = true } = opts;
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const onPartialRef = useRef(opts.onPartial);
  onPartialRef.current = opts.onPartial;
  const isKnownCodeRef = useRef(opts.isKnownCode);
  isKnownCodeRef.current = opts.isKnownCode;

  useEffect(() => {
    if (!enabled) return;

    const detector = createScanDetector({
      now: () => performance.now(),
      focus: () => {
        const el = document.activeElement;
        if (isScanTarget(el)) return "scan-target";
        return isTypingField(el) ? "typing-field" : "none";
      },
      stripLeaked: stripLeakedFromDom,
      onScan: (code) => onScanRef.current(code),
      onPartial: (fragment) => onPartialRef.current?.(fragment),
      isKnownCode: (code) => isKnownCodeRef.current?.(code) === true,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    });

    const onKeyDown = (e: KeyboardEvent) => detector.handleKeyDown(e);

    document.addEventListener("keydown", onKeyDown, true);
    if (debugOn()) console.info("[scan] hardware listener attached");
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      detector.reset();
    };
  }, [enabled]);
}
