import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";
import { handleAuthCallback, handleWebhook, mapOrder, orderRef, registerWebhooks, syncConnection, wooSignature, type Rpc }
  from "../../../../supabase/functions/woo-api/core";

/**
 * WooCommerce without a plugin, end to end against the real migrations and a simulated WooCommerce REST API:
 * approval → keys in vault → webhooks → coupons → orders (webhook + reconcile) → attribution → disconnect clean-up.
 * No network, no money.
 */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const u: Record<string, Who & { userId?: string }> = {};
const org: Record<string, string> = {};
const DELIVERY = "https://fn.test/woo-api/webhook";
const SITE = "https://shop.example.com";

const call = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  const row = await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
    keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k])));
  return row.r;
};
const rpc: Rpc = async (fn, args = {}) => {
  try {
    if (fn === "woo_api_connections") return { data: (await db.as<{ r: string }>(svc, `select public.woo_api_connections() as r`)).map((x) => x.r), error: null };
    return { data: await call(svc, fn, args), error: null };
  } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
};
const q = <T = any>(sql: string, p: unknown[] = []) => db.as<T>(owner, sql, p);

/* ---------- simulated WooCommerce REST API ---------- */
type Store = { key: string; secret: string; coupons: any[]; webhooks: any[]; orders: any[]; products: any[]; calls: string[]; down?: boolean; revoked?: boolean };
const woo: Store = { key: "ck_" + "a".repeat(40), secret: "cs_" + "b".repeat(40), coupons: [], webhooks: [], orders: [], products: [], calls: [] };
let nextId = 100;
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fakeFetch = (async (input: string, init: RequestInit = {}) => {
  const u = new URL(input); const m = init.method ?? "GET"; const path = u.pathname.replace("/wp-json/wc/v3", "");
  woo.calls.push(`${m} ${path}`);
  if (woo.down) throw new TypeError("fetch failed");
  const auth = (init.headers as Record<string, string>).authorization;
  if (woo.revoked || auth !== `Basic ${btoa(`${woo.key}:${woo.secret}`)}`) return res(401, { code: "woocommerce_rest_cannot_view" });
  const body = init.body ? JSON.parse(String(init.body)) : {};
  if (path === "/data/currencies/current") return res(200, { code: "ILS" });
  if (path === "/webhooks" && m === "POST") { const w = { id: nextId++, status: "active", ...body }; woo.webhooks.push(w); return res(201, w); }
  const wm = path.match(/^\/webhooks\/(\d+)$/);
  if (wm) { const w = woo.webhooks.find((x) => x.id === Number(wm[1])); if (!w) return res(404, { code: "woocommerce_rest_webhook_invalid_id" });
    if (m === "PUT") Object.assign(w, body); if (m === "DELETE") woo.webhooks = woo.webhooks.filter((x) => x !== w); return res(200, w); }
  if (path === "/coupons" && m === "GET") return res(200, woo.coupons.filter((c) => c.code === u.searchParams.get("code")));
  if (path === "/coupons" && m === "POST") { const c = { id: nextId++, ...body }; woo.coupons.push(c); return res(201, c); }
  const cm = path.match(/^\/coupons\/(\d+)$/);
  if (cm && m === "PUT") { const c = woo.coupons.find((x) => x.id === Number(cm[1])); Object.assign(c, body); return res(200, c); }
  if (path === "/orders") { const after = u.searchParams.get("modified_after")!;
    return res(200, woo.orders.filter((o) => o.date_modified_gmt >= after).slice(0, 50)); }
  if (path === "/products") { const page = Number(u.searchParams.get("page")); return res(200, woo.products.slice((page - 1) * 100, page * 100)); }
  return res(404, { code: "rest_no_route" });
}) as typeof fetch;

const order = (id: number, o: Record<string, unknown> = {}) => ({
  id, status: "processing", currency: "ILS", total: "236.00", cart_tax: "36.00", shipping_total: "0.00", shipping_tax: "0.00",
  coupon_lines: [], refunds: [], billing: { email: "Buyer@Example.com " }, meta_data: [],
  date_created_gmt: new Date().toISOString().slice(0, 19), date_modified_gmt: new Date().toISOString().slice(0, 19), ...o,
});

