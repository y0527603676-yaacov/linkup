import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";
import * as core from "../../../../supabase/functions/apps/core";
import { partnerDestination } from "../../src/lib/partner-link";

/**
 * Personal links (no coupon typing) on Shopify and Wix, plus scheduled sync, retries, late / out-of-order events.
 * Real database functions (PGlite) + edge-function logic + simulated Shopify / Wix APIs.
 * Not proven here (needs a real Shopify development store / Wix test site): that Shopify fills landing_site /
 * customerJourneySummary as documented, that the theme app embed and Wix embedded script run on real storefronts.
 */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const anon: Who = { role: "anon" };
const u: Record<string, Who> = {}; const org: Record<string, string> = {};
let code = ""; let otherCode = ""; let conn = "";
const call = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  return (await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
    keys.map((k) => (typeof args[k] === "object" && args[k] !== null ? JSON.stringify(args[k]) : args[k])))).r;
};
const rpc: core.Rpc = async (fn, args = {}) => { try {
  if (fn === "app_connections") return { data: (await db.one<{ r: string[] }>(svc, `select coalesce(array_agg(x), '{}') r from public.app_connections($1) x`, [args.p_platform])).r, error: null };
  return { data: await call(svc, fn, args), error: null }; } catch (e) { return { data: null, error: { message: (e as Error).message } }; } };
const q = <T = any>(sql: string, p: unknown[] = []) => db.as<T>(owner, sql, p);
const noSleep = async () => {};
const cfg: core.Config = { shopifyKey: "key123", shopifySecret: "shpss_secret", wixAppId: "wix-app", wixSecret: "wix-secret",
  functionsBase: "https://fn.example/functions/v1/apps", appBase: "https://app.example", cronSecret: "cron-s3cret", sleep: noSleep };
const attr = async (ext: string) => (await q(`select a.method, a.creator_org_id from attributions a join orders o on o.id = a.order_id where o.external_order_id = $1`, [ext]));
const creatorTotal = async (ext: string) => Number((await q(`select coalesce(sum(l.amount_minor),0) n from commission_ledger l join attributions a on a.id = l.attribution_id
  join orders o on o.id = a.order_id where o.external_order_id = $1 and l.party_role = 'creator'`, [ext]))[0].n);
const now = () => Math.floor(Date.now() / 1000);

type Res = { ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> };
const res = (status: number, j: unknown): Res => ({ ok: status < 400, status, json: async () => j, text: async () => JSON.stringify(j) });

/** Simulated Shopify Admin API. `journey` controls customerJourneySummary; `fail` makes the next N calls of a kind fail. */
function fakeShopify() {
  const st = { discounts: new Map<string, { id: string; title: string; status: string }>(), journey: null as any, shopStatus: 200,
    fail429: 0, calls: [] as string[], products: [] as any[] };
  const f: core.Fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (url.endsWith("/admin/oauth/access_token")) return res(200, { access_token: "shpat_x", scope: "read_orders,read_products,write_discounts" });
    if (!url.includes("/graphql.json")) return res(404, {});
    const qy: string = body.query; st.calls.push(qy.slice(0, 40));
    if (st.fail429 > 0) { st.fail429--; return res(429, {}); }
    if (qy.includes("shop {")) return st.shopStatus === 200 ? res(200, { data: { shop: { myshopifyDomain: "linkshop.myshopify.com", primaryDomain: { url: "https://linkshop.co.il" }, currencyCode: "ILS" } } }) : res(st.shopStatus, {});
    if (qy.includes("webhookSubscriptionCreate")) return res(200, { data: { webhookSubscriptionCreate: { userErrors: [] } } });
    if (qy.includes("codeDiscountNodeByCode")) { const d = st.discounts.get(body.variables.code); return res(200, { data: { codeDiscountNodeByCode: d ? { id: d.id, codeDiscount: { title: d.title, status: d.status } } : null } }); }
    if (qy.includes("discountCodeBasicCreate")) { const id = `gid://shopify/DiscountCodeNode/${st.discounts.size + 1}`;
      st.discounts.set(body.variables.d.code, { id, title: body.variables.d.title, status: "ACTIVE" });
      return res(200, { data: { discountCodeBasicCreate: { codeDiscountNode: { id }, userErrors: [] } } }); }
    if (qy.includes("customerJourneySummary")) return res(200, { data: { order: { customerJourneySummary: st.journey } } });
    if (qy.includes("products(")) return res(200, { data: { products: { nodes: st.products, pageInfo: { hasNextPage: false, endCursor: null } } } });
    return res(200, { data: {} });
  };
  return { f, st };
}
const signQuery = (p: Record<string, string>) => {
  const msg = Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join("&");
  return new URLSearchParams({ ...p, hmac: createHmac("sha256", cfg.shopifySecret!).update(msg).digest("hex") });
};
const hook = (topic: string, body: unknown, id: string) => {
  const raw = JSON.stringify(body);
  const h = new Map([["x-shopify-topic", topic], ["x-shopify-shop-domain", "linkshop.myshopify.com"], ["x-shopify-webhook-id", id],
    ["x-shopify-hmac-sha256", createHmac("sha256", cfg.shopifySecret!).update(raw).digest("base64")]]);
  return { raw, headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null } };
};
const shop = fakeShopify();
const send = async (topic: string, body: object, id: string) => { const h = hook(topic, body, id); return (await core.shopifyWebhook(rpc, cfg, h.headers, h.raw, shop.f)).body as any; };
const order = (id: number, extra: object = {}) => ({ id, currency: "ILS", total_price: "118.00", total_tax: "18.00", discount_codes: [],
  financial_status: "paid", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), email: "buyer@example.com",
  refunds: [], note_attributes: [], ...extra });

