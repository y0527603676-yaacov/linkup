import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";
import * as core from "../../../../supabase/functions/apps/core";
import { partnerDestination, signVisit } from "../../src/lib/partner-link";

/**
 * Personal links (no coupon typing) on Shopify and Wix, plus scheduled sync, retries, late / out-of-order events.
 * Real database functions (PGlite) + edge-function logic + simulated Shopify / Wix APIs.
 * Not proven here (needs a real Shopify development store / Wix test site): that Shopify fills landing_site /
 * customerJourneySummary as documented, that the theme app embed and Wix embedded script run on real storefronts.
 */
let db: Db;
/** Simulated webhook subscriptions / pixel in the shop (shared by the fakes). */
const HOOKS = { topics: new Set<string>(), block: new Set<string>(), pixel: false, blockPixel: false };
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
  functionsBase: "https://fn.example/functions/v1/apps", appBase: "https://app.example", cronSecret: "cron-s3cret", sleep: noSleep,
  refSecret: "ref-s3cret" };
const SECRET = "ref-s3cret";
/** What LINKUP's /r/ redirect produces: signed visit (raw ref) and landing query. */
const sref = (c: string, at: number) => `${c}|${at}|${signVisit(SECRET, c, at)}`;
const land = (c: string, at: number) => `/?lku=${c}&lkt=${at}&lks=${signVisit(SECRET, c, at)}&utm_source=linkup`;
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
    if (url.endsWith("/admin/oauth/access_token")) return res(200, { access_token: "shpat_x", scope: "read_orders,read_products,write_discounts,write_pixels,read_customer_events" });
    if (!url.includes("/graphql.json")) return res(404, {});
    const qy: string = body.query; st.calls.push(qy.slice(0, 40));
    if (st.fail429 > 0) { st.fail429--; return res(429, {}); }
    if (qy.includes("shop {")) return st.shopStatus === 200 ? res(200, { data: { shop: { myshopifyDomain: "linkshop.myshopify.com", primaryDomain: { url: "https://linkshop.co.il" }, currencyCode: "ILS" } } }) : res(st.shopStatus, {});
    if (qy.includes("webhookSubscriptions(first")) return res(200, { data: { webhookSubscriptions: { nodes: [...HOOKS.topics].filter((t) => !HOOKS.block.has(t)).map((t) => ({ topic: t, uri: "https://fn.example/functions/v1/apps/shopify/webhook" })) }, webPixel: HOOKS.pixel ? { id: "gid://shopify/WebPixel/1" } : null } });
    if (qy.includes("webhookSubscriptionCreate")) { if (!HOOKS.block.has(body.variables.topic)) HOOKS.topics.add(body.variables.topic); return res(200, { data: { webhookSubscriptionCreate: { userErrors: HOOKS.block.has(body.variables.topic) ? [{ message: "not approved for protected customer data" }] : [] } } }); }
    if (qy.includes("webPixelCreate")) { if (!HOOKS.blockPixel) HOOKS.pixel = true; return res(200, { data: { webPixelCreate: HOOKS.blockPixel ? { webPixel: null, userErrors: [{ code: "X", message: "no" }] } : { webPixel: { id: "gid://shopify/WebPixel/1" }, userErrors: [] } } }); }
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
  it("default: a plain personal link, no discount — signed visit (code + time) added for every platform", async () => {
    const r = await call(anon, "resolve_partner_link", { p_code: code });
    expect(r).toMatchObject({ code, url: "https://linkshop.myshopify.com", platform: "shopify", discount_link: false });
    const d = partnerDestination(r, 1_790_000_000, SECRET)!;
    expect(`${d.origin}${d.pathname}`).toBe("https://linkshop.myshopify.com/");
    expect(d.searchParams.get("lku")).toBe(code);
    expect(d.searchParams.get("lkt")).toBe("1790000000");
    expect(d.searchParams.get("lks")).toBe(signVisit(SECRET, code, 1_790_000_000));
    expect(core.refFromUrl(d.toString())).toEqual({ code, at: 1_790_000_000, sig: signVisit(SECRET, code, 1_790_000_000) });
    expect(await core.signVisit(SECRET, code, 1_790_000_000)).toBe(signVisit(SECRET, code, 1_790_000_000));   // web app and edge agree
  });
  it("only if the STORE chooses it: Shopify's official discount link that applies its creator coupon", async () => {
    await expect(call(u.creator!, "set_link_options", { p_org: org.store, p_auto_apply_coupon: true })).rejects.toThrow(/forbidden/);
    expect(await call(u.store!, "set_link_options", { p_org: org.store, p_auto_apply_coupon: true })).toEqual({ auto_apply_coupon: true });
    const r = await call(anon, "resolve_partner_link", { p_code: code });
    expect(r.discount_link).toBe(true);
    const d = partnerDestination(r, 1_790_000_000, SECRET)!;
    expect(d.origin + d.pathname).toBe(`https://linkshop.myshopify.com/discount/${code}`);
    expect(core.refFromUrl(d.toString())?.code).toBe(code);
    await q(`update app_settings set value = '0'::jsonb where key = 'shopify_discount_link'`);   // platform kill switch
    expect((await call(anon, "resolve_partner_link", { p_code: code })).discount_link).toBe(false);
    await q(`update app_settings set value = '1'::jsonb where key = 'shopify_discount_link'`);
    expect(await call(u.store!, "set_link_options", { p_org: org.store, p_auto_apply_coupon: false })).toEqual({ auto_apply_coupon: false });
    expect((await call(anon, "resolve_partner_link", { p_code: code })).discount_link).toBe(false);
    expect(await call(u.store!, "link_options", { p_org: org.store })).toEqual({ auto_apply_coupon: false });
  });
  it("other platforms unchanged; unsafe addresses refused", async () => {
    const w = await call(anon, "resolve_partner_link", { p_code: otherCode });
    expect(w).toMatchObject({ url: "https://other-shop.co.il", discount_link: false });
    expect(partnerDestination({ code: "abcd1234", url: "javascript:alert(1)" })).toBeNull();
  });
  it("a coupon with 0% discount is never created in the shop", async () => {
    const out = await core.shopifySyncCoupons(shop.f, cfg, "linkshop.myshopify.com", "t", [{ code: "ZERO1234", discount_pct: 0, active: true }]);
    expect(out).toMatchObject({ created: 0, skipped: 1 });
  });
});

