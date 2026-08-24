// Receipt/invoice data shapes. There is ONE invoice template in the system —
// lib/receipt-html.ts (receiptHtml) — used for both the POS "Sale complete"
// preview and the thermal Print action (all client-side; no server PDF). These
// types describe the data pulled from a sale record that the template renders.

export interface ReceiptItem {
  name: string;
  label?: string;
  qty: number;
  /** Product unit shown next to the qty (e.g. Pcs / Kg). */
  unit?: string | null;
  unit_price: number;
  /** Per-line discount in rupees (off the gross line). */
  discount?: number;
  line_total: number;
}

/**
 * Compose the item name shown on the invoice. A variant label is appended in
 * parentheses (e.g. "Soap (500g)") EXCEPT the synthetic "Default" label used for
 * single-variant products — those just show the bare product name. Display only;
 * no pricing/stock data is involved.
 */
export function receiptItemName(item: Pick<ReceiptItem, "name" | "label">): string {
  const label = item.label?.trim();
  const showLabel = label && label !== "Default";
  return showLabel ? `${item.name} (${label})` : item.name;
}

export interface ReceiptStore {
  name: string;
  address?: string;
  phone?: string;
  logo_url?: string;
  header?: string;
  footer?: string;
  /**
   * Store-set disclaimer printed on every receipt (Phase F). Editable from
   * Settings → Store profile; falls back to DEFAULT_RECEIPT_DISCLAIMER.
   */
  disclaimer?: string;
  ntn?: string;
}

export interface ReceiptData {
  store: ReceiptStore;
  receipt_no: string;
  date: string; // already formatted
  cashier: string;
  customer?: string | null;
  /** Customer address line shown under the name on the invoice. */
  customer_address?: string | null;
  items: ReceiptItem[];
  subtotal: number;
  discount: number;
  tax: number;
  tax_percent: number;
  total: number;
  payments: { method: string; amount: number }[];
  change: number;
}
