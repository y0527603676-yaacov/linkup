import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";
import * as core from "../../../../supabase/functions/apps/core";

/**
 * Shopify / Wix app connection, end to end against the real database functions (PGlite) and the edge-function logic,
 * with simulated Shopify / Wix servers. Proves: install with approval → connected only after a real API call →
 * coupons created → orders, cancellations and refunds arrive automatically → uninstall disconnects. No manual reporting.
 * Still required before offering it to stores: the same test on a real Shopify development store / Wix test site.
 */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
let u: Record<string, Who> = {}; let org: Record<string, string> = {}; let code = "";
const call = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  return (await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
    keys.map((k) => (typeof args[k] === "object" && args[k] !== null ? JSON.stringify(args[k]) : args[k])))).r;
};
const rpc: core.Rpc = async (fn, args = {}) => { try { return { data: await call(svc, fn, args), error: null }; } catch (e) { return { data: null, error: { message: (e as Error).message } }; } };
const q = <T = any>(sql: string, p: unknown[] = []) => db.as<T>(owner, sql, p);
const cfg: core.Config = { shopifyKey: "key123", shopifySecret: "shpss_secret", wixAppId: "wix-app", wixSecret: "wix-secret",
  functionsBase: "https://fn.example/functions/v1/apps", appBase: "https://app.example" };
const creatorTotal = async (ext: string) => Number((await q(`select coalesce(sum(l.amount_minor),0) n from commission_ledger l join attributions a on a.id = l.attribution_id
  join orders o on o.id = a.order_id where o.external_order_id = $1 and l.party_role = 'creator'`, [ext]))[0].n);

/** Simulated Shopify: token exchange, GraphQL (shop, webhooks, discounts). Records calls. */
function fakeShopify(opts: { scope?: string; shopOk?: boolean } = {}) {
  const calls: { url: string; body: any }[] = []; const discounts = new Map<string, { id: string; title: string }>();
  const f: core.Fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null; calls.push({ url, body });
    const res = (status: number, j: unknown) => ({ ok: status < 400, status, json: async () => j, text: async () => JSON.stringify(j) });
    if (url.endsWith("/admin/oauth/access_token")) return body.code === "good" ? res(200, { access_token: "shpat_x", scope: opts.scope ?? "read_orders,read_products,write_discounts" }) : res(400, {});
    if (url.includes("/graphql.json")) {
      const qy: string = body.query;
      if (qy.includes("shop {")) return opts.shopOk === false ? res(401, {}) : res(200, { data: { shop: { myshopifyDomain: "demo.myshopify.com", primaryDomain: { url: "https://demo.co.il" }, currencyCode: "ILS" } } });
      if (qy.includes("webhookSubscriptionCreate")) return res(200, { data: { webhookSubscriptionCreate: { userErrors: [] } } });
      if (qy.includes("codeDiscountNodeByCode")) { const d = discounts.get(body.variables.code); return res(200, { data: { codeDiscountNodeByCode: d ? { id: d.id, codeDiscount: { title: d.title } } : null } }); }
      if (qy.includes("discountCodeBasicCreate")) { discounts.set(body.variables.d.code, { id: `gid://${body.variables.d.code}`, title: body.variables.d.title }); return res(200, { data: { discountCodeBasicCreate: { codeDiscountNode: { id: `gid://${body.variables.d.code}` }, userErrors: [] } } }); }
    }
    return res(404, {});
  };
  return { f, calls, discounts };
}
const signQuery = (p: Record<string, string>, secret = cfg.shopifySecret!) => {
  const msg = Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join("&");
  return new URLSearchParams({ ...p, hmac: createHmac("sha256", secret).update(msg).digest("hex") });
};
const hook = (topic: string, body: unknown, id: string, secret = cfg.shopifySecret!) => {
  const raw = JSON.stringify(body);
  const h = new Map([["x-shopify-topic", topic], ["x-shopify-shop-domain", "demo.myshopify.com"], ["x-shopify-webhook-id", id],
    ["x-shopify-hmac-sha256", createHmac("sha256", secret).update(raw).digest("base64")]]);
  return { raw, headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null } };
};