describe("Shopify: sales through the personal link (no coupon typed)", () => {
  it("order whose landing page is the link → link attribution and commission; same webhook again counted once", async () => {
    const landing = `/discount/${code}?redirect=${encodeURIComponent(land(code, now() - 3600))}`;
    expect((await send("orders/create", order(910001, { landing_site: landing }), "L1")).result.attributed).toBe(true);
    expect((await send("orders/create", order(910001, { landing_site: landing }), "L1")).result.status).toBe("duplicate");
    expect(await attr("910001")).toEqual([{ method: "link", creator_org_id: org.creator }]);
    expect(await creatorTotal("910001")).toBe(1_000);
  });
  it("cart attribute from the theme app embed → link attribution", async () => {
    await send("orders/create", order(910002, { note_attributes: [{ name: "linkup_ref", value: sref(code, now() - 60) }] }), "L2");
    expect((await attr("910002"))[0]?.method).toBe("link");
  });
  it("link AND coupon on the same order → exactly one attribution (coupon), no double commission", async () => {
    await send("orders/create", order(910003, { discount_codes: [{ code }], landing_site: land(code, now()) }), "L3");
    expect(await attr("910003")).toEqual([{ method: "coupon", creator_org_id: org.creator }]);
    expect(await creatorTotal("910003")).toBe(1_000);
  });
  it("visit older than the agreement's attribution window → no commission", async () => {
    await send("orders/create", order(910004, { landing_site: land(code, now() - 40 * 86400) }), "L4");
    expect(await attr("910004")).toEqual([]);
  });
  it("forged or unsigned link data from the browser is ignored (no commission)", async () => {
    await send("orders/create", order(910009, { landing_site: `/?lku=${code}&lkt=${now()}&lks=AAAAAAAAAAAAAAAAAAAAAA` }), "F1");
    await send("orders/create", order(910010, { note_attributes: [{ name: "linkup_ref", value: `${code}|${now()}` }] }), "F2");
    await send("orders/create", order(910011, { landing_site: land(code, now() + 86400) }), "F3");   // visit "in the future"
    for (const id of ["910009", "910010", "910011"]) expect(await attr(id)).toEqual([]);
  });
  it("another store's creator code on this store's order → ignored (stores are separated)", async () => {
    await send("orders/create", order(910005, { landing_site: land(otherCode, now()) }), "L5");
    expect(await attr("910005")).toEqual([]);
  });
  it("no link data in the webhook → Shopify's customer journey; not ready yet → retried on the next order event", async () => {
    shop.st.journey = { ready: false };
    await send("orders/create", order(910006, { financial_status: "pending" }), "J1");
    expect(await attr("910006")).toEqual([]);
    const visit = new Date(Date.now() - 2 * 86400_000).toISOString();
    shop.st.journey = { ready: true, lastVisit: { landingPage: `https://linkshop.co.il/products/x${land(code, Math.floor(Date.parse(visit) / 1000))}`, occurredAt: visit }, firstVisit: null };
    await send("orders/updated", order(910006, { updated_at: new Date(Date.now() + 1000).toISOString() }), "J2");
    expect((await attr("910006"))[0]?.method).toBe("link");
    expect((await q(`select ref_at from orders where external_order_id = '910006'`))[0].ref_at.toISOString().slice(0, 16)).toBe(visit.slice(0, 16));
  });
  it("events out of order: a late 'paid' event after the cancellation does not revive the commission", async () => {
    const t0 = Date.now();
    await send("orders/cancelled", order(910007, { cancelled_at: new Date(t0 + 5000).toISOString(), updated_at: new Date(t0 + 5000).toISOString(), landing_site: land(code, now()) }), "O1");
    await send("orders/create", order(910007, { updated_at: new Date(t0).toISOString(), landing_site: land(code, now()) }), "O2");
    expect((await q(`select status from orders where external_order_id = '910007'`))[0].status).toBe("cancelled");
    expect(await creatorTotal("910007")).toBe(0);
  });
  it("refund of a link sale reduces the commission automatically", async () => {
    await send("orders/updated", order(910001, { financial_status: "partially_refunded", updated_at: new Date(Date.now() + 9000).toISOString(),
      landing_site: land(code, now()), refunds: [{ id: 77, transactions: [{ kind: "refund", status: "success", amount: "59.00" }] }] }), "L6");
    expect(await creatorTotal("910001")).toBe(500);
  });
  it("temporary database error → 500 so Shopify retries (nothing lost)", async () => {
    const broken: core.Rpc = async (fn, a) => (fn === "ingest_order_event" ? { data: null, error: { message: "connection reset" } } : rpc(fn, a));
    const h = hook("orders/create", order(910008), "E1");
    expect((await core.shopifyWebhook(broken, cfg, h.headers, h.raw, shop.f)).status).toBe(500);
  });
});

