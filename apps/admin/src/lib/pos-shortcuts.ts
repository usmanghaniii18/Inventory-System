/**
 * POS keyboard shortcuts — the key map and the decision logic, as one pure
 * module with no React and no DOM.
 *
 * WHY THIS IS SEPARATE
 * --------------------
 * The shortcuts previously lived inline in a `useEffect` whose dependency array
 * included `cart`, `q`, `filtered` and `highlight`. That effect therefore tore
 * the listener down and re-added it on essentially every render, and the whole
 * decision was untestable without a browser. Pulling the decision out means the
 * component keeps ONE permanently-registered listener for the life of the page,
 * and every branch below is covered by unit tests.
 *
 * CHOOSING KEYS THAT ACTUALLY REACH THE PAGE
 * ------------------------------------------
 * Browsers reserve a number of function keys for their own chrome. For those,
 * whether `preventDefault()` suppresses the browser's action is inconsistent
 * across browsers, versions and platforms — so they are unreliable by
 * construction for a till that runs all day, regardless of whether they happen
 * to work in one particular build today.
 *
 *   Reserved / unreliable        Free for an app to use
 *   F1  browser help             F2
 *   F3  find next                F4
 *   F5  reload                   F8
 *   F6  cycle browser panes      F9
 *   F7  caret browsing (Firefox)
 *   F10 menu bar
 *   F11 fullscreen
 *   F12 developer tools
 *
 * So the four actions map onto the four function keys no browser claims:
 * F2, F4, F8 and F9. F3 and F6 are no longer bound to an action; pressing
 * either produces a one-line hint pointing at its replacement, for anyone who
 * learned the old keys.
 */

export type PosAction =
  | "focusScan"
  | "editLine"
  | "checkout"
  /** F9 — charge an uncharged cart as cash and print, else print/reprint. */
  | "print"
  /** Ctrl+P — print/reprint ONLY. Never charges. */
  | "printOnly"
  | "clearOrCancel"
  | "toggleHelp"
  | "moveNext"
  | "movePrev"
  | "incQty"
  | "decQty"
  /** F3 pressed — tell the cashier the key moved to F8. */
  | "legacyEditHint"
  /** F6 pressed — tell the cashier the key moved to F9. */
  | "legacyPrintHint";

export interface ShortcutContext {
  /** Focus is inside a cart line's quantity/discount editor. */
  inCartEdit: boolean;
  /** Focus is in any text field (input / textarea / select / contenteditable). */
  inField: boolean;
  /** The scan/search box is empty, so +/- may act on the product grid. */
  searchEmpty: boolean;
  /** A modal or overlay currently owns the screen. */
  anyModal: boolean;
}

/** The subset of KeyboardEvent the resolver reads — so tests need no DOM. */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** Actions that must not auto-repeat when a key is held down. */
const NO_REPEAT: ReadonlySet<PosAction> = new Set<PosAction>([
  "focusScan", "editLine", "checkout", "print", "printOnly",
  "clearOrCancel", "toggleHelp", "legacyEditHint", "legacyPrintHint",
]);

/**
 * Decide which POS action a keystroke means, or null for "not ours — let it
 * through untouched". Returning an action always implies the caller should
 * preventDefault; returning null always implies it must not.
 */
export function resolveShortcut(e: KeyLike, ctx: ShortcutContext): PosAction | null {
  // Mid-IME composition: keyCode 229 is the universal "still composing" signal
  // that predates isComposing, and both must be ignored or a Urdu/Arabic IME
  // would fire shortcuts while the cashier is still choosing a candidate.
  if (e.isComposing || e.keyCode === 229) return null;

  const action = classify(e, ctx);
  if (action === null) return null;
  // Holding a key down must not, for example, open one print window per repeat.
  if (e.repeat && NO_REPEAT.has(action)) return null;
  return action;
}