beforeAll(async () => {
  db = await createDb();
  for (const k of ["store", "creator", "other", "creator2"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@x.co.il`) };
  org.store = await call(u.store!, "create_organization", { p_type: "store", p_name: "Link Shop" });
  org.other = await call(u.other!, "create_organization", { p_type: "store", p_name: "Other Shop", p_website_url: "https://other-shop.co.il" });
  org.creator = await call(u.creator!, "create_organization", { p_type: "creator", p_name: "Noa" });
  org.creator2 = await call(u.creator2!, "create_organization", { p_type: "creator", p_name: "Dana" });
  const p = await call(u.store!, "create_proposal", { p_from_org: org.store, p_commission_bps: 1000, p_invitee_name: "Noa", p_invitee_contact: "x", p_coupon_discount_pct: 10 });
  code = (await call(u.creator!, "accept_proposal", { p_token: p.token, p_org: org.creator })).code;
  const p2 = await call(u.other!, "create_proposal", { p_from_org: org.other, p_commission_bps: 1000, p_invitee_name: "Dana", p_invitee_contact: "x" });
  otherCode = (await call(u.creator2!, "accept_proposal", { p_token: p2.token, p_org: org.creator2 })).code;
  const state = await call(u.store!, "start_app_install", { p_org: org.store, p_platform: "shopify", p_shop: "linkshop.myshopify.com" });
  const r = await core.shopifyCallback(rpc, shop.f, cfg, signQuery({ code: "good", shop: "linkshop.myshopify.com", state, timestamp: "1" }));
  expect(r.redirect).toContain("ok=app_connected");
  conn = (await q(`select id from store_connections where org_id = $1`, [org.store]))[0].id;
}, 120_000);

describe("Personal link → where the visitor lands", () => {
  it("Shopify app store with a confirmed creator coupon: official shareable discount link, code applied automatically", async () => {
    const r = await call(anon, "resolve_partner_link", { p_code: code });
    expect(r).toMatchObject({ code, url: "https://linkshop.myshopify.com", platform: "shopify", discount_link: true });
    const d = partnerDestination(r, 1_800_000_000)!;
    expect(d.origin + d.pathname).toBe(`https://linkshop.myshopify.com/discount/${code}`);
    const inner = new URL(d.searchParams.get("redirect")!, d.origin);
    expect(inner.searchParams.get("lku")).toBe(code);
    expect(inner.searchParams.get("lkt")).toBe("1800000000");
    expect(core.refFromUrl(d.toString())).toEqual({ code, at: 1_800_000_000 });   // what Shopify records as the landing page
  });
  it("switch off (setting) → plain store link with lku/lkt; other platforms are unchanged", async () => {
    await q(`update app_settings set value = '0'::jsonb where key = 'shopify_discount_link'`);
    expect((await call(anon, "resolve_partner_link", { p_code: code })).discount_link).toBe(false);
    await q(`update app_settings set value = '1'::jsonb where key = 'shopify_discount_link'`);
    const w = await call(anon, "resolve_partner_link", { p_code: otherCode });
    expect(w).toMatchObject({ url: "https://other-shop.co.il", discount_link: false });
    const d = partnerDestination(w, 1_800_000_000)!;
    expect(`${d.origin}${d.pathname}`).toBe("https://other-shop.co.il/");
    expect(d.searchParams.get("lku")).toBe(otherCode);
    expect(partnerDestination({ code: "x", url: "javascript:alert(1)" })).toBeNull();
  });
  it("a coupon the shop doesn't confirm (or 0% discount) never produces a discount link", async () => {
    await q(`update app_coupons set active = false where connection_id = $1`, [conn]);
    expect((await call(anon, "resolve_partner_link", { p_code: code })).discount_link).toBe(false);
    await q(`update app_coupons set active = true where connection_id = $1`, [conn]);
    const out = await core.shopifySyncCoupons(shop.f, cfg, "linkshop.myshopify.com", "t", [{ code: "ZERO1234", discount_pct: 0, active: true }]);
    expect(out).toMatchObject({ created: 0, skipped: 1 });
  });
});