describe("Shopify without any discount: LINKUP's app pixel (switched on by the app, no owner step)", () => {
  const gqlOrder = (id: number, extra: object = {}) => ({ legacyResourceId: String(id), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    cancelledAt: null, currencyCode: "ILS", email: "buyer@example.com", displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED",
    discountCodes: [], totalPriceSet: { shopMoney: { amount: "118.00" } }, totalTaxSet: { shopMoney: { amount: "18.00" } },
    totalShippingPriceSet: { shopMoney: { amount: "0" } }, shippingLines: { nodes: [] }, refunds: [], ...extra });
  let current: any = null; const pixelCalls: string[] = [];
  const pf: core.Fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null; const qy: string = body?.query ?? "";
    if (qy.includes("order(id:")) return res(200, { data: { order: current } });
    if (qy.includes("webPixelCreate")) { pixelCalls.push(body.variables.s); return res(200, { data: { webPixelCreate: { webPixel: { id: "gid://shopify/WebPixel/1" }, userErrors: [] } } }); }
    return shop.f(url, init);
  };
  const claim = (b: object) => core.shopifyRef(rpc, pf, cfg, JSON.stringify(b));
  it("activation: the app turns the pixel on itself, pointing at LINKUP with the shop's address", async () => {
    expect(await core.shopifyEnsurePixel(pf, cfg, "linkshop.myshopify.com", "t")).toBe("created");
    expect(JSON.parse(pixelCalls[0]!)).toEqual({ endpoint: "https://fn.example/functions/v1/apps/shopify/ref", shop: "linkshop.myshopify.com" });
    expect(core.SHOPIFY_SCOPES).toEqual(expect.arrayContaining(["write_pixels", "read_customer_events"]));
  });
  it("purchase 20 days after the click (window 30) → link attribution; amounts come from Shopify, not the browser", async () => {
    current = gqlOrder(930001);
    const r = await claim({ shop: "linkshop.myshopify.com", order: "gid://shopify/Order/930001", ref: sref(code, now() - 20 * 86400), total: "99999" });
    expect((r.body as any).result.attributed).toBe(true);
    expect(await attr("930001")).toEqual([{ method: "link", creator_org_id: org.creator }]);
    expect(await creatorTotal("930001")).toBe(1_000);
    // the order webhook arriving afterwards changes nothing (same order, one attribution)
    await send("orders/paid", order(930001, { updated_at: new Date(Date.now() + 1000).toISOString() }), "P1");
    expect(await creatorTotal("930001")).toBe(1_000);
  });
  it("click 40 days before the purchase (window 30) → no commission; the business window is what decides", async () => {
    current = gqlOrder(930002);
    await claim({ shop: "linkshop.myshopify.com", order: "930002", ref: sref(code, now() - 40 * 86400) });
    expect(await attr("930002")).toEqual([]);
  });
  it("unsigned / forged ref → ignored; order not readable yet → 409 so the pixel retries", async () => {
    current = gqlOrder(930003);
    expect((await claim({ shop: "linkshop.myshopify.com", order: "930003", ref: `${code}|${now()}` })).body).toMatchObject({ ignored: "untrusted_ref" });
    current = null;
    expect((await claim({ shop: "linkshop.myshopify.com", order: "930004", ref: sref(code, now()) })).status).toBe(409);
    expect((await claim({ shop: "evil.com", order: "1", ref: sref(code, now()) })).status).toBe(400);
  });
  it("pixel first, webhook later; webhook first, pixel later — same single attribution either way", async () => {
    await send("orders/create", order(930005, { financial_status: "pending" }), "P2");   // no link data in the order
    current = gqlOrder(930005);
    await claim({ shop: "linkshop.myshopify.com", order: "930005", ref: sref(code, now() - 3600) });
    expect(await attr("930005")).toEqual([{ method: "link", creator_org_id: org.creator }]);
  });
  it("an order claimed long after it was placed is refused (claim time ≠ attribution window)", async () => {
    current = gqlOrder(930006, { createdAt: new Date(Date.now() - 100 * 3600_000).toISOString() });
    expect((await claim({ shop: "linkshop.myshopify.com", order: "930006", ref: sref(code, now() - 120 * 3600) })).body).toMatchObject({ ignored: "claim_too_late" });
  });
});

