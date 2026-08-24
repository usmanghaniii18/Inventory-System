import { describe, it, expect } from "vitest";
import {
  resolveShortcut, isCharacterKey, SHORTCUT_HELP, RETIRED_KEYS,
  type ShortcutContext, type KeyLike,
} from "./pos-shortcuts";

const idle: ShortcutContext = { inCartEdit: false, inField: false, searchEmpty: true, anyModal: false };
const typing: ShortcutContext = { inCartEdit: false, inField: true, searchEmpty: false, anyModal: false };
const scanBox: ShortcutContext = { inCartEdit: false, inField: true, searchEmpty: true, anyModal: false };
const editing: ShortcutContext = { inCartEdit: true, inField: true, searchEmpty: true, anyModal: false };
const modal: ShortcutContext = { inCartEdit: false, inField: false, searchEmpty: true, anyModal: true };

const k = (key: string, extra: Partial<KeyLike> = {}): KeyLike => ({ key, ...extra });

describe("the four function keys no browser reserves", () => {
  it("maps F2 / F4 / F8 / F9 to their actions", () => {
    expect(resolveShortcut(k("F2"), idle)).toBe("focusScan");
    expect(resolveShortcut(k("F4"), idle)).toBe("checkout");
    expect(resolveShortcut(k("F8"), idle)).toBe("editLine");
    expect(resolveShortcut(k("F9"), idle)).toBe("print");
  });

  it("blocks auto-repeat on F9 so holding it cannot charge twice", () => {
    // The first line of defence against a double charge; the second is the
    // synchronous in-flight ref in PosClient.fastCashCheckout().
    expect(resolveShortcut(k("F9", { repeat: true }), idle)).toBeNull();
    expect(resolveShortcut(k("p", { ctrlKey: true, repeat: true }), idle)).toBeNull();
  });

  it("still fires while the scan box has focus — the normal resting state", () => {
    // The Phase D focus-keeper means an input is focused essentially always, so
    // a shortcut that only worked with focus on <body> would never fire in use.
    expect(resolveShortcut(k("F8"), scanBox)).toBe("editLine");
    expect(resolveShortcut(k("F4"), scanBox)).toBe("checkout");
    expect(resolveShortcut(k("F9"), scanBox)).toBe("print");
  });

  it("still fires while a product name is being typed", () => {
    expect(resolveShortcut(k("F8"), typing)).toBe("editLine");
    expect(resolveShortcut(k("F4"), typing)).toBe("checkout");
  });

  it("still fires while a quantity is being typed in the cart editor", () => {
    expect(resolveShortcut(k("F2"), editing)).toBe("focusScan");
    expect(resolveShortcut(k("F4"), editing)).toBe("checkout");
    expect(resolveShortcut(k("F9"), editing)).toBe("print");
  });

  it("lets print work even with a modal open, so a receipt can be reprinted", () => {
    // The resolver still yields the action; PosClient then declines to run the
    // fast CHARGE while a modal owns the screen and reprints instead.
    expect(resolveShortcut(k("F9"), modal)).toBe("print");
  });
});

describe("keys the browser reserves are no longer bound", () => {
  it("F3 and F6 resolve to a hint, never to an action", () => {
    expect(resolveShortcut(k("F3"), idle)).toBe("legacyEditHint");
    expect(resolveShortcut(k("F6"), idle)).toBe("legacyPrintHint");
  });

  it("names the replacement for each retired key", () => {
    expect(RETIRED_KEYS.F3.replacement).toBe("F8");
    expect(RETIRED_KEYS.F6.replacement).toBe("F9");
  });

  it("leaves reload / fullscreen / devtools entirely alone", () => {
    for (const key of ["F1", "F5", "F7", "F10", "F11", "F12"]) {
      expect(resolveShortcut(k(key), idle)).toBeNull();
    }
  });
});

describe("modifier combinations", () => {
  it("Ctrl+P and Cmd+P print ONLY — they must never charge a sale", () => {
    // F9 charges an uncharged cart as cash. Ctrl+P must not: it reads as
    // "print" to every user, and silently taking cash because the cart happened
    // to be full would be a dangerous surprise with real money.
    expect(resolveShortcut(k("p", { ctrlKey: true }), idle)).toBe("printOnly");
    expect(resolveShortcut(k("P", { ctrlKey: true }), idle)).toBe("printOnly");
    expect(resolveShortcut(k("p", { metaKey: true }), idle)).toBe("printOnly");
    expect(resolveShortcut(k("p", { ctrlKey: true }), idle)).not.toBe("print");
  });

  it("F9 is the only key that maps to the charge-or-print action", () => {
    const chargers = ["F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12"]
      .filter((key) => resolveShortcut(k(key), idle) === "print");
    expect(chargers).toEqual(["F9"]);
  });

  it("Ctrl+Enter checks out — a route that needs no function key at all", () => {
    expect(resolveShortcut(k("Enter", { ctrlKey: true }), idle)).toBe("checkout");
    expect(resolveShortcut(k("Enter", { metaKey: true }), idle)).toBe("checkout");
  });

  it("leaves every other browser combination untouched", () => {
    for (const key of ["t", "n", "w", "r", "f", "s", "l", "j"]) {
      expect(resolveShortcut(k(key, { ctrlKey: true }), idle)).toBeNull();
    }
    expect(resolveShortcut(k("Tab", { altKey: true }), idle)).toBeNull();
    expect(resolveShortcut(k("p", { ctrlKey: true, altKey: true }), idle)).toBeNull();
  });

  it("does not treat a bare Enter as checkout — that belongs to the scan box", () => {
    expect(resolveShortcut(k("Enter"), idle)).toBeNull();
    expect(resolveShortcut(k("Enter"), scanBox)).toBeNull();
    expect(resolveShortcut(k("Enter"), editing)).toBeNull();
  });

  it("does not claim Tab, so the editor's own Enter/Tab flow is unaffected", () => {
    expect(resolveShortcut(k("Tab"), editing)).toBeNull();
    expect(resolveShortcut(k("Tab"), idle)).toBeNull();
  });
});