describe("Shopify: sales through the personal link (no coupon typed)", () => {
  it("order whose landing page is the link → link attribution and commission; same webhook again counted once", async () => {
    const landing = `/discount/${code}?redirect=%2F%3Flku%3D${code}%26lkt%3D${now() - 3600}%26utm_source%3Dlinkup`;
    expect((await send("orders/create", order(910001, { landing_site: landing }), "L1")).result.attributed).toBe(true);
    expect((await send("orders/create", order(910001, { landing_site: landing }), "L1")).result.status).toBe("duplicate");
    expect(await attr("910001")).toEqual([{ method: "link", creator_org_id: org.creator }]);
    expect(await creatorTotal("910001")).toBe(1_000);
  });
  it("cart attribute from the theme app embed → link attribution", async () => {
    await send("orders/create", order(910002, { note_attributes: [{ name: "linkup_ref", value: `${code}|${now() - 60}` }] }), "L2");
    expect((await attr("910002"))[0]?.method).toBe("link");
  });
  it("link AND coupon on the same order → exactly one attribution (coupon), no double commission", async () => {
    await send("orders/create", order(910003, { discount_codes: [{ code }], landing_site: `/?lku=${code}&lkt=${now()}` }), "L3");
    expect(await attr("910003")).toEqual([{ method: "coupon", creator_org_id: org.creator }]);
    expect(await creatorTotal("910003")).toBe(1_000);
  });
  it("visit older than the agreement's attribution window → no commission", async () => {
    await send("orders/create", order(910004, { landing_site: `/?lku=${code}&lkt=${now() - 40 * 86400}` }), "L4");
    expect(await attr("910004")).toEqual([]);
  });
  it("another store's creator code on this store's order → ignored (stores are separated)", async () => {
    await send("orders/create", order(910005, { landing_site: `/?lku=${otherCode}&lkt=${now()}` }), "L5");
    expect(await attr("910005")).toEqual([]);
  });
  it("no link data in the webhook → Shopify's customer journey; not ready yet → retried on the next order event", async () => {
    shop.st.journey = { ready: false };
    await send("orders/create", order(910006, { financial_status: "pending" }), "J1");
    expect(await attr("910006")).toEqual([]);
    const visit = new Date(Date.now() - 2 * 86400_000).toISOString();
    shop.st.journey = { ready: true, lastVisit: { landingPage: `https://linkshop.co.il/products/x?lku=${code}&utm_source=linkup`, occurredAt: visit }, firstVisit: null };
    await send("orders/updated", order(910006, { updated_at: new Date(Date.now() + 1000).toISOString() }), "J2");
    expect((await attr("910006"))[0]?.method).toBe("link");
    expect((await q(`select ref_at from orders where external_order_id = '910006'`))[0].ref_at.toISOString().slice(0, 16)).toBe(visit.slice(0, 16));
  });
  it("events out of order: a late 'paid' event after the cancellation does not revive the commission", async () => {
    const t0 = Date.now();
    await send("orders/cancelled", order(910007, { cancelled_at: new Date(t0 + 5000).toISOString(), updated_at: new Date(t0 + 5000).toISOString(), landing_site: `/?lku=${code}&lkt=${now()}` }), "O1");
    await send("orders/create", order(910007, { updated_at: new Date(t0).toISOString(), landing_site: `/?lku=${code}&lkt=${now()}` }), "O2");
    expect((await q(`select status from orders where external_order_id = '910007'`))[0].status).toBe("cancelled");
    expect(await creatorTotal("910007")).toBe(0);
  });
  it("refund of a link sale reduces the commission automatically", async () => {
    await send("orders/updated", order(910001, { financial_status: "partially_refunded", updated_at: new Date(Date.now() + 9000).toISOString(),
      landing_site: `/?lku=${code}&lkt=${now()}`, refunds: [{ id: 77, transactions: [{ kind: "refund", status: "success", amount: "59.00" }] }] }), "L6");
    expect(await creatorTotal("910001")).toBe(500);
  });
  it("temporary database error → 500 so Shopify retries (nothing lost)", async () => {
    const broken: core.Rpc = async (fn, a) => (fn === "ingest_order_event" ? { data: null, error: { message: "connection reset" } } : rpc(fn, a));
    const h = hook("orders/create", order(910008), "E1");
    expect((await core.shopifyWebhook(broken, cfg, h.headers, h.raw, shop.f)).status).toBe(500);
  });
});

