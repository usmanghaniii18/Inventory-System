/**
 * The F8 quantity/discount decision for a cart line, as one pure module with no
 * React and no DOM — the same split as pos-shortcuts.ts, and for the same
 * reason: this is the logic that decides what a customer is charged, so every
 * branch of it should be covered by a unit test rather than only reachable
 * through a browser.
 *
 * WHAT WAS WRONG
 * --------------
 * commitQty() used to do:
 *
 *     const capped = Math.min(n, entry.p.available);
 *     if (capped < n) flash(false, `Only ${entry.p.available} in stock`);
 *     setQty(editing.id, capped);          // <- a DIFFERENT number than typed
 *
 * so typing 10 with 3 on hand silently billed 3 and advanced to the discount
 * step as though it had worked. The only signal was a flash message that clears
 * itself after 2.2s — which a cashier mid-flow is typing straight past. That is
 * the "quantity added does not match what was typed" report, and it is also why
 * there was no stock validation: the clamp had REPLACED the validation.
 *
 * The discount path was worse still: clampDisc() reduced an over-large discount
 * to the line gross with no message at all.
 *
 * WHAT IT DOES NOW
 * ----------------
 * Nothing is ever silently substituted. A quantity that exceeds stock, or a
 * discount that exceeds the line, is REFUSED and reported, and the caller keeps
 * the editor open on the offending field so the cashier can correct it. What is
 * accepted is exactly what was typed.
 */

/** Outcome of committing the quantity box. */
export type QtyEdit =
  /** Box left blank — keep the line's current quantity and move on. */
  | { kind: "unchanged" }
  /** Zero typed — the cashier is removing the line. */
  | { kind: "remove" }
  /** Accepted, exactly as typed. */
  | { kind: "set"; qty: number }
  /** Not a usable number (letters, negative). */
  | { kind: "invalid" }
  /** More than exists. REFUSED — nothing is applied. */
  | { kind: "overstock"; typed: number; available: number };

/** Outcome of committing the discount box. */
export type DiscountEdit =
  /** Blank or zero — remove any discount on this line. */
  | { kind: "clear" }
  /** Accepted, exactly as typed (rounded to paisa). */
  | { kind: "set"; discount: number }
  /** Not a usable number (letters, negative). */
  | { kind: "invalid" }
  /** More than the line is worth. REFUSED — nothing is applied. */
  | { kind: "exceedsLine"; typed: number; max: number };

/** Round to paisa. Money never carries more precision than this. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Decide what the typed quantity means for a line.
 *
 * `available` must be the LIVE on-hand figure, not the snapshot frozen into the
 * cart entry when the item was added — a resumed held sale carries a snapshot
 * that can be days old, and refusing a sale against stock that has since been
 * replenished would be a worse bug than the one this replaces.
 */
export function resolveQtyEdit(raw: string, currentQty: number, available: number): QtyEdit {
  const text = raw.trim();
  if (text === "") return { kind: "unchanged" };

  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return { kind: "invalid" };
  if (n === 0) return { kind: "remove" };

  // Only the INCREASE has to be covered by stock. Leaving a line at, or
  // reducing it to, a quantity it already holds must stay possible even after
  // stock has moved underneath it — otherwise a cashier could be locked out of
  // correcting a line downwards, which is the one edit that always helps.
  if (n > available && n > currentQty) {
    return { kind: "overstock", typed: n, available };
  }
  return { kind: "set", qty: n };
}

/**
 * Decide what the typed discount means for a line.
 *
 * `lineGross` is qty x unit price for the line AFTER the quantity edit above has
 * been applied, so the ceiling reflects what the cashier is actually looking at.
 */
export function resolveDiscountEdit(raw: string, lineGross: number): DiscountEdit {
  const text = raw.trim();
  if (text === "") return { kind: "clear" };

  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return { kind: "invalid" };
  if (n === 0) return { kind: "clear" };

  const max = round2(lineGross);
  // Compared at paisa precision so a discount typed as the exact line total is
  // accepted rather than refused by a floating-point hair.
  if (round2(n) > max) return { kind: "exceedsLine", typed: n, max };
  return { kind: "set", discount: round2(n) };
}

/** Quantity formatted for a message: whole numbers stay whole, weights keep 3dp. */
export function formatQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}
