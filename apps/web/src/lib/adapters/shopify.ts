import { createHmac, timingSafeEqual } from "node:crypto";
import type { NormalizedEvent, NormalizedOrder, PlatformAdapter } from "./types";
import { toMinor } from "./types";

/**
 * Shopify adapter (prepared, not active). Maps the Admin API order webhook (orders/create, orders/updated,
 * orders/cancelled, refunds/create via the order) to LINKUP's format, and verifies X-Shopify-Hmac-Sha256.
 * Needs to be confirmed end to end on a Shopify development store before it is offered to stores.
 */
type Money = { shop_money?: { amount?: string } };
type ShopifyOrder = {
  id?: number | string; currency?: string; total_price?: string; total_tax?: string;
  total_shipping_price_set?: Money; shipping_lines?: { tax_lines?: { price?: string }[] }[];
  discount_codes?: { code?: string }[]; note_attributes?: { name?: string; value?: string }[];
  financial_status?: string; fulfillment_status?: string | null; cancelled_at?: string | null;
  created_at?: string; updated_at?: string; email?: string | null;
  refunds?: { id?: number | string; transactions?: { kind?: string; status?: string; amount?: string }[] }[];
};

export function verifyShopifyWebhook(raw: string, hmacBase64: string | undefined, secret: string): boolean {
  if (!hmacBase64 || !secret) return false;
  const want = createHmac("sha256", secret).update(raw, "utf8").digest();
  let got: Buffer;
  try { got = Buffer.from(hmacBase64, "base64"); } catch { return false; }
  return got.length === want.length && timingSafeEqual(got, want);
}

function status(o: ShopifyOrder): NormalizedOrder["status"] {
  if (o.cancelled_at || o.financial_status === "voided") return "cancelled";
  if (o.financial_status === "refunded") return "refunded";
  if (o.fulfillment_status === "fulfilled" && ["paid", "partially_refunded"].includes(o.financial_status ?? "")) return "completed";
  if (["paid", "partially_refunded"].includes(o.financial_status ?? "")) return "processing";
  return "pending";   // pending / authorized / partially_paid: no commission until paid
}

export function shopifyOrderToEvent(o: ShopifyOrder, topic = "orders/updated", emailHashHex = ""): NormalizedEvent | null {
  if (o?.id == null || !o.currency) return null;
  const cur = o.currency.toUpperCase();
  const refAttr = (o.note_attributes ?? []).find((a) => a.name === "linkup_ref")?.value ?? "";
  const order: NormalizedOrder = {
    id: String(o.id), status: status(o), currency: cur,
    total: toMinor(o.total_price, cur), tax: toMinor(o.total_tax, cur),
    shipping: toMinor(o.total_shipping_price_set?.shop_money?.amount, cur),
    shipping_tax: (o.shipping_lines ?? []).flatMap((l) => l.tax_lines ?? []).reduce((s, t) => s + toMinor(t.price, cur), 0),
    coupons: (o.discount_codes ?? []).map((d) => String(d.code ?? "")).filter(Boolean),
    ref: /^[A-Za-z0-9]{4,16}\|\d{9,11}$/.test(refAttr) ? refAttr : "",
    email_hash: emailHashHex, created_at: o.created_at ?? o.updated_at ?? new Date().toISOString(),
    refunds: (o.refunds ?? []).map((r) => ({
      id: String(r.id), amount: (r.transactions ?? []).filter((t) => t.kind === "refund" && t.status === "success").reduce((s, t) => s + toMinor(t.amount, cur), 0),
    })).filter((r) => r.amount > 0),
  };
  const at = o.updated_at ?? o.created_at ?? new Date().toISOString();
  return { event_id: `shopify:${order.id}:${topic}:${at}:${order.refunds.length}`, type: `order.${topic.replace("/", ".")}`, occurred_at: at, order };
}

export const shopifyAdapter: PlatformAdapter = {
  platform: "shopify",
  verify: (raw, h, secret) => verifyShopifyWebhook(raw, h["x-shopify-hmac-sha256"], secret),
  toEvent: (p, m) => shopifyOrderToEvent(p as ShopifyOrder, m.topic),
};