describe("Server-side attribution without the pixel: the signed UTM copy in Shopify's customer journey", () => {
  // What Shopify was seen to keep on the development store: the landing page WITHOUT lku/lkt/lks, but the UTM parameters.
  const cfgU: core.Config = { ...cfg, utmShops: ["linkshop.myshopify.com"] };
  const sendU = async (topic: string, body: object, id: string, c = cfgU) => { const h = hook(topic, body, id); return (await core.shopifyWebhook(rpc, c, h.headers, h.raw, shop.f)).body as any; };
  const utm = (c: string, at: number, sig = signVisit(SECRET, c, at)) => ({ campaign: c, content: `lk1.${at}.${sig}` });
  const journey = (u: object | null, landingPage = "https://linkshop.myshopify.com/", ready = true) => ({ ready,
    lastVisit: { landingPage, occurredAt: new Date().toISOString(), utmParameters: u }, firstVisit: null });
  const src = async (ext: string) => (await q(`select payload->'order'->>'ref_src' s from order_events where external_order_id = $1 and payload->'order'->>'ref' <> '' order by received_at limit 1`, [ext]))[0]?.s ?? null;
  it("the personal link carries the signed visit also in utm_content; the server reads it from a URL or Shopify's UTM object", async () => {
    const d = partnerDestination({ code, url: "https://linkshop.myshopify.com", platform: "shopify" }, 1_790_000_000, SECRET)!;
    expect(d.searchParams.get("utm_campaign")).toBe(code);
    expect(d.searchParams.get("utm_content")).toBe(`lk1.1790000000.${signVisit(SECRET, code, 1_790_000_000)}`);
    expect(d.searchParams.get("lku")).toBe(code);   // existing links / pixel unchanged
    expect(core.refFromUtm(d.toString())).toEqual({ code, at: 1_790_000_000, sig: signVisit(SECRET, code, 1_790_000_000) });
    expect(core.refFromUtm(utm(code, 1_790_000_000))).toEqual({ code, at: 1_790_000_000, sig: signVisit(SECRET, code, 1_790_000_000) });
    expect(core.refFromUtm({ campaign: code, content: "spring-sale" })).toBeNull();
    expect(partnerDestination({ code, url: "https://linkshop.myshopify.com", platform: "shopify" }, 1_790_000_000, undefined)!.searchParams.get("utm_content")).toBeNull();
    expect(partnerDestination({ code, url: "https://woo-shop.co.il", platform: "woocommerce" }, 1_790_000_000, SECRET)!.searchParams.get("utm_content")).toBeNull();   // other platforms unchanged
  });
  it("no pixel, landing page stripped by Shopify → attributed on the server from the signed UTM copy (source recorded)", async () => {
    shop.st.journey = journey(utm(code, now() - 3 * 86400));
    await sendU("orders/create", order(950001), "U1");
    expect(await attr("950001")).toEqual([{ method: "link", creator_org_id: org.creator }]);
    expect(await creatorTotal("950001")).toBe(1_000);
    expect(await src("950001")).toBe("journey_utm");
    await sendU("orders/updated", order(950001, { updated_at: new Date(Date.now() + 1000).toISOString() }), "U1b");   // later events: no second commission
    expect(await creatorTotal("950001")).toBe(1_000);
  });
  it("shop not (yet) allowed to rely on UTM → not used at all", async () => {
    shop.st.journey = journey(utm(code, now() - 60));
    await sendU("orders/create", order(950002), "U2", cfg);
    expect(await attr("950002")).toEqual([]);
  });
  it("forgery refused: wrong signature, signature of another code, time moved, visit in the future, outside the window", async () => {
    const at = now() - 60;
    const cases: [number, object][] = [
      [950003, { campaign: code, content: `lk1.${at}.AAAAAAAAAAAAAAAAAAAAAA` }],
      [950004, { campaign: otherCode, content: `lk1.${at}.${signVisit(SECRET, code, at)}` }],      // moved to another creator
      [950005, { campaign: code, content: `lk1.${at - 86400}.${signVisit(SECRET, code, at)}` }],   // time changed
      [950006, utm(code, now() + 86400)],                                                          // future visit
      [950007, utm(code, now() - 40 * 86400)],                                                     // window is 30 days
    ];
    for (const [id, u] of cases) { shop.st.journey = journey(u); await sendU("orders/create", order(id), `F-${id}`); expect(await attr(String(id))).toEqual([]); }
  });
  it("another store's creator with a valid signature → ignored (the code must belong to this store)", async () => {
    shop.st.journey = journey(utm(otherCode, now() - 60));
    await sendU("orders/create", order(950008), "U8");
    expect(await attr("950008")).toEqual([]);
  });
  it("valid coupon AND signed UTM visit of the same or another creator → coupon wins, one attribution, no double commission", async () => {
    shop.st.journey = journey(utm(code, now() - 60));
    await sendU("orders/create", order(950009, { discount_codes: [{ code }] }), "U9");
    expect(await attr("950009")).toEqual([{ method: "coupon", creator_org_id: org.creator }]);
    expect(await creatorTotal("950009")).toBe(1_000);
  });
  it("journey not ready at the first event → retried on the next order event", async () => {
    shop.st.journey = journey(utm(code, now() - 60), "https://linkshop.myshopify.com/", false);
    await sendU("orders/create", order(950010), "U10a");
    expect(await attr("950010")).toEqual([]);
    shop.st.journey = journey(utm(code, now() - 60));
    await sendU("orders/updated", order(950010, { updated_at: new Date(Date.now() + 1000).toISOString() }), "U10b");
    expect((await attr("950010"))[0]?.method).toBe("link");
  });
  it("landing_site in the order webhook carrying only the UTM copy → used for allowed shops only", async () => {
    shop.st.journey = null;
    const lp = `/?utm_source=linkup&utm_medium=partner&utm_campaign=${code}&utm_content=lk1.${now() - 60}.${signVisit(SECRET, code, now() - 60)}`;
    await sendU("orders/create", order(950011, { landing_site: lp }), "U11", cfg);
    expect(await attr("950011")).toEqual([]);
    await sendU("orders/create", order(950012, { landing_site: lp }), "U12");
    expect((await attr("950012"))[0]?.method).toBe("link");
    expect(await src("950012")).toBe("landing_utm");
  });
  it("pixel claims are tagged as such (to tell the paths apart in real tests)", async () => {
    expect(core.shopifyOrder({ id: 1, currency: "USD", total_price: "1", landing_site: land(code, now()) })!.ref_src).toBe("landing");
    expect(core.shopifyOrder({ id: 1, currency: "USD", total_price: "1" })!.ref_src).toBe("");
  });
});