beforeAll(async () => {
  db = await createDb();
  for (const k of ["store", "creator", "other", "staff"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@x.co.il`) };
  org.store = await call(u.store!, "create_organization", { p_type: "store", p_name: "Demo Shop" });
  org.other = await call(u.other!, "create_organization", { p_type: "store", p_name: "Other Shop" });
  org.creator = await call(u.creator!, "create_organization", { p_type: "creator", p_name: "Noa" });
  await q(`insert into memberships(user_id, org_id, role) values ($1, $2, 'member')`, [(u.staff as any).userId, org.store]);
  const p = await call(u.store!, "create_proposal", { p_from_org: org.store, p_commission_bps: 1000, p_invitee_name: "Noa", p_invitee_contact: "x" });
  code = (await call(u.creator!, "accept_proposal", { p_token: p.token, p_org: org.creator })).code;
}, 120_000);

describe("Shopify: install with the owner's approval", () => {
  let state = "";
  it("only a store admin starts it; the shop address is validated; the approval link asks only the needed permissions", async () => {
    await expect(call(u.staff!, "start_app_install", { p_org: org.store, p_platform: "shopify", p_shop: "demo.myshopify.com" })).rejects.toThrow(/forbidden/);
    await expect(call(u.store!, "start_app_install", { p_org: org.store, p_platform: "shopify", p_shop: "evil.com" })).rejects.toThrow(/invalid_shop/);
    state = await call(u.store!, "start_app_install", { p_org: org.store, p_platform: "shopify", p_shop: "Demo.myshopify.com" });
    const link = core.shopifyInstallUrl(cfg, "demo.myshopify.com", state)!;
    expect(link).toContain("https://demo.myshopify.com/admin/oauth/authorize?");
    expect(decodeURIComponent(link)).toContain("scope=read_orders,read_products,write_discounts");
    expect(core.shopifyInstallUrl(cfg, "evil.com", state)).toBeNull();
  });
  it("a forged or tampered callback is refused and nothing is stored", async () => {
    const s = fakeShopify();
    const bad = signQuery({ code: "good", shop: "demo.myshopify.com", state, timestamp: "1" }, "wrong-secret");
    expect((await core.shopifyCallback(rpc, s.f, cfg, bad)).redirect).toContain("error=app_install_failed");
    const wrongState = signQuery({ code: "good", shop: "demo.myshopify.com", state: "nope", timestamp: "1" });
    expect((await core.shopifyCallback(rpc, s.f, cfg, wrongState)).redirect).toContain("error=invalid_state");
    expect((await q(`select count(*)::int n from store_app_credentials`))[0].n).toBe(0);
  });
  it("missing permissions → clear error; the store is not connected", async () => {
    const st = await call(u.store!, "start_app_install", { p_org: org.store, p_platform: "shopify", p_shop: "demo.myshopify.com" });
    const s = fakeShopify({ scope: "read_products" });
    expect((await core.shopifyCallback(rpc, s.f, cfg, signQuery({ code: "good", shop: "demo.myshopify.com", state: st, timestamp: "1" }))).redirect).toContain("error=app_scopes_missing");
  });
  it("valid callback: token in Vault, webhooks registered, real API call, then connected and coupons created", async () => {
    const s = fakeShopify();
    const r = await core.shopifyCallback(rpc, s.f, cfg, signQuery({ code: "good", shop: "demo.myshopify.com", state, timestamp: "1" }));
    expect(r.redirect).toContain("ok=app_connected");
    const c = (await q(`select platform, method, status, site_url from store_connections where org_id = $1`, [org.store]))[0];
    expect(c).toEqual({ platform: "shopify", method: "app", status: "connected", site_url: "https://demo.myshopify.com" });
    expect(s.calls.filter((x) => x.body?.query?.includes("webhookSubscriptionCreate")).map((x) => x.body.variables.topic)).toEqual(core.SHOPIFY_TOPICS);
    expect(s.discounts.has(code)).toBe(true);
    expect((await q(`select active from app_coupons where code = upper($1)`, [code]))[0]?.active).toBe(true);   // confirmed in the shop
    expect((await q(`select s.secret from vault.secrets s join store_app_credentials c on c.token_secret = s.id where c.shop = 'demo.myshopify.com'`))[0].secret).toBe("shpat_x");
    expect(await call(u.store!, "tracking_mode", { p_store: org.store })).toBe("automatic");
    // the same state cannot be used twice
    expect((await core.shopifyCallback(rpc, s.f, cfg, signQuery({ code: "good", shop: "demo.myshopify.com", state, timestamp: "2" }))).redirect).toContain("error=invalid_state");
  });
  it("one Shopify shop belongs to one LINKUP store", async () => {
    const st = await call(u.other!, "start_app_install", { p_org: org.other, p_platform: "shopify", p_shop: "demo.myshopify.com" });
    expect((await core.shopifyCallback(rpc, fakeShopify().f, cfg, signQuery({ code: "good", shop: "demo.myshopify.com", state: st, timestamp: "3" }))).redirect)
      .toContain("error=shop_linked_elsewhere");
  });
  it("if the real API call fails, the store is NOT marked connected", async () => {
    const s2 = await call(u.store!, "create_organization", { p_type: "store", p_name: "Second" });
    const st = await call(u.store!, "start_app_install", { p_org: s2, p_platform: "shopify", p_shop: "second.myshopify.com" });
    const r = await core.shopifyCallback(rpc, fakeShopify({ shopOk: false }).f, cfg, signQuery({ code: "good", shop: "second.myshopify.com", state: st, timestamp: "4" }));
    expect(r.redirect).toContain("error=app_not_verified");
    expect((await q(`select status from store_connections where org_id = $1`, [s2]))[0].status).toBe("pending");
  });
});

describe("Shopify: orders, cancellations and refunds arrive automatically", () => {
  const order = (extra: object = {}) => ({ id: 820001, currency: "ILS", total_price: "118.00", total_tax: "18.00", discount_codes: [{ code }],
    financial_status: "paid", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), email: "buyer@example.com", refunds: [], ...extra });
  it("unsigned or wrongly signed webhooks are refused", async () => {
    const h = hook("orders/create", order(), "w0", "wrong");
    expect((await core.shopifyWebhook(rpc, cfg, h.headers, h.raw)).status).toBe(401);
  });
  it("paid order with the partner coupon → commission; the same webhook again → counted once", async () => {
    const h = hook("orders/create", order(), "w1");
    expect((await core.shopifyWebhook(rpc, cfg, h.headers, h.raw)).body).toMatchObject({ ok: true, result: { attributed: true } });
    expect(((await core.shopifyWebhook(rpc, cfg, h.headers, h.raw)).body as any).result.status).toBe("duplicate");
    expect(await creatorTotal("820001")).toBe(1_000);
    const hash = (await q(`select customer_email_hash h from orders where external_order_id = '820001'`))[0].h;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);   // only a hash, never the e-mail
  });
  it("refund and cancellation update the commission automatically", async () => {
    const r1 = hook("orders/updated", order({ financial_status: "partially_refunded", updated_at: new Date(Date.now() + 1000).toISOString(),
      refunds: [{ id: 9, transactions: [{ kind: "refund", status: "success", amount: "59.00" }] }] }), "w2");
    await core.shopifyWebhook(rpc, cfg, r1.headers, r1.raw);
    expect(await creatorTotal("820001")).toBe(500);
    const r2 = hook("orders/cancelled", order({ cancelled_at: new Date().toISOString(), updated_at: new Date(Date.now() + 2000).toISOString() }), "w3");
    await core.shopifyWebhook(rpc, cfg, r2.headers, r2.raw);
    expect(await creatorTotal("820001")).toBe(0);
  });
  it("unpaid order → recorded, no commission yet", async () => {
    const h = hook("orders/create", order({ id: 820002, financial_status: "pending" }), "w4");
    expect(((await core.shopifyWebhook(rpc, cfg, h.headers, h.raw)).body as any).result.attributed).toBe(false);
  });
  it("privacy webhooks answered; uninstall disconnects and revokes the token; later webhooks are ignored", async () => {
    const d = hook("customers/redact", { shop_domain: "demo.myshopify.com" }, "w5");
    expect((await core.shopifyWebhook(rpc, cfg, d.headers, d.raw)).status).toBe(200);
    const un = hook("app/uninstalled", { domain: "demo.myshopify.com" }, "w6");
    expect((await core.shopifyWebhook(rpc, cfg, un.headers, un.raw)).body).toMatchObject({ status: "disconnected" });
    expect((await q(`select status from store_connections where org_id = $1`, [org.store]))[0].status).toBe("disconnected");
    expect((await q(`select s.secret from vault.secrets s join store_app_credentials c on c.token_secret = s.id where c.shop = 'demo.myshopify.com'`))[0].secret).toBe("revoked");
    const late = hook("orders/create", order({ id: 820003 }), "w7");
    expect((await core.shopifyWebhook(rpc, cfg, late.headers, late.raw)).body).toMatchObject({ ignored: "unknown_shop" });
    expect((await q(`select count(*)::int n from orders`))[0].n).toBe(2);   // history kept
  });
  it("app functions are not callable by signed-in users", async () => {
    for (const fn of ["complete_app_install", "app_credentials", "app_uninstalled"])
      await expect(db.as(u.store!, `select public.${fn}(null${fn === "complete_app_install" ? ",null,null,null,null,null,null" : fn === "app_uninstalled" ? ",null" : ""})`)).rejects.toThrow(/permission denied/);
    await expect(db.as(u.store!, `select * from public.store_app_credentials`)).rejects.toThrow(/permission denied/);
  });
});

describe("Wix: install and order webhooks", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const wcfg = { ...cfg, wixPublicKey: pem };
  const instance = "0f5a2c1e-1111-4222-8333-944455556666";
  const b64u = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = (payload: object) => { const h = b64u(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }))), p = b64u(Buffer.from(JSON.stringify(payload)));
    const s = createSign("RSA-SHA256"); s.update(`${h}.${p}`); return `${h}.${p}.${b64u(s.sign(privateKey))}`; };
  const wixFetch: core.Fetch = async (url) => {
    const res = (status: number, j: unknown) => ({ ok: status < 400, status, json: async () => j, text: async () => "" });
    if (url.endsWith("/oauth2/token")) return res(200, { access_token: "wix-token" });
    if (url.endsWith("/apps/v1/instance")) return res(200, { site: { url: "https://shop-w.co.il" } });
    if (url.endsWith("/coupons/query")) return res(200, { coupons: [] });
    if (url.endsWith("/stores/v2/coupons")) return res(200, {});
    return res(404, {});
  };
  it("install: real API call, connected, coupon created; orders and cancellation automatic; removal disconnects", async () => {
    const w = await call(u.other!, "create_organization", { p_type: "store", p_name: "Wix Shop" });
    const p = await call(u.other!, "create_proposal", { p_from_org: w, p_commission_bps: 1000, p_invitee_name: "Noa", p_invitee_contact: "x" });
    const wcode = (await call(u.creator!, "accept_proposal", { p_token: p.token, p_org: org.creator })).code;
    const st = await call(u.other!, "start_app_install", { p_org: w, p_platform: "wix" });
    expect(core.wixInstallUrl(wcfg, st)).toContain("https://www.wix.com/installer/install?appId=wix-app");
    const r = await core.wixCallback(rpc, wixFetch, wcfg, new URLSearchParams({ instanceId: instance, state: st }));
    expect(r.redirect).toContain("ok=app_connected");
    expect((await q(`select platform, method, status, site_url from store_connections where org_id = $1`, [w]))[0])
      .toEqual({ platform: "wix", method: "app", status: "connected", site_url: "https://shop-w.co.il" });
    const order = (status: string, pay: string) => ({ id: "w-1", number: "1001", currency: "ILS", status, paymentStatus: pay,
      priceSummary: { total: { amount: "118" }, tax: { amount: "18" } }, appliedDiscounts: [{ coupon: { code: wcode } }],
      createdDate: new Date().toISOString(), updatedDate: new Date().toISOString() });
    const ev = (type: string, o: object, id: string) => jwt({ data: JSON.stringify({ eventType: `wix.ecom.v1.${type}`, instanceId: instance, id,
      data: JSON.stringify({ actionEvent: { body: { order: o } } }) }) });
    expect((await core.wixWebhook(rpc, wcfg, "not-a-jwt")).status).toBe(401);
    expect(((await core.wixWebhook(rpc, wcfg, ev("order_approved", order("APPROVED", "PAID"), "e1"))).body as any).result.attributed).toBe(true);
    expect(await creatorTotal("1001")).toBe(1_000);
    await new Promise((res) => setTimeout(res, 5));
    await core.wixWebhook(rpc, wcfg, ev("order_canceled", { ...order("CANCELED", "PAID"), updatedDate: new Date(Date.now() + 1000).toISOString() }, "e2"));
    expect(await creatorTotal("1001")).toBe(0);
    await core.wixWebhook(rpc, wcfg, jwt({ data: JSON.stringify({ eventType: "wix.devcenter.apps.v1.app_removed", instanceId: instance }) }));
    expect((await q(`select status from store_connections where org_id = $1`, [w]))[0].status).toBe("disconnected");
  });
});