function classify(e: KeyLike, ctx: ShortcutContext): PosAction | null {
  // While a quantity/discount is being typed, that editor owns every ordinary
  // key — otherwise digits and +/- would leak out and move the product grid's
  // highlight mid-entry. Escape cancels the edit; function keys still work.
  if (ctx.inCartEdit) {
    if (e.key === "Escape") return "clearOrCancel";
    if (!isFunctionKey(e.key)) return null;
  }

  // ---- Modifier combinations -------------------------------------------
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey) {
    // Ctrl/Cmd+P prints THIS bill rather than the browser's rendering of the
    // page. It is deliberately printOnly, NOT the F9 action: Ctrl+P reads as
    // "print" to everyone, and a key that silently charged a cash sale because
    // the cart happened to be full would be a genuinely dangerous surprise.
    // Charging is F9 and only F9.
    if (e.key === "p" || e.key === "P") return "printOnly";
    // A second, non-function-key route to checkout for keyboards whose F-keys
    // sit behind an Fn toggle (common on compact till keyboards).
    if (e.key === "Enter") return "checkout";
    return null;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return null;

  // ---- Function keys: the four no browser reserves ----------------------
  switch (e.key) {
    case "F2": return "focusScan";
    case "F4": return "checkout";
    case "F8": return "editLine";
    case "F9": return "print";
    // Retired because the browser claims them (find next / cycle panes).
    case "F3": return "legacyEditHint";
    case "F6": return "legacyPrintHint";
    case "Escape": return "clearOrCancel";
  }

  if (ctx.anyModal) return null;

  // Numpad * — the traditional "quantity" key on retail tills. Guarded like
  // +/- so it can still be typed into a non-empty search term.
  if (e.code === "NumpadMultiply" && (!ctx.inField || ctx.searchEmpty)) return "editLine";

  if (e.key === "?" && !ctx.inField) return "toggleHelp";
  if (e.key === "ArrowDown" || e.key === "ArrowRight") return "moveNext";
  if (e.key === "ArrowUp" || e.key === "ArrowLeft") return "movePrev";
  if ((e.key === "+" || e.key === "=") && (!ctx.inField || ctx.searchEmpty)) return "incQty";
  if ((e.key === "-" || e.key === "_") && (!ctx.inField || ctx.searchEmpty)) return "decQty";

  return null;
}

function isFunctionKey(key: string): boolean {
  return /^F([1-9]|1[0-2])$/.test(key);
}

/**
 * Could this keystroke be one character of a barcode burst?
 *
 * This decides WHICH LISTENER PHASE handles a key, and the distinction matters:
 *
 *  - Non-character keys (F-keys, Escape, arrows, Ctrl combos) are handled in the
 *    CAPTURE phase on window — the first position in the event path, so no
 *    modal, focus trap or stopPropagation() downstream can swallow a shortcut.
 *
 *  - Single printable characters are handled in the BUBBLE phase instead, on
 *    purpose. The hardware-scanner listener sits on document in the capture
 *    phase and calls stopPropagation() once it is confident a burst is a scan.
 *    Staying behind that shield is what stops a scanned alphanumeric barcode
 *    such as "GRO-SUG-1" from having each of its hyphens read as the "decrease
 *    quantity" shortcut. Handling these in capture would run them BEFORE the
 *    scanner and reintroduce exactly that bug.
 */
export function isCharacterKey(e: KeyLike): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}

/** One source of truth for the on-screen help dialog and the docs. */
export const SHORTCUT_HELP: { keys: string; label: string }[] = [
  { keys: "F2", label: "Focus the scan / search box" },
  { keys: "F8", label: "Edit quantity + discount of the current line" },
  { keys: "F4", label: "Checkout — pick udhaar / JazzCash / Easypaisa / split" },
  { keys: "F9", label: "Charge as Cash + print — or reprint the last bill" },
  { keys: "Enter", label: "Quantity → Discount → back to scanning" },
  { keys: "Esc", label: "Cancel the edit / clear the sale" },
  { keys: "↑ ↓ ← →", label: "Move the product highlight" },
  { keys: "+ / −", label: "Change the highlighted item's quantity" },
  { keys: "Ctrl + Enter", label: "Checkout (alternative to F4)" },
  { keys: "Ctrl + P", label: "Print / reprint only — never charges" },
  { keys: "?", label: "Show this help" },
];

/** Keys the browser keeps for itself, and what replaced them here. */
export const RETIRED_KEYS: Record<string, { replacement: string; reason: string }> = {
  F3: { replacement: "F8", reason: "the browser uses F3 for Find next" },
  F6: { replacement: "F9", reason: "the browser uses F6 to move between its own panes" },
};
