import { createHmac, generateKeyPairSync, createSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { toMinor } from "../../src/lib/adapters/types";
import { shopifyAdapter, shopifyOrderToEvent, verifyShopifyWebhook } from "../../src/lib/adapters/shopify";
import { verifyWixJwt, wixAdapter, wixOrderFromPayload, wixOrderToEvent } from "../../src/lib/adapters/wix";

/** Prepared adapters: platform data → LINKUP's one order format. Payload shapes follow the platforms' documented fields;
 *  they still need confirmation on real development stores before any store can use them. */
export const shopifyOrder = {
  id: 5550001, currency: "ILS", total_price: "246.00", total_tax: "36.00",
  total_shipping_price_set: { shop_money: { amount: "10.00" } }, shipping_lines: [{ tax_lines: [{ price: "1.53" }] }],
  discount_codes: [{ code: "NOA10", amount: "24.60", type: "percentage" }],
  note_attributes: [{ name: "linkup_ref", value: "NOA10|1762851000" }],
  financial_status: "paid", fulfillment_status: null, cancelled_at: null,
  created_at: "2026-11-11T09:20:00+02:00", updated_at: "2026-11-11T09:21:00+02:00", email: "Buyer@Example.com",
  refunds: [{ id: 901, transactions: [{ kind: "refund", status: "success", amount: "59.00" }, { kind: "refund", status: "failure", amount: "5.00" }] }],
};

describe("amounts", () => {
  it("major → minor units exactly, per currency", () => {
    expect([toMinor("246.00", "ILS"), toMinor("0.1", "USD"), toMinor("10.999", "EUR"), toMinor(12, "ILS"), toMinor("1500", "JPY"), toMinor("x", "ILS")])
      .toEqual([24600, 10, 1100, 1200, 1500, 0]);
  });
});

describe("Shopify (prepared)", () => {
  it("verifies X-Shopify-Hmac-Sha256 over the raw body only", () => {
    const raw = JSON.stringify(shopifyOrder); const secret = "shpss_test";
    const good = createHmac("sha256", secret).update(raw).digest("base64");
    expect(verifyShopifyWebhook(raw, good, secret)).toBe(true);
    expect(verifyShopifyWebhook(raw + " ", good, secret)).toBe(false);
    expect(verifyShopifyWebhook(raw, good, "other")).toBe(false);
    expect(verifyShopifyWebhook(raw, undefined, secret)).toBe(false);
  });
  it("maps an order: totals, tax, shipping, coupon, link ref, successful refunds only", () => {
    const e = shopifyOrderToEvent(shopifyOrder, "orders/updated", "abc")!;
    expect(e.order).toMatchObject({ id: "5550001", status: "processing", currency: "ILS", total: 24600, tax: 3600, shipping: 1000, shipping_tax: 153,
      coupons: ["NOA10"], ref: "NOA10|1762851000", email_hash: "abc", refunds: [{ id: "901", amount: 5900 }] });
    expect(e.event_id).toContain("shopify:5550001:orders/updated");
  });
  it("status: unpaid → pending (no commission), fulfilled → completed, cancelled/voided → cancelled", () => {
    const st = (x: object) => shopifyOrderToEvent({ ...shopifyOrder, ...x })!.order.status;
    expect(st({ financial_status: "pending" })).toBe("pending");
    expect(st({ financial_status: "authorized" })).toBe("pending");
    expect(st({ fulfillment_status: "fulfilled" })).toBe("completed");
    expect(st({ cancelled_at: "2026-11-12T10:00:00Z" })).toBe("cancelled");
    expect(st({ financial_status: "refunded" })).toBe("refunded");
    expect(shopifyAdapter.toEvent({}, {})).toBeNull();
  });
});

describe("Wix (prepared)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const b64u = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const order = { id: "f1d2-…", number: "10042", currency: "ILS", status: "APPROVED", paymentStatus: "PAID",
    priceSummary: { total: { amount: "246" }, tax: { amount: "0" }, shipping: { amount: "10" } },
    appliedDiscounts: [{ coupon: { code: "NOA10" } }], createdDate: "2026-11-11T07:20:00Z", updatedDate: "2026-11-11T07:21:00Z" };
  const jwt = (payload: object, key = privateKey) => {
    const h = b64u(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }))); const p = b64u(Buffer.from(JSON.stringify(payload)));
    const s = createSign("RSA-SHA256"); s.update(`${h}.${p}`); return `${h}.${p}.${b64u(s.sign(key))}`;
  };
  it("accepts only a JWT signed by the matching key (RS256)", () => {
    const body = { data: JSON.stringify({ eventType: "wix.ecom.v1.order_approved", data: JSON.stringify({ actionEvent: { body: { order } } }) }) };
    const t = jwt(body);
    expect(verifyWixJwt(t, pem)).toEqual(body);
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(verifyWixJwt(jwt(body, other), pem)).toBeNull();
    expect(verifyWixJwt("not.a.jwt", pem)).toBeNull();
    expect(wixAdapter.verify(t, {}, pem)).toBe(true);
  });
  it("unwraps the nested event and maps the order; refunds and cancellations", () => {
    const body = { data: JSON.stringify({ eventType: "wix.ecom.v1.order_approved", data: JSON.stringify({ actionEvent: { body: { order } } }) }) };
    const found = wixOrderFromPayload(body)!;
    expect(found.eventType).toBe("wix.ecom.v1.order_approved");
    expect(wixAdapter.toEvent(body, {})!.order).toMatchObject({ id: "10042", status: "processing", total: 24600, shipping: 1000, coupons: ["NOA10"], refunds: [] });
    expect(wixOrderToEvent({ ...order, status: "CANCELED" })!.order.status).toBe("cancelled");
    expect(wixOrderToEvent({ ...order, paymentStatus: "FULLY_REFUNDED" })!.order.refunds).toEqual([{ id: "full", amount: 24600 }]);
    expect(wixOrderToEvent({ ...order, paymentStatus: "NOT_PAID" })!.order.status).toBe("pending");
  });
});

describe("custom-site API: the developer guide's signing recipe matches the endpoint's check", () => {
  it("Node example signature is accepted; tampered body, wrong secret or old timestamp are refused", async () => {
    const { verifySignature, normalizeConnectionId } = await import("../../../../supabase/functions/woo/hmac");
    const key = "lk_" + "ab".repeat(16) + "_" + "S".repeat(64);
    const [, id, secret] = key.match(/^lk_([0-9a-f]{32})_(.+)$/)!;
    const raw = JSON.stringify({ action: "sync", plugin_version: "my-site 1.0" }); const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", secret!).update(`${ts}.${raw}`).digest("hex");
    expect(normalizeConnectionId(id!)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await verifySignature(raw, sig, ts, secret!, ts)).toBe(true);
    expect(await verifySignature(raw + " ", sig, ts, secret!, ts)).toBe(false);
    expect(await verifySignature(raw, sig, ts, "other", ts)).toBe(false);
    expect(await verifySignature(raw, sig, ts, secret!, ts + 301)).toBe(false);
  });
});