describe("Controlled activation: only the allowed test shop", () => {
  const ctl = { ...cfg, allowedShops: ["linkup-test.myshopify.com"] };
  it("install start: allowed shop → Shopify approval with the app's Client ID and LINKUP's scopes; other shops refused", () => {
    const ok = core.shopifyInstall(ctl, new URLSearchParams({ shop: "linkup-test.myshopify.com", state: "s".repeat(40) }));
    const u = new URL(ok.redirect!);
    expect(u.origin + u.pathname).toBe("https://linkup-test.myshopify.com/admin/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("key123");
    expect(u.searchParams.get("scope")).toBe("read_orders,read_products,write_discounts,write_pixels,read_customer_events");
    expect(u.searchParams.get("redirect_uri")).toBe("https://fn.example/functions/v1/apps/shopify/callback");
    expect(core.shopifyInstall(ctl, new URLSearchParams({ shop: "other.myshopify.com", state: "s".repeat(40) })).redirect).toContain("error=shop_not_allowed");
    expect(core.shopifyInstall(ctl, new URLSearchParams({ shop: "evil.com", state: "s".repeat(40) })).redirect).toContain("error=app_install_failed");
  });
  it("callback from a shop outside the list → refused before any token exchange", async () => {
    let calls = 0; const f: core.Fetch = async (u, i) => { calls++; return shop.f(u, i); };
    const r = await core.shopifyCallback(rpc, f, ctl, signQuery({ code: "c", shop: "other.myshopify.com", state: "x", timestamp: "1" }));
    expect(r.redirect).toContain("error=shop_not_allowed");
    expect(calls).toBe(0);
  });
  it("order webhook / pixel claim from a shop outside the list → ignored", async () => {
    const h = hook("orders/create", order(940001), "A1");   // signed for linkshop.myshopify.com, which isn't allowed here
    expect((await core.shopifyWebhook(rpc, ctl, h.headers, h.raw, shop.f)).body).toMatchObject({ ignored: "shop_not_allowed" });
    expect((await core.shopifyRef(rpc, shop.f, ctl, JSON.stringify({ shop: "linkshop.myshopify.com", order: "1", ref: sref(code, now()) }))).body)
      .toMatchObject({ ignored: "shop_not_allowed" });
    expect(await attr("940001")).toEqual([]);
  });
  it("web: the app is offered only for the test shop (until a launch flag is set)", async () => {
    const { shopifyAppOffered, SHOPIFY_SCOPES } = await import("../../src/lib/app-test-shops");
    expect(shopifyAppOffered("linkup-test.myshopify.com")).toBe(true);
    expect(shopifyAppOffered("someone.myshopify.com")).toBe(false);
    expect(SHOPIFY_SCOPES.split(",")).toEqual(core.SHOPIFY_SCOPES);
  });
});

describe("Shopify reliability: expiring tokens, real component check, partial state, recovery", () => {
  it("tokens: stored with refresh token; refreshed shortly before expiry; rotated refresh token saved; old plain tokens still work", async () => {
    const t = core.parseToken(core.packToken({ a: "A1", r: "R1", e: 1000, re: 9000 }))!;
    expect(t).toEqual({ a: "A1", r: "R1", e: 1000, re: 9000 });
    expect(core.parseToken("shpat_plain")).toEqual({ a: "shpat_plain" });
    expect(core.parseToken("revoked")).toBeNull();
    await call(svc, "app_save_token", { p_connection: conn, p_token: core.packToken({ a: "OLD", r: "R1", e: now() + 60, re: now() + 86400 }) });
    let refreshCalls = 0;
    const f: core.Fetch = async (url, init) => {
      const b = init?.body ? JSON.parse(init.body) : {};
      if (url.endsWith("/admin/oauth/access_token") && b.grant_type === "refresh_token") {
        refreshCalls++; await new Promise((r) => setTimeout(r, 20));
        return b.refresh_token === "R1" ? res(200, { access_token: "NEW", expires_in: 3600, refresh_token: "R2", refresh_token_expires_in: 7776000 }) : res(400, {});
      }
      return shop.f(url, init);
    };
    const [x, y] = await Promise.all([core.shopifyAccess(rpc, f, cfg, conn), core.shopifyAccess(rpc, f, cfg, conn)]);
    expect([x?.token, y?.token]).toEqual(["NEW", "NEW"]);
    expect(refreshCalls).toBe(1);                       // parallel requests share one refresh
    const saved = core.parseToken((await call(svc, "app_credentials", { p_connection: conn })).token)!;
    expect(saved).toMatchObject({ a: "NEW", r: "R2" });
    expect((await core.shopifyAccess(rpc, f, cfg, conn))?.token).toBe("NEW");   // still valid → no refresh
    expect(refreshCalls).toBe(1);
  });
  it("refresh fails but another instance already refreshed → uses the newer stored token; nothing valid → recorded, no token", async () => {
    await call(svc, "app_save_token", { p_connection: conn, p_token: core.packToken({ a: "STALE", r: "USED", e: now() + 10, re: now() + 86400 }) });
    const f: core.Fetch = async (url, init) => {
      if (url.endsWith("/admin/oauth/access_token")) {   // simulate: another instance refreshed just before us
        await call(svc, "app_save_token", { p_connection: conn, p_token: core.packToken({ a: "FROM_OTHER", r: "R9", e: now() + 3600, re: now() + 86400 }) });
        return res(400, { error: "invalid_grant" });
      }
      return shop.f(url, init);
    };
    expect((await core.shopifyAccess(rpc, f, cfg, conn))?.token).toBe("FROM_OTHER");
    await call(svc, "app_save_token", { p_connection: conn, p_token: core.packToken({ a: "STALE", r: "BAD", e: now() + 10, re: now() + 86400 }) });
    const g: core.Fetch = async (url, init) => (url.endsWith("/admin/oauth/access_token") ? res(400, {}) : shop.f(url, init));
    expect(await core.shopifyAccess(rpc, g, cfg, conn)).toBeNull();
    expect((await q(`select last_error from store_connections where id = $1`, [conn]))[0].last_error).toBe("app_sync: token_refresh_failed");
    await call(svc, "app_save_token", { p_connection: conn, p_token: core.packToken({ a: "shpat_x", r: "R1", e: now() + 3600, re: now() + 86400 }) });
  });
  it("order webhooks refused by Shopify (no protected-data access) → partial, NOT connected, no success message", async () => {
    const st = await call(u.other!, "create_organization", { p_type: "store", p_name: "Partial Shop" });
    const state = await call(u.other!, "start_app_install", { p_org: st, p_platform: "shopify", p_shop: "partialshop.myshopify.com" });
    HOOKS.topics.clear(); HOOKS.pixel = false; HOOKS.block = new Set(["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED"]);
    const r = await core.shopifyCallback(rpc, shop.f, cfg, signQuery({ code: "c", shop: "partialshop.myshopify.com", state, timestamp: "1" }));
    expect(r.redirect).toContain("error=app_partial");
    expect(r.redirect).not.toContain("app_connected");
    const c = (await q(`select status, last_error from store_connections where org_id = $1`, [st]))[0];
    expect(c).toEqual({ status: "pending", last_error: "app_sync: partial:orders_create,orders_updated,orders_cancelled" });
    expect((await q(`select founders_until from organizations where id = $1`, [st]))[0].founders_until).toBeNull();   // clock not started
    // Access granted later → "complete the connection" (same OAuth again, no uninstall) → only what was missing is created
    HOOKS.block.clear();
    const state2 = await call(u.other!, "start_app_install", { p_org: st, p_platform: "shopify", p_shop: "partialshop.myshopify.com" });
    const before = HOOKS.topics.size;
    const r2 = await core.shopifyCallback(rpc, shop.f, cfg, signQuery({ code: "c", shop: "partialshop.myshopify.com", state: state2, timestamp: "1" }));
    expect(r2.redirect).toContain("ok=app_connected");
    expect(HOOKS.topics.size).toBe(before + 3);
    expect((await q(`select status, last_error from store_connections where org_id = $1`, [st]))[0]).toEqual({ status: "connected", last_error: null });
  });
  it("live check: an old non-expiring token rejected by Shopify → 'reconnect' (nothing deleted); missing parts → 'partial'; all present → 'ok'", async () => {
    const rejectPlain: core.Fetch = async (url, init) =>
      (init?.headers?.["X-Shopify-Access-Token"] === "shpat_plain" ? res(403, { errors: "Non-expiring access tokens are no longer accepted" }) : shop.f(url, init));
    await call(svc, "app_save_token", { p_connection: conn, p_token: "shpat_plain" });
    expect(await core.shopifyCheck(rpc, rejectPlain, cfg, conn)).toEqual({ state: "reconnect" });
    expect((await q(`select status, last_error from store_connections where id = $1`, [conn]))[0])
      .toEqual({ status: "connected", last_error: "app_sync: token_invalid" });   // shown as "action needed"; no data removed
    await call(svc, "app_save_token", { p_connection: conn, p_token: core.packToken({ a: "shpat_x", r: "R1", e: now() + 3600, re: now() + 86400 }) });
    HOOKS.topics = new Set(["APP_UNINSTALLED"]); HOOKS.pixel = true; HOOKS.block.clear();
    expect(await core.shopifyCheck(rpc, rejectPlain, cfg, conn)).toEqual({ state: "partial", missing: ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED"] });
    expect(HOOKS.topics.size).toBe(1);   // the check itself never creates anything
    HOOKS.topics = new Set(core.SHOPIFY_TOPICS);
    expect(await core.shopifyCheck(rpc, rejectPlain, cfg, conn)).toEqual({ state: "ok" });
  });
  it("components that already exist are not created again", async () => {
    HOOKS.topics = new Set(core.SHOPIFY_TOPICS); HOOKS.pixel = true; let creates = 0;
    const f: core.Fetch = async (url, init) => { if (init?.body?.includes("webhookSubscriptionCreate")) creates++; return shop.f(url, init); };
    expect(await core.shopifyEnsureComponents(f, cfg, "linkshop.myshopify.com", "t")).toEqual([]);
    expect(creates).toBe(0);
  });
  it("opened from Shopify admin (signed): missing connection → LINKUP connect page to finish; unsigned → ignored", async () => {
    const ts = String(now());
    const ok = await core.shopifyOpen(rpc, cfg, signQuery({ shop: "newshop.myshopify.com", timestamp: ts, host: "x" }));
    expect(ok.redirect).toBe("https://app.example/app/connect?resume=newshop.myshopify.com");
    const linked = await core.shopifyOpen(rpc, cfg, signQuery({ shop: "linkshop.myshopify.com", timestamp: ts, host: "x" }));
    expect(linked.redirect).toBe(`https://app.example/app/connect?org=${org.store}`);
    const forged = new URLSearchParams({ shop: "newshop.myshopify.com", timestamp: ts, hmac: "00" });
    expect((await core.shopifyOpen(rpc, cfg, forged)).redirect).toBe("https://app.example/app");
    const old = await core.shopifyOpen(rpc, cfg, signQuery({ shop: "newshop.myshopify.com", timestamp: String(now() - 3600) }));
    expect(old.redirect).toBe("https://app.example/app");
    expect((await core.shopifyOpen(rpc, { ...cfg, allowedShops: ["linkup-test.myshopify.com"] }, signQuery({ shop: "newshop.myshopify.com", timestamp: ts }))).redirect).toBe("https://app.example/app");
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
    if (url.includes("/ecom/v1/orders/")) return wixOrderObj && url.endsWith(wixOrderObj.id) ? res(200, { order: wixOrderObj }) : res(404, {});
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
    expect((await beacon({ instance, order: orderGuid, ref: sref(wcode, now()) })).status).toBe(409);   // order not readable yet → script retries
    expect((await beacon({ instance, order: orderGuid, ref: `${wcode}|${now()}` })).body).toMatchObject({ ignored: "untrusted_ref" });
  });
  it("beacon → the order is read from Wix's API (not from the browser) → link attribution; replay counted once", async () => {
    wixOrderObj = wOrder({ priceSummary: { total: { amount: "999" }, tax: { amount: "0" } } });
    wixOrderObj.priceSummary = { total: { amount: "118" }, tax: { amount: "18" } };   // the browser can't change amounts
    expect((await beacon({ instance, order: orderGuid, ref: sref(wcode, now() - 100) })).body).toMatchObject({ ok: true });
    await beacon({ instance, order: orderGuid, ref: sref(wcode, now() - 100) });
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
  it("no 2-hour limit any more: purchase 25 days after the click, beacon 5 hours after the order → credited", async () => {
    // (the agreement must already have existed when the order was placed)
    // (test setup only: agreement history is append-only, so the guard is bypassed for this backdating)
    await q(`set session_replication_role = replica`);
    await q(`update agreement_versions set effective_from = now() - interval '60 days' where agreement_id = (select agreement_id from partner_codes where code = $1)`, [wcode]);
    await q(`set session_replication_role = origin`);
    wixOrderObj = wOrder({ id: "aaaaaaaa-bbbb-4ccc-8ddd-000000005003", number: "5003", createdDate: new Date(Date.now() - 5 * 3600_000).toISOString() });
    const rb = (await beacon({ instance, order: wixOrderObj.id, ref: sref(wcode, now() - 25 * 86400) })).body as any;
    expect(rb.result.attributed).toBe(true);
  });
  it("claim time is separate from the attribution window: an order placed 100 hours ago can't be claimed now", async () => {
    wixOrderObj = wOrder({ id: "aaaaaaaa-bbbb-4ccc-8ddd-000000005002", number: "5002", createdDate: new Date(Date.now() - 100 * 3600_000).toISOString() });
    expect((await beacon({ instance, order: wixOrderObj.id, ref: sref(wcode, now() - 101 * 3600) })).body).toMatchObject({ ignored: "claim_too_late" });
  });
});