describe("Scheduled sync and retries", () => {
  it("rate limit (429) is retried; the call then succeeds", async () => {
    shop.st.fail429 = 2;
    const f = core.retrying(shop.f, noSleep);
    const r = await f("https://linkshop.myshopify.com/admin/api/2026-07/graphql.json", { method: "POST", body: JSON.stringify({ query: "{ shop { x } }" }) });
    expect(r.status).toBe(200);
  });
  it("only with the secret; coupons and products synced; connection health checked by a real API call", async () => {
    expect((await core.syncAll(rpc, shop.f, cfg, { get: () => "wrong" })).status).toBe(401);
    shop.st.products = [{ id: "gid://shopify/Product/55", title: "Mug", onlineStoreUrl: "https://linkshop.co.il/products/mug", featuredImage: { url: "https://cdn.shopify.com/m.jpg" },
      totalInventory: 3, tracksInventory: true, priceRangeV2: { minVariantPrice: { amount: "49.90", currencyCode: "ILS" } } }];
    const r = await core.syncAll(rpc, shop.f, cfg, { get: (k) => (k === "x-linkup-cron" ? "cron-s3cret" : null) });
    expect((r.body as any).results[0]).toMatchObject({ platform: "shopify", ok: true });
    expect((await q(`select name, price_minor, stock_qty from products where connection_id = $1`, [conn]))[0]).toEqual({ name: "Mug", price_minor: 4990, stock_qty: 3 });
  });
  it("shop unreachable (e.g. token revoked without the uninstall webhook) → recorded for admin, status NOT faked", async () => {
    shop.st.shopStatus = 401;
    const r = await core.syncAll(rpc, shop.f, cfg, { get: (k) => (k === "x-linkup-cron" ? "cron-s3cret" : null) });
    expect((r.body as any).results[0]).toMatchObject({ ok: false, reason: "shop_unreachable" });
    expect((await q(`select last_error from store_connections where id = $1`, [conn]))[0].last_error).toBe("app_sync: shop_unreachable");
    shop.st.shopStatus = 200;
  });
  it("new functions are service-only", async () => {
    await expect(db.as(u.store!, `select public.app_coupon_mark(null, 'ABCD1234', null, true)`)).rejects.toThrow(/permission denied/);
    await expect(db.as(u.store!, `select public.app_sync_failed(null, 'x')`)).rejects.toThrow(/permission denied/);
    await expect(db.as(u.store!, `select * from public.app_coupons`)).rejects.toThrow(/permission denied/);
  });
});