let state = ""; let conn = ""; let code = "";
beforeAll(async () => {
  db = await createDb();
  for (const k of ["s", "c", "x"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@woo.test`) };
  org.S = await call(u.s!, "create_organization", { p_type: "store", p_name: "Shop S" });
  org.C = await call(u.c!, "create_organization", { p_type: "creator", p_name: "Creator C" });
  await q(`update app_settings set value = 'true' where key = 'woo_api_connect_open'`);
});

describe("approval in the store (no keys copied)", () => {
  it("only the store's admin can start; HTTPS is required", async () => {
    await expect(call(u.x!, "start_woo_api_connect", { p_org: org.S, p_site_url: SITE })).rejects.toThrow(/forbidden/);
    await expect(call(u.s!, "start_woo_api_connect", { p_org: org.S, p_site_url: "http://shop.example.com" })).rejects.toThrow(/https_required/);
    const r = await call(u.s!, "start_woo_api_connect", { p_org: org.S, p_site_url: SITE });
    expect(r.callback_url).toMatch(/\/woo-api\/auth-callback$/);
    state = r.state;
  });
  it("is hidden from regular stores until the admin opens it", async () => {
    await q(`update app_settings set value = 'false' where key = 'woo_api_connect_open'`);
    await expect(call(u.s!, "start_woo_api_connect", { p_org: org.S, p_site_url: SITE })).rejects.toThrow(/not_available/);
    await q(`update app_settings set value = 'true' where key = 'woo_api_connect_open'`);
  });
  it("rejects a wrong state, read-only keys and malformed keys", async () => {
    const bad = (o: Record<string, unknown>) => handleAuthCallback(rpc, JSON.stringify({ key_id: 1, user_id: state, consumer_key: woo.key, consumer_secret: woo.secret, key_permissions: "read_write", ...o }));
    expect((await bad({ user_id: "nope" })).body).toEqual({ error: "invalid_state" });
    expect((await bad({ key_permissions: "read" })).body).toEqual({ error: "insufficient_permissions" });
    expect((await bad({ consumer_key: "ck_xyz" })).body).toEqual({ error: "invalid_keys" });
  });
  it("WooCommerce's key delivery creates the connection; keys live only in vault", async () => {
    const r = await handleAuthCallback(rpc, JSON.stringify({ key_id: 7, user_id: state, consumer_key: woo.key, consumer_secret: woo.secret, key_permissions: "read_write" }));
    expect(r.status).toBe(200); conn = r.connectionId!;
    const [sc] = await q(`select method, status, site_url from store_connections where id = $1`, [conn]);
    expect(sc).toEqual({ method: "api", status: "pending", site_url: SITE });
    const [plain] = await q(`select count(*)::int n from store_api_credentials c where c::text like '%' || $1 || '%'`, [woo.secret]);
    expect(plain.n).toBe(0);
    // a state is single-use
    expect((await handleAuthCallback(rpc, JSON.stringify({ user_id: state, consumer_key: woo.key, consumer_secret: woo.secret, key_permissions: "read_write" }))).body).toEqual({ error: "invalid_state" });
    // users cannot read credentials
    await expect(db.as(u.s!, `select public.woo_api_credentials($1)`, [conn])).rejects.toThrow(/permission denied/);
    await expect(db.as(u.s!, `select * from store_api_credentials`)).rejects.toThrow(/permission denied/);
    // the store's founders period starts as with the plugin
    const [o] = await q(`select founders_until is not null as f from organizations where id = $1`, [org.S]);
    expect(o.f).toBe(true);
  });
  it("the return page sees the progress; only the store's admin may look", async () => {
    expect(await call(u.s!, "woo_api_request_status", { p_state: state })).toMatchObject({ completed: true, status: "pending" });
    await expect(call(u.x!, "woo_api_request_status", { p_state: state })).rejects.toThrow(/not_found/);
  });
});

describe("first sync", () => {
  it("registers four signed webhooks once, products synced, connection live", async () => {
    woo.products = Array.from({ length: 3 }, (_, i) => ({ id: i + 1, name: `<b>Ring ${i + 1}</b>`, permalink: `${SITE}/p/${i + 1}`, images: [{ src: `${SITE}/i${i}.jpg` }],
      price: "120.50", stock_status: "instock", manage_stock: false, categories: [{ name: "Rings" }], status: "publish", catalog_visibility: "visible", type: "simple" }));
    const r = await syncConnection(rpc, fakeFetch, conn, DELIVERY);
    expect(r).toMatchObject({ error: null, products: 3 });
    expect(woo.webhooks.map((w) => w.topic).sort()).toEqual(["order.created", "order.updated", "product.created", "product.updated"]);
    expect(woo.webhooks.every((w) => w.delivery_url === `${DELIVERY}?c=${conn}` && w.secret.length >= 32)).toBe(true);
    const [sc] = await q(`select status, plugin_version, last_error from store_connections where id = $1`, [conn]);
    expect(sc).toEqual({ status: "connected", plugin_version: "api", last_error: null });
    const [p] = await q(`select name, price_minor, in_stock from products where external_id = '1' and store_org_id = $1`, [org.S]);
    expect(p).toEqual({ name: "Ring 1", price_minor: 12050, in_stock: true });
    await syncConnection(rpc, fakeFetch, conn, DELIVERY);
    expect(woo.webhooks).toHaveLength(4);   // not duplicated
  });
  it("a webhook WooCommerce disabled after failures is re-enabled", async () => {
    woo.webhooks[0].status = "disabled";
    await syncConnection(rpc, fakeFetch, conn, DELIVERY);
    expect(woo.webhooks[0].status).toBe("active");
  });
});

describe("partner coupons are kept in the store", () => {
  it("a new partnership's coupon is created; the store's own coupons are never touched", async () => {
    woo.coupons.push({ id: 1, code: "summer", amount: "15", discount_type: "percent", description: "store's own", meta_data: [] });
    const p = await call(u.s!, "create_proposal", { p_from_org: org.S, p_commission_bps: 1000, p_invitee_name: "C", p_invitee_contact: null,
      p_coupon_discount_pct: 10, p_attribution_days: 30, p_target_site_url: null, p_source_proposal: null });
    const r = await call(u.c!, "accept_proposal", { p_token: p.token, p_org: org.C });
    code = r.code;
    await syncConnection(rpc, fakeFetch, conn, DELIVERY);
    const c = woo.coupons.find((x) => x.code === code.toLowerCase());
    expect(c).toMatchObject({ amount: "10", discount_type: "percent", date_expires: null, meta_data: [{ key: "linkup_managed", value: "1" }] });
    expect(woo.coupons.find((x) => x.code === "summer")).toMatchObject({ amount: "15", description: "store's own" });
  });
});

describe("orders", () => {
  it("a signed order webhook is ingested and attributed by coupon; a bad signature is refused", async () => {
    const [cr] = await q(`select public.woo_api_credentials($1) as c`, [conn]);
    const body = JSON.stringify(order(501, { coupon_lines: [{ code: code.toLowerCase() }] }));
    const h = async (sig: string) => new Headers({ "x-wc-webhook-signature": sig, "x-wc-webhook-topic": "order.created" });
    expect((await handleWebhook(rpc, conn, await h(await wooSignature("wrong", body)), body)).status).toBe(401);
    expect((await handleWebhook(rpc, conn, await h(await wooSignature(cr.c.webhook_secret, body)), body)).status).toBe(200);
    expect((await handleWebhook(rpc, conn, new Headers(), "webhook_id=55")).status).toBe(200);   // creation ping
    const [a] = await q(`select count(*)::int n from attributions a join orders o on o.id = a.order_id where o.external_order_id = '501' and o.store_org_id = $1`, [org.S]);
    expect(a.n).toBe(1);
  });
  it("the same order from webhook and reconcile (or plugin) is counted once", async () => {
    woo.orders = [order(501, { coupon_lines: [{ code: code.toLowerCase() }] }), order(502)];
    woo.orders[0].date_modified_gmt = woo.orders[1].date_modified_gmt;
    await syncConnection(rpc, fakeFetch, conn, DELIVERY);
    await syncConnection(rpc, fakeFetch, conn, DELIVERY);
    const [o] = await q(`select count(*)::int n from orders where store_org_id = $1`, [org.S]);
    const [a] = await q(`select count(*)::int n from attributions a join orders o on o.id = a.order_id where o.store_org_id = $1`, [org.S]);
    expect(o.n).toBe(2); expect(a.n).toBe(1);
  });
  it("a link sale without coupon is attributed from WooCommerce Order Attribution (same visit)", async () => {
    const [cr] = await q(`select public.woo_api_credentials($1) as c`, [conn]);
    const now = new Date().toISOString().slice(0, 19);
    const body = JSON.stringify(order(503, { meta_data: [{ key: "_wc_order_attribution_utm_source", value: "linkup" },
      { key: "_wc_order_attribution_utm_campaign", value: code }, { key: "_wc_order_attribution_session_start_time", value: now.replace("T", " ") }] }));
    const r = await handleWebhook(rpc, conn, new Headers({ "x-wc-webhook-signature": await wooSignature(cr.c.webhook_secret, body), "x-wc-webhook-topic": "order.updated" }), body);
    expect(r.status).toBe(200);
    const [a] = await q(`select a.method from attributions a join orders o on o.id = a.order_id where o.external_order_id = '503' and o.store_org_id = $1`, [org.S]);
    expect(a?.method).toBe("link");
  });
  it("mapping matches the plugin: amounts in minor units, hashed e-mail, refunds, link referral from Order Attribution", async () => {
    const e = await mapOrder(order(9, { refunds: [{ id: 3, total: "-50.00" }], meta_data: [{ key: "_wc_order_attribution_utm_source", value: "linkup" }, { key: "_wc_order_attribution_utm_campaign", value: "ab12cd" }] }));
    expect(e.order).toMatchObject({ total: 23600, tax: 3600, refunds: [{ id: "3", amount: 5000 }] });
    expect(e.order.ref).toMatch(/^AB12CD\|\d{10}$/);
    expect(e.order.email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e.event_id).toMatch(/^o9-m\d+-r1-processing$/);
    expect(orderRef({ meta_data: [{ key: "_wc_order_attribution_utm_source", value: "google" }, { key: "_wc_order_attribution_utm_campaign", value: "ab12cd" }] })).toBe("");
  });
});

describe("failures are shown, not hidden", () => {
  it("store unreachable / keys revoked → clear status; recovery clears it", async () => {
    woo.down = true;
    expect((await syncConnection(rpc, fakeFetch, conn, DELIVERY)).error).toBe("store_unreachable");
    woo.down = false; woo.revoked = true;
    expect((await syncConnection(rpc, fakeFetch, conn, DELIVERY)).error).toBe("access_revoked");
    const [sc] = await q(`select last_error from store_connections where id = $1`, [conn]);
    expect(sc.last_error).toBe("access_revoked");
    woo.revoked = false;
    await syncConnection(rpc, fakeFetch, conn, DELIVERY);
    const [ok] = await q(`select last_error from store_connections where id = $1`, [conn]);
    expect(ok.last_error).toBeNull();
  });
  it("'sync now' is store-admin only and rate-limited", async () => {
    await expect(call(u.x!, "request_woo_api_sync", { p_org: org.S })).rejects.toThrow(/forbidden/);
    await call(u.s!, "request_woo_api_sync", { p_org: org.S });
    await expect(call(u.s!, "request_woo_api_sync", { p_org: org.S })).rejects.toThrow(/too_many/);
    const [n] = await q(`select count(*)::int n from net.calls where url like '%/woo-api/sync'`);
    expect(n.n).toBe(1);
  });
});

describe("plugin connections are untouched; disconnect cleans up", () => {
  it("an existing plugin connection keeps its secret when the store also approves the API", async () => {
    const pk = await call(u.s!, "create_store_connection", { p_org: org.S, p_site_url: "https://other.example.com" });
    const [before] = await q(`select secret from store_connection_secrets where connection_id = $1`, [pk.connection_id]);
    const st = await call(u.s!, "start_woo_api_connect", { p_org: org.S, p_site_url: "https://other.example.com" });
    const r = await handleAuthCallback(rpc, JSON.stringify({ user_id: st.state, consumer_key: "ck_" + "c".repeat(40), consumer_secret: "cs_" + "d".repeat(40), key_permissions: "read_write" }));
    expect(r.connectionId).toBe(pk.connection_id);
    const [after] = await q(`select secret from store_connection_secrets where connection_id = $1`, [pk.connection_id]);
    expect(after.secret).toBe(before.secret);
  });
  it("after disconnect the next run removes our webhooks and forgets the keys", async () => {
    await q(`update store_connections set status = 'disconnected' where id = $1`, [conn]);
    const r = await syncConnection(rpc, fakeFetch, conn, DELIVERY);
    expect(r).toMatchObject({ forgotten: true });
    expect(woo.webhooks).toHaveLength(0);
    const [n] = await q(`select count(*)::int n from store_api_credentials where connection_id = $1`, [conn]);
    expect(n.n).toBe(0);
  });
});
