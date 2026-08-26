import { z } from "zod";

/**
 * Longest SKU that still prints cleanly on a 2x2 inch shelf label.
 *
 * A variant with no option values falls back to its SKU for its label, and the
 * label prints "<product name> — <label>" — so an over-long SKU eats into the
 * name block, and on a fixed-height die-cut label whatever overflows is
 * CLIPPED. A clipped SKU on a shelf is indistinguishable from a different SKU,
 * which is why this is refused at entry rather than silently truncated.
 *
 * Derived in apps/admin/src/lib/label-print.ts, where the geometry lives and a
 * test asserts this value still fits one line at the largest name font any
 * stock uses. Duplicated as a literal here only because packages/shared cannot
 * import from an app.
 */
export const MAX_SKU_LENGTH = 24;

/** Human-readable first validation error (with field path when present). */
export function firstIssue(err: z.ZodError): string {
  const i = err.issues[0];
  if (!i) return "Invalid input.";
  const path = i.path.join(".");
  return path ? `${path}: ${i.message}` : i.message;
}

export const uuid = z.string().uuid("must be a valid id");
const optId = z.string().uuid().nullable().optional();
const money = z.number().finite().nonnegative();
const qty = z.number().finite().positive();
const discountType = z.enum(["PERCENT", "FIXED"]).nullable().optional();
export const payMethod = z.enum(["CASH", "JAZZCASH", "EASYPAISA", "UDHAAR", "COD"]);

// ---- POS ----------------------------------------------------------------
export const checkoutSchema = z.object({
  lines: z.array(z.object({
    variant_id: uuid,
    product_id: uuid,
    qty,
    unit_price: money,
    discount: money.optional(),
  })).min(1, "Cart is empty."),
  customer_id: optId,
  customer_name: z.string().max(120).nullable().optional(),
  payments: z.array(z.object({ method: payMethod, amount: z.number().finite() })).min(1, "Add a payment."),
  discount: money.optional(),
  coupon_code: z.string().nullable().optional(),
  idempotency_key: z.string().min(1),
});

export const returnSchema = z.object({
  sale_id: uuid,
  receipt_no: z.string().min(1),
  items: z.array(z.object({
    sale_item_id: uuid,
    product_id: uuid,
    variant_id: uuid.nullable(),
    qty,
    unit_price: money,
    unit_cogs: money,
  })).min(1, "Select at least one item to return."),
  reason: z.string().nullable().optional(),
  refund_method: payMethod,
  customer_id: optId,
  idempotency_key: z.string().min(1),
});

export const customerQuickSchema = z.object({
  name: z.string().trim().min(1, "Name is required."),
  phone: z.string().nullable().optional(),
});

// ---- Stock --------------------------------------------------------------
export const stockInSchema = z.object({
  variant_id: uuid, product_id: uuid, qty, unit_cost: money,
  location_code: z.string().optional(),
  lot_number: z.string().nullable().optional(),
  expiry: z.string().nullable().optional(),
  source: z.enum(["MANUAL", "SCAN"]).optional(),
  note: z.string().optional(),
});

export const adjustSchema = z.object({
  variant_id: uuid, product_id: uuid,
  direction: z.enum(["add", "remove"]),
  qty,
  reason: z.string().min(1, "A reason is required."),
  unit_cost: money.nullable().optional(),
  location_code: z.string().optional(),
});

export const transferSchema = z.object({
  variant_id: uuid, product_id: uuid, qty,
  from_code: z.string().min(1), to_code: z.string().min(1),
  unit_cost: money.nullable().optional(),
});

export const cycleCountSchema = z.object({
  variant_id: uuid, product_id: uuid,
  counted_qty: money,
  current_qty: z.number().finite(),
  unit_cost: money.nullable().optional(),
  location_code: z.string().optional(),
});

// ---- Products -----------------------------------------------------------
export const productInputSchema = z.object({
  name: z.string().trim().min(1, "Product name is required."),
  brand: z.string().nullable().optional(),
  category_id: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  base_unit: z.string().optional(),
  base_price: money,
  has_variants: z.boolean(),
  options: z.array(z.object({ name: z.string(), values: z.array(z.string()) })),
  variants: z.array(z.object({
    sku: z.string().trim().min(1, "SKU is required.")
      .max(MAX_SKU_LENGTH, `SKU must be ${MAX_SKU_LENGTH} characters or fewer so it fits the printed label.`),
    barcode: z.string().nullable().optional(),
    sale_price: money,
    cost: money,
    reorder_point: money,
    default_discount_type: discountType,
    default_discount_value: money.optional(),
    opening_qty: money.nullable().optional(),
    option_values: z.array(z.string()),
  })).min(1, "At least one variant is required."),
});

export const variantPatchSchema = z.object({
  sale_price: money.optional(),
  cost: money.optional(),
  reorder_point: money.optional(),
  default_discount_type: discountType,
  default_discount_value: money.optional(),
  active: z.boolean().optional(),
});

// ---- Storefront checkout ------------------------------------------------
export const placeOrderSchema = z.object({
  items: z.array(z.object({
    variant_id: uuid,
    product_id: uuid,
    qty,
    unit_price: money,
    title: z.string().min(1),
    variant_label: z.string().nullable().optional(),
  })).min(1, "Your bag is empty."),
  customer: z.object({
    name: z.string().trim().min(1, "Please enter your name."),
    phone: z.string().trim().min(7, "Please enter a valid phone number."),
    address: z.string().trim().min(5, "Please enter your delivery address."),
    email: z.union([z.string().email(), z.literal("")]).nullable().optional(),
  }),
  payment_type: z.enum(["COD", "JAZZCASH", "EASYPAISA"]),
  note: z.string().nullable().optional(),
});

export const importRowsSchema = z.array(z.object({
  name: z.string(),
  sku: z.string(),
  barcode: z.string().optional(),
  price: z.number(),
  cost: z.number(),
  qty: z.number(),
})).max(5000, "Import at most 5000 rows at a time.");