describe("Wix: personal link through the embedded script beacon", () => {
  const instance = "1a2b3c4d-1111-4222-8333-944455556666";
  const orderGuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  let wcode = ""; let wixOrderObj: any = null;
  const wixFetch: core.Fetch = async (url) => {
    if (url.endsWith("/oauth2/token")) return res(200, { access_token: "wix-token" });
    if (url.endsWith("/apps/v1/instance")) return res(200, { site: { url: "https://wix-link.co.il" } });
    if (url.endsWith("/apps/v1/scripts")) return res(200, {});
    if (url.endsWith("/coupons/query")) return res(200, { coupons: [] });
    if (url.endsWith("/stores/v2/coupons")) return res(200, { id: "cpn-1" });
    if (url.endsWith("/products/query")) return res(200, { products: [] });
    if (url.includes("/ecom/v1/orders/")) return url.endsWith(orderGuid) && wixOrderObj ? res(200, { order: wixOrderObj }) : res(404, {});
    return res(404, {});
  };
  const beacon = (b: object) => core.wixRef(rpc, wixFetch, cfg, JSON.stringify(b));
  const wOrder = (extra: object = {}) => ({ id: orderGuid, number: "5001", currency: "ILS", status: "APPROVED", paymentStatus: "PAID",
    priceSummary: { total: { amount: "118" }, tax: { amount: "18" } }, appliedDiscounts: [], createdDate: new Date().toISOString(),
    updatedDate: new Date().toISOString(), ...extra });
  beforeAll(async () => {
    const w = await call(u.other!, "create_organization", { p_type: "store", p_name: "Wix Link" });
    const p = await call(u.other!, "create_proposal", { p_from_org: w, p_commission_bps: 1000, p_invitee_name: "Noa", p_invitee_contact: "x" });
    wcode = (await call(u.creator!, "accept_proposal", { p_token: p.token, p_org: org.creator })).code;
    const st = await call(u.other!, "start_app_install", { p_org: w, p_platform: "wix" });
    expect((await core.wixCallback(rpc, wixFetch, cfg, new URLSearchParams({ instanceId: instance, state: st }))).redirect).toContain("ok=app_connected");
  });
  it("malformed beacons are refused; unknown orders ignored", async () => {
    expect((await beacon({ instance, order: "1; drop", ref: `${wcode}|${now()}` })).status).toBe(400);
    expect((await beacon({ instance, order: orderGuid, ref: "nope" })).status).toBe(400);
    expect((await beacon({ instance, order: orderGuid, ref: `${wcode}|${now()}` })).body).toMatchObject({ ignored: "unknown_order" });
  });
  it("beacon → the order is read from Wix's API (not from the browser) → link attribution; replay counted once", async () => {
    wixOrderObj = wOrder({ priceSummary: { total: { amount: "999" }, tax: { amount: "0" } } });
    wixOrderObj.priceSummary = { total: { amount: "118" }, tax: { amount: "18" } };   // the browser can't change amounts
    expect((await beacon({ instance, order: orderGuid, ref: `${wcode}|${now() - 100}` })).body).toMatchObject({ ok: true });
    await beacon({ instance, order: orderGuid, ref: `${wcode}|${now() - 100}` });
    expect(await attr("5001")).toEqual([{ method: "link", creator_org_id: org.creator }]);
    expect(await creatorTotal("5001")).toBe(1_000);
  });
  it("partial refund from Wix's order activities reduces the commission", async () => {
    const { generateKeyPairSync, createSign } = await import("node:crypto");
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const wcfg = { ...cfg, wixPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString() };
    const b64u = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const jwt = (payload: object) => { const h = b64u(Buffer.from(JSON.stringify({ alg: "RS256" }))), p = b64u(Buffer.from(JSON.stringify(payload)));
      const s = createSign("RSA-SHA256"); s.update(`${h}.${p}`); return `${h}.${p}.${b64u(s.sign(privateKey))}`; };
    const o = wOrder({ paymentStatus: "PARTIALLY_REFUNDED", updatedDate: new Date(Date.now() + 5000).toISOString(),
      activities: [{ id: "a1", type: "REFUND_INITIATED", refundInitiated: { refundId: "rf1", amount: { amount: "59" } } },
                   { id: "a2", type: "PAYMENT_REFUNDED", paymentRefunded: { refundId: "rf1" } }] });
    await core.wixWebhook(rpc, wcfg, jwt({ data: JSON.stringify({ eventType: "wix.ecom.v1.order_payment_status_updated", instanceId: instance, id: "wr1",
      data: JSON.stringify({ actionEvent: { body: { order: o } } }) }) }));
    expect(await creatorTotal("5001")).toBe(500);
  });
  it("old orders can't be claimed later through the beacon", async () => {
    wixOrderObj = wOrder({ id: orderGuid, number: "5002", createdDate: new Date(Date.now() - 5 * 3600_000).toISOString() });
    expect((await beacon({ instance, order: orderGuid, ref: `${wcode}|${now()}` })).body).toMatchObject({ ignored: "not_recent" });
  });
});
