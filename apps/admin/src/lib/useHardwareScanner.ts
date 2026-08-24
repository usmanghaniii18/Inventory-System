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
const MIN_SCAN_LENGTH = 6; // real barcodes are >=8 digits; 6 keeps fast-typed numbers safe
// Duplicate suppression, measured as the QUIET GAP between the end of one burst
// and the start of the next — not flush-to-flush as before. That old measure
// scaled with the length of the code, so for a 13-digit barcode a 300ms window
// swallowed a DELIBERATE second scan of the same item (the everyday "customer
// is buying two of these" case), which read to the cashier as "it needed
// several tries". A scanner echoing one trigger pull re-fires within a few tens
// of ms; a person repositioning and pulling the trigger again takes far longer.
const DEDUP_GAP_MS = 250;

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
  onScan(code: string): void;
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

  let buffer = "";
  let firstTs = 0; // timestamp of the first char in the buffer
  let lastTs = 0; // timestamp of the most recent char
  let leaked = ""; // chars that landed in a focused field this burst
  let timer: unknown = null;
  let lastCode = "";
  let lastFlushAt = 0; // when the previous accepted burst ENDED

  const reset = () => {
    buffer = "";
    leaked = "";
    firstTs = 0;
    lastTs = 0;
    if (timer !== null) { host.clearTimer(timer); timer = null; }
  };

  // Mean gap between keys; 0 for a single char (treated as fast).
  const avgGap = () => (buffer.length > 1 ? (lastTs - firstTs) / (buffer.length - 1) : 0);
  const looksLikeScan = () => {
    if (buffer.length < MIN_SCAN_LENGTH) return false;
    const mean = avgGap();
    if (mean <= AVG_GAP_MS) return true;
    return buffer.length >= SLOW_DIGIT_MIN_LENGTH && mean <= SLOW_DIGIT_GAP_MS && /^\d+$/.test(buffer);
  };

  const flush = () => {
    const raw = buffer;
    const hadLeak = leaked;
    const mean = avgGap();
    const startedAt = firstTs;
    reset();
    const code = normalizeScan(raw);
    if (!code) return;
    const now = host.now();
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

  const scheduleIdleFlush = () => {
    if (timer !== null) host.clearTimer(timer);
    timer = host.setTimer(() => {
      timer = null;
      if (looksLikeScan()) flush();
      else reset();
    }, FLUSH_IDLE_MS);
  };

  function handleKeyDown(e: ScanKeyEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Let dedicated barcode/variant fields capture the scan themselves.
    if (host.focus() === "scan-target") { reset(); return; }

    const now = host.now();

    // Terminators — a wedge scanner usually ends the burst with Enter (or Tab).
    if (e.key === "Enter" || e.key === "Tab") {
      if (looksLikeScan()) {
        e.preventDefault();
        e.stopPropagation();
        flush();
      } else {
        if (debug() && buffer.length >= MIN_SCAN_LENGTH) {
          console.info("[scan] ignored (looks like typing)", { buffer, len: buffer.length, avgGapMs: Math.round(avgGap()) });
        }
        reset();
      }
      return;
    }

    if (e.key.length !== 1) return; // Shift / arrows / F-keys etc.

    const gap = buffer === "" ? Infinity : now - lastTs;
    if (gap > NEW_SEQUENCE_GAP_MS) {
      // Long pause → this is the start of a new sequence.
      buffer = "";
      leaked = "";
      firstTs = now;
    }
    if (buffer === "") firstTs = now;
    lastTs = now;

    const machineSpeed = buffer !== "" && gap <= CONSUME_GAP_MS;
    buffer += e.key;
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
  opts: { enabled?: boolean } = {},
) {
  const { enabled = true } = opts;
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

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
