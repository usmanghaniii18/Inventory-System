// The internal-barcode generator, for scripts that talk to Postgres directly.
//
// This MUST stay byte-for-byte identical in output to apps/admin/src/lib/
// barcode.ts, which is what the app itself (assignInternalBarcode) uses. A
// script that minted codes by a slightly different rule would quietly create a
// second numbering scheme in the same column.
//
// The guarantee is enforced, not assumed: apps/admin/src/lib/barcode.parity.
// test.ts imports BOTH this module and the TypeScript one and asserts they
// agree across the whole usable range. If either drifts, that test fails.

/** EAN-13 check digit for the first 12 digits. */
export function ean13Check(d12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

function pad(n, len) {
  return String(n).replace(/\D/g, "").padStart(len, "0").slice(-len);
}

export const MAX_INTERNAL_SEQ = 9_999_999_999;
export const MAX_WEIGHT_ITEM_REF = 99_999;

/** Plain internal EAN-13 (prefix "29") for an item with no manufacturer code. */
export function generateInternalEan13(seq, prefix = "29") {
  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_INTERNAL_SEQ) {
    throw new RangeError(`internal barcode seq ${seq} does not fit the 10-digit field`);
  }
  const d12 = `${prefix}${pad(seq, 10)}`;
  return d12 + ean13Check(d12);
}

/** Weight-template EAN-13 (value field zeroed) for a variable-weight variant. */
export function generateWeightTemplateEan13(itemRef, prefix = "20") {
  if (!Number.isInteger(itemRef) || itemRef < 0 || itemRef > MAX_WEIGHT_ITEM_REF) {
    throw new RangeError(
      `weight item ref ${itemRef} does not fit the 5-digit field (0-${MAX_WEIGHT_ITEM_REF})`,
    );
  }
  const d12 = `${prefix}${pad(itemRef, 5)}00000`;
  return d12 + ean13Check(d12);
}