describe("the cart quantity/discount editor keeps its keys", () => {
  it("swallows digits and +/- so they cannot move the product grid", () => {
    for (const key of ["1", "2", "0", "+", "-", "=", "?", "ArrowDown", "ArrowUp"]) {
      expect(resolveShortcut(k(key), editing)).toBeNull();
    }
  });

  it("Escape cancels the edit", () => {
    expect(resolveShortcut(k("Escape"), editing)).toBe("clearOrCancel");
  });
});

describe("grid navigation and quantity nudging", () => {
  it("arrows move the highlight", () => {
    expect(resolveShortcut(k("ArrowDown"), idle)).toBe("moveNext");
    expect(resolveShortcut(k("ArrowRight"), idle)).toBe("moveNext");
    expect(resolveShortcut(k("ArrowUp"), idle)).toBe("movePrev");
    expect(resolveShortcut(k("ArrowLeft"), idle)).toBe("movePrev");
  });

  it("+/- act on the grid only when the search term is empty", () => {
    expect(resolveShortcut(k("+"), scanBox)).toBe("incQty");
    expect(resolveShortcut(k("-"), scanBox)).toBe("decQty");
    expect(resolveShortcut(k("+"), typing)).toBeNull(); // mid-search, let it type
    expect(resolveShortcut(k("-"), typing)).toBeNull();
  });

  it("numpad * opens the quantity editor, the traditional till key", () => {
    expect(resolveShortcut(k("*", { code: "NumpadMultiply" }), scanBox)).toBe("editLine");
    expect(resolveShortcut(k("*", { code: "NumpadMultiply" }), typing)).toBeNull();
    // the top-row asterisk is a normal character and must stay typeable
    expect(resolveShortcut(k("*", { code: "Digit8", shiftKey: true }), scanBox)).toBeNull();
  });

  it("? opens help only when no field has focus", () => {
    expect(resolveShortcut(k("?"), idle)).toBe("toggleHelp");
    expect(resolveShortcut(k("?"), scanBox)).toBeNull();
  });
});

describe("guards that used to be missing", () => {
  it("ignores auto-repeat for actions, so holding F9 opens ONE print window", () => {
    expect(resolveShortcut(k("F9", { repeat: true }), idle)).toBeNull();
    expect(resolveShortcut(k("F4", { repeat: true }), idle)).toBeNull();
    expect(resolveShortcut(k("F8", { repeat: true }), idle)).toBeNull();
    expect(resolveShortcut(k("Escape", { repeat: true }), idle)).toBeNull();
  });

  it("still allows auto-repeat where holding the key is the point", () => {
    expect(resolveShortcut(k("ArrowDown", { repeat: true }), idle)).toBe("moveNext");
    expect(resolveShortcut(k("+", { repeat: true }), scanBox)).toBe("incQty");
  });

  it("ignores keystrokes mid-IME-composition", () => {
    expect(resolveShortcut(k("F8", { isComposing: true }), idle)).toBeNull();
    expect(resolveShortcut(k("F8", { keyCode: 229 }), idle)).toBeNull();
  });
});

describe("help table", () => {
  it("documents only keys that are actually bound", () => {
    const listed = SHORTCUT_HELP.map((s) => s.keys);
    expect(listed).toContain("F8");
    expect(listed).toContain("F9");
    expect(listed).not.toContain("F3");
    expect(listed).not.toContain("F6");
  });
});

describe("listener-phase split — protects barcode scanning", () => {
  // Characters are handled in the BUBBLE phase so they stay behind the hardware
  // scanner's stopPropagation() shield. Anything routed to CAPTURE runs before
  // the scanner and would see the raw characters of a scanned code.
  it("routes every character a barcode can contain to the bubble phase", () => {
    for (const key of ["0", "9", "A", "z", "-", "+", "=", "_", "*", "?", "/", "."]) {
      expect(isCharacterKey(k(key))).toBe(true);
    }
  });

  it("routes shortcut keys to the capture phase, where nothing can swallow them", () => {
    for (const key of ["F2", "F4", "F8", "F9", "Escape", "Enter", "Tab", "ArrowDown"]) {
      expect(isCharacterKey(k(key))).toBe(false);
    }
  });

  it("routes Ctrl/Cmd combinations to capture even though the key is one char", () => {
    expect(isCharacterKey(k("p", { ctrlKey: true }))).toBe(false);
    expect(isCharacterKey(k("p", { metaKey: true }))).toBe(false);
    expect(isCharacterKey(k("p"))).toBe(true); // a bare "p" is just typing
  });

  it("a hyphenated scan like GRO-SUG-1 never reaches the capture listener", () => {
    // Each hyphen would otherwise resolve to decQty and nudge the highlighted
    // product's quantity once per hyphen.
    for (const ch of "GRO-SUG-1") expect(isCharacterKey(k(ch))).toBe(true);
  });
});
