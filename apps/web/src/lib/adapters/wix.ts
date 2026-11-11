import { createVerify } from "node:crypto";
import type { NormalizedEvent, NormalizedOrder, PlatformAdapter } from "./types";
import { toMinor } from "./types";

/**
 * Wix adapter (prepared, not active). Wix sends each webhook as a JWT (RS256) signed by Wix; the payload carries the
 * event, whose data holds the eCommerce order. Maps order_created / order_approved / order_canceled (+ payment status).
 * Partial refund amounts need Wix's refunds data – to be confirmed on a Wix developer site before it is offered.
 */
type WixOrder = {
  id?: string; number?: string | number; currency?: string; status?: string; paymentStatus?: string; fulfillmentStatus?: string;
  priceSummary?: { total?: { amount?: string }; tax?: { amount?: string }; shipping?: { amount?: string } };
  appliedDiscounts?: { coupon?: { code?: string } }[]; createdDate?: string; updatedDate?: string;
};

const b64u = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
/** Verifies the JWT signature with the app's public key (PEM) and returns its payload, or null. */
export function verifyWixJwt(jwt: string, publicKeyPem: string): Record<string, unknown> | null {
  const parts = jwt.trim().split(".");
  if (parts.length !== 3 || !publicKeyPem) return null;
  try {
    const header = JSON.parse(b64u(parts[0]!).toString("utf8")) as { alg?: string };
    if (header.alg !== "RS256") return null;
    const v = createVerify("RSA-SHA256"); v.update(`${parts[0]}.${parts[1]}`);
    if (!v.verify(publicKeyPem, b64u(parts[2]!))) return null;
    return JSON.parse(b64u(parts[1]!).toString("utf8"));
  } catch { return null; }
}
/** Wix nests JSON as strings at several levels; unwraps until the order object is found. */
export function wixOrderFromPayload(p: unknown): { order: WixOrder; eventType: string } | null {
  const parse = (x: unknown) => { if (typeof x === "string") { try { return JSON.parse(x); } catch { return null; } } return x; };
  let cur: any = parse(p); let eventType = "";
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    eventType ||= String(cur.eventType ?? "");
    if (cur.order && typeof cur.order === "object") return { order: cur.order, eventType };
    if (cur.priceSummary && cur.id) return { order: cur, eventType };
    cur = parse(cur.data ?? cur.updatedEvent?.currentEntity ?? cur.createdEvent?.entity ?? cur.actionEvent?.body);
  }
  return null;
}

function status(o: WixOrder): NormalizedOrder["status"] {
  if (o.status === "CANCELED") return "cancelled";
  if (o.paymentStatus === "FULLY_REFUNDED") return "refunded";
  if (o.paymentStatus === "PAID" || o.paymentStatus === "PARTIALLY_REFUNDED") return o.fulfillmentStatus === "FULFILLED" ? "completed" : "processing";
  return "pending";
}

export function wixOrderToEvent(o: WixOrder, eventType = "order_updated"): NormalizedEvent | null {
  if (!o?.id || !o.currency) return null;
  const cur = o.currency.toUpperCase(); const total = toMinor(o.priceSummary?.total?.amount, cur);
  const order: NormalizedOrder = {
    id: String(o.number ?? o.id), status: status(o), currency: cur, total,
    tax: toMinor(o.priceSummary?.tax?.amount, cur), shipping: toMinor(o.priceSummary?.shipping?.amount, cur), shipping_tax: 0,
    coupons: (o.appliedDiscounts ?? []).map((d) => String(d.coupon?.code ?? "")).filter(Boolean),
    ref: "", email_hash: "", created_at: o.createdDate ?? new Date().toISOString(),
    refunds: o.paymentStatus === "FULLY_REFUNDED" ? [{ id: "full", amount: total }] : [],
  };
  const at = o.updatedDate ?? o.createdDate ?? new Date().toISOString();
  return { event_id: `wix:${o.id}:${eventType}:${at}`, type: `order.${eventType}`, occurred_at: at, order };
}

export const wixAdapter: PlatformAdapter = {
  platform: "wix",
  verify: (raw, _h, publicKeyPem) => verifyWixJwt(raw, publicKeyPem) !== null,
  toEvent: (p) => { const r = wixOrderFromPayload(p); return r ? wixOrderToEvent(r.order, r.eventType.split(".").pop() || "order_updated") : null; },
};
