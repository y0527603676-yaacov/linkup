// LINKUP ↔ Shopify / Wix apps. Pure logic (no Deno/Node specifics): rpc, fetch and config are injected, so it is
// unit-tested with fakes. Uses only Web Crypto.
//
// Flow (no developer, no manual reporting):
//   1. Owner enters the shop address in LINKUP → start_app_install (state) → platform's approval screen.
//   2. Platform redirects back → callback: verify, exchange the code for a token, store it (complete_app_install),
//      register order webhooks, make a real API call to the shop; only then mark the store connected (plugin_sync)
//      and create the partner coupons in the shop.
//   3. Webhooks: verify the platform signature, map the order to LINKUP's format, ingest_order_event
//      (same engine as WooCommerce: unique order ids, duplicates ignored, cancellations/refunds reverse commissions).
//   4. Uninstall / shop erasure request → disconnect (history kept).

export type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: { message: string } | null }>;
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;
export type Config = {
  shopifyKey?: string; shopifySecret?: string; shopifyApiVersion?: string;
  wixAppId?: string; wixSecret?: string; wixPublicKey?: string;
  functionsBase: string;   // https://<project>.supabase.co/functions/v1/apps
  appBase: string;         // https://linkup… (where the owner returns)
};
export type Reply = { status: number; body?: unknown; redirect?: string };

export const SHOPIFY_SCOPES = ["read_orders", "read_products", "write_discounts"];
export const SHOPIFY_TOPICS = ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "APP_UNINSTALLED"];
const SHOP_RE = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
const enc = new TextEncoder();

/* ---------- crypto helpers ---------- */
async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => { let s = ""; b.forEach((x) => (s += String.fromCharCode(x))); return btoa(s); };
function same(a: string, b: string) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
export async function sha256Hex(s: string) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))); }

/** Shopify OAuth callback: hex HMAC over the sorted query (without hmac). */
export async function verifyShopifyQuery(params: URLSearchParams, secret: string): Promise<boolean> {
  const given = params.get("hmac") ?? ""; if (!given || !secret) return false;
  const msg = [...params.entries()].filter(([k]) => k !== "hmac" && k !== "signature").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join("&");
  return same(hex(await hmac(secret, msg)), given.toLowerCase());
}
/** Shopify webhook: base64 HMAC over the raw body. */
export async function verifyShopifyWebhook(raw: string, header: string | null, secret: string): Promise<boolean> {
  if (!header || !secret) return false;
  return same(b64(await hmac(secret, raw)), header);
}
const b64uDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
/** Wix webhook: the body is a JWT (RS256) signed by Wix with the app's key. */
export async function verifyWixJwt(jwt: string, publicKeyPem: string): Promise<Record<string, any> | null> {
  try {
    const [h, p, s] = jwt.trim().split("."); if (!h || !p || !s || !publicKeyPem) return null;
    if (JSON.parse(new TextDecoder().decode(b64uDecode(h))).alg !== "RS256") return null;
    const der = b64uDecode(publicKeyPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "").replace(/\+/g, "-").replace(/\//g, "_"));
    const key = await crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64uDecode(s), enc.encode(`${h}.${p}`)))) return null;
    return JSON.parse(new TextDecoder().decode(b64uDecode(p)));
  } catch { return null; }
}

/* ---------- order mapping (one format for the whole engine) ---------- */
const ZERO_DEC = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "HUF", "TWD", "UGX", "XAF", "XOF"]);
export function toMinor(v: unknown, currency: string): number {
  const s = String(v ?? "0").trim(); if (!/^-?\d+(\.\d+)?$/.test(s)) return 0;
  const dec = ZERO_DEC.has(currency.toUpperCase()) ? 0 : 2; const [i, f = ""] = s.replace("-", "").split(".");
  const n = Number(i) * 10 ** dec + Number((f + "00").slice(0, dec) || 0) + (Number(f[dec] ?? 0) >= 5 ? 1 : 0);
  return s.startsWith("-") ? -n : n;
}
export type NormalizedOrder = { id: string; status: string; currency: string; total: number; tax: number; shipping: number; shipping_tax: number;
  coupons: string[]; ref: string; email_hash: string; created_at: string; refunds: { id: string; amount: number }[] };

export function shopifyOrder(o: any, emailHash = ""): NormalizedOrder | null {
  if (o?.id == null || !o.currency) return null;
  const cur = String(o.currency).toUpperCase(); const fs = o.financial_status ?? "";
  const status = o.cancelled_at || fs === "voided" ? "cancelled" : fs === "refunded" ? "refunded"
    : ["paid", "partially_refunded"].includes(fs) ? (o.fulfillment_status === "fulfilled" ? "completed" : "processing") : "pending";
  const ref = (o.note_attributes ?? []).find((a: any) => a?.name === "linkup_ref")?.value ?? "";
  return {
    id: String(o.id), status, currency: cur, total: toMinor(o.total_price, cur), tax: toMinor(o.total_tax, cur),
    shipping: toMinor(o.total_shipping_price_set?.shop_money?.amount, cur),
    shipping_tax: (o.shipping_lines ?? []).flatMap((l: any) => l.tax_lines ?? []).reduce((s: number, t: any) => s + toMinor(t.price, cur), 0),
    coupons: (o.discount_codes ?? []).map((d: any) => String(d?.code ?? "")).filter(Boolean),
    ref: /^[A-Za-z0-9]{4,16}\|\d{9,11}$/.test(ref) ? ref : "", email_hash: emailHash,
    created_at: o.created_at ?? new Date().toISOString(),
    refunds: (o.refunds ?? []).map((r: any) => ({ id: String(r.id), amount: (r.transactions ?? [])
      .filter((t: any) => t.kind === "refund" && t.status === "success").reduce((s: number, t: any) => s + toMinor(t.amount, cur), 0) }))
      .filter((r: { amount: number }) => r.amount > 0),
  };
}
export function wixOrder(o: any): NormalizedOrder | null {
  if (!o?.id || !o.currency) return null;
  const cur = String(o.currency).toUpperCase(); const total = toMinor(o.priceSummary?.total?.amount, cur);
  const status = o.status === "CANCELED" ? "cancelled" : o.paymentStatus === "FULLY_REFUNDED" ? "refunded"
    : ["PAID", "PARTIALLY_REFUNDED"].includes(o.paymentStatus) ? (o.fulfillmentStatus === "FULFILLED" ? "completed" : "processing") : "pending";
  return {
    id: String(o.number ?? o.id), status, currency: cur, total, tax: toMinor(o.priceSummary?.tax?.amount, cur),
    shipping: toMinor(o.priceSummary?.shipping?.amount, cur), shipping_tax: 0,
    coupons: (o.appliedDiscounts ?? []).map((d: any) => String(d?.coupon?.code ?? "")).filter(Boolean),
    ref: "", email_hash: "", created_at: o.createdDate ?? new Date().toISOString(),
    refunds: o.paymentStatus === "FULLY_REFUNDED" ? [{ id: "full", amount: total }] : [],
  };
}

/* ---------- Shopify ---------- */
const gql = (fetchFn: Fetch, cfg: Config, shop: string, token: string, query: string, variables: Record<string, unknown> = {}) =>
  fetchFn(`https://${shop}/admin/api/${cfg.shopifyApiVersion ?? "2026-07"}/graphql.json`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token }, body: JSON.stringify({ query, variables }),
  });

export function shopifyInstallUrl(cfg: Config, shop: string, state: string): string | null {
  if (!SHOP_RE.test(shop) || !cfg.shopifyKey) return null;
  const q = new URLSearchParams({ client_id: cfg.shopifyKey, scope: SHOPIFY_SCOPES.join(","), redirect_uri: `${cfg.functionsBase}/shopify/callback`, state });
  return `https://${shop}/admin/oauth/authorize?${q}`;
}

const back = (cfg: Config, params: Record<string, string>) => `${cfg.appBase}/app/connect?${new URLSearchParams(params)}`;

export async function shopifyCallback(rpc: Rpc, fetchFn: Fetch, cfg: Config, params: URLSearchParams): Promise<Reply> {
  const shop = (params.get("shop") ?? "").toLowerCase(); const state = params.get("state") ?? ""; const code = params.get("code") ?? "";
  if (!SHOP_RE.test(shop) || !state || !code || !(await verifyShopifyQuery(params, cfg.shopifySecret ?? ""))) {
    return { status: 302, redirect: back(cfg, { error: "app_install_failed" }) };
  }
  const tr = await fetchFn(`https://${shop}/admin/oauth/access_token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: cfg.shopifyKey, client_secret: cfg.shopifySecret, code }),
  });
  if (!tr.ok) return { status: 302, redirect: back(cfg, { error: "app_install_failed" }) };
  const tok = await tr.json() as { access_token?: string; scope?: string };
  const granted = new Set(String(tok.scope ?? "").split(",").map((s) => s.trim()));
  if (!tok.access_token || !SHOPIFY_SCOPES.every((s) => granted.has(s) || (s.startsWith("read_") && granted.has(s.replace("read_", "write_"))))) {
    return { status: 302, redirect: back(cfg, { error: "app_scopes_missing" }) };
  }
  const done = await rpc("complete_app_install", { p_state: state, p_platform: "shopify", p_shop: shop, p_token: tok.access_token,
    p_refresh: null, p_scopes: tok.scope ?? "", p_site_url: null });
  if (done.error) return { status: 302, redirect: back(cfg, { error: done.error.message.match(/[a-z_]{6,}/)?.[0] ?? "app_install_failed" }) };
  const { connection_id: conn, org_id: org } = done.data as { connection_id: string; org_id: string };
  const verified = await shopifyActivate(rpc, fetchFn, cfg, conn);
  return { status: 302, redirect: back(cfg, verified ? { org, ok: "app_connected" } : { org, error: "app_not_verified" }) };
}

/** Real API call to the shop + webhooks + coupons; only then "connected". */
export async function shopifyActivate(rpc: Rpc, fetchFn: Fetch, cfg: Config, conn: string): Promise<boolean> {
  const c = (await rpc("app_credentials", { p_connection: conn })).data as { shop: string; token: string } | null;
  if (!c) return false;
  const r = await gql(fetchFn, cfg, c.shop, c.token, "{ shop { myshopifyDomain primaryDomain { url } currencyCode } }");
  const j = r.ok ? await r.json() : null;
  if (!j?.data?.shop?.myshopifyDomain) return false;
  for (const topic of SHOPIFY_TOPICS) {
    await gql(fetchFn, cfg, c.shop, c.token,
      `mutation($topic: WebhookSubscriptionTopic!, $url: URL!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: { callbackUrl: $url, format: JSON }) { userErrors { message } } }`,
      { topic, url: `${cfg.functionsBase}/shopify/webhook` });
  }
  const sync = await rpc("plugin_sync", { p_connection: conn, p_plugin_version: "shopify-app" });
  if (sync.error) return false;
  await shopifySyncCoupons(fetchFn, cfg, c.shop, c.token, (sync.data?.coupons ?? []) as Coupon[]);
  return true;
}

type Coupon = { code: string; discount_pct: number; active: boolean };
/** Creates missing partner coupons in the shop and deactivates coupons LINKUP turned off. Never touches other discounts. */
export async function shopifySyncCoupons(fetchFn: Fetch, cfg: Config, shop: string, token: string, coupons: Coupon[]) {
  const out = { created: 0, deactivated: 0, kept: 0 };
  for (const cp of coupons) {
    const q = await gql(fetchFn, cfg, shop, token, `query($code: String!) { codeDiscountNodeByCode(code: $code) { id codeDiscount { ... on DiscountCodeBasic { status title } } } }`, { code: cp.code });
    const node = q.ok ? (await q.json())?.data?.codeDiscountNodeByCode : null;
    if (!node && cp.active) {
      await gql(fetchFn, cfg, shop, token,
        `mutation($d: DiscountCodeBasicInput!) { discountCodeBasicCreate(basicCodeDiscount: $d) { userErrors { message } } }`,
        { d: { title: `LINKUP ${cp.code}`, code: cp.code, startsAt: new Date().toISOString(), customerSelection: { all: true },
               customerGets: { value: { percentage: Math.max(0, Math.min(100, cp.discount_pct)) / 100 }, items: { all: true } } } });
      out.created++;
    } else if (node && !cp.active && String(node.codeDiscount?.title ?? "").startsWith("LINKUP ")) {
      await gql(fetchFn, cfg, shop, token, `mutation($id: ID!) { discountCodeDeactivate(id: $id) { userErrors { message } } }`, { id: node.id });
      out.deactivated++;
    } else out.kept++;
  }
  return out;
}

export async function shopifyWebhook(rpc: Rpc, cfg: Config, headers: { get(k: string): string | null }, raw: string): Promise<Reply> {
  if (!(await verifyShopifyWebhook(raw, headers.get("x-shopify-hmac-sha256"), cfg.shopifySecret ?? ""))) return { status: 401, body: { error: "unauthorized" } };
  const topic = headers.get("x-shopify-topic") ?? ""; const shop = (headers.get("x-shopify-shop-domain") ?? "").toLowerCase();
  const id = headers.get("x-shopify-webhook-id") ?? headers.get("x-shopify-event-id") ?? "";
  let body: any; try { body = JSON.parse(raw); } catch { return { status: 400, body: { error: "invalid_json" } }; }
  // Mandatory privacy webhooks: LINKUP stores no customer names/contacts (only an e-mail hash for self-referral checks).
  if (topic === "customers/data_request" || topic === "customers/redact") return { status: 200, body: { ok: true, stored_customer_data: "none" } };
  if (topic === "app/uninstalled" || topic === "shop/redact") {
    const r = await rpc("app_uninstalled", { p_platform: "shopify", p_shop: shop || String(body?.shop_domain ?? "") });
    return { status: 200, body: { ok: true, ...(r.data ?? {}) } };
  }
  if (!topic.startsWith("orders/")) return { status: 200, body: { ok: true, ignored: topic } };
  const c = (await rpc("app_connection_by_shop", { p_platform: "shopify", p_shop: shop })).data as { connection_id: string } | null;
  if (!c) return { status: 200, body: { ok: true, ignored: "unknown_shop" } };
  const emailHash = typeof body?.email === "string" && body.email.includes("@") ? await sha256Hex(body.email.trim().toLowerCase()) : "";
  const order = shopifyOrder(body, emailHash);
  if (!order) return { status: 200, body: { ok: true, ignored: "not_an_order" } };
  const at = body.updated_at ?? body.created_at ?? new Date().toISOString();
  const r = await rpc("ingest_order_event", { p_connection: c.connection_id, p_event: {
    event_id: `shopify:${id || `${order.id}:${at}`}`, type: `order.${topic.replace("orders/", "")}`, occurred_at: at, order } });
  if (r.error) {
    if (/connection_disconnected|invalid_event/.test(r.error.message)) return { status: 200, body: { ok: false, error: r.error.message.match(/[a-z_]{6,}/)?.[0] } };
    return { status: 500, body: { error: "temporary_error" } };   // Shopify retries
  }
  return { status: 200, body: { ok: true, result: r.data } };
}

/* ---------- Wix ---------- */
const wixToken = async (fetchFn: Fetch, cfg: Config, instanceId: string) => {
  const r = await fetchFn("https://www.wixapis.com/oauth2/token", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: cfg.wixAppId, client_secret: cfg.wixSecret, instance_id: instanceId }) });
  return r.ok ? ((await r.json()) as { access_token?: string }).access_token ?? null : null;
};
const wixApi = (fetchFn: Fetch, token: string, path: string, body?: unknown) =>
  fetchFn(`https://www.wixapis.com${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Authorization: token }, body: body === undefined ? undefined : JSON.stringify(body) });

export function wixInstallUrl(cfg: Config, state: string): string | null {
  if (!cfg.wixAppId) return null;
  return `https://www.wix.com/installer/install?${new URLSearchParams({ appId: cfg.wixAppId, redirectUrl: `${cfg.functionsBase}/wix/callback`, state })}`;
}

export async function wixCallback(rpc: Rpc, fetchFn: Fetch, cfg: Config, params: URLSearchParams): Promise<Reply> {
  const instanceId = (params.get("instanceId") ?? params.get("instance_id") ?? "").toLowerCase(); const state = params.get("state") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(instanceId) || !state) return { status: 302, redirect: back(cfg, { error: "app_install_failed" }) };
  const token = await wixToken(fetchFn, cfg, instanceId);
  if (!token) return { status: 302, redirect: back(cfg, { error: "app_install_failed" }) };
  const site = await wixApi(fetchFn, token, "/apps/v1/instance");
  const siteUrl = site.ok ? ((await site.json())?.site?.url ?? null) : null;
  const done = await rpc("complete_app_install", { p_state: state, p_platform: "wix", p_shop: instanceId, p_token: token, p_refresh: null, p_scopes: "", p_site_url: siteUrl });
  if (done.error) return { status: 302, redirect: back(cfg, { error: done.error.message.match(/[a-z_]{6,}/)?.[0] ?? "app_install_failed" }) };
  const { connection_id: conn, org_id: org } = done.data as { connection_id: string; org_id: string };
  if (!site.ok) return { status: 302, redirect: back(cfg, { org, error: "app_not_verified" }) };   // the real API call failed
  const sync = await rpc("plugin_sync", { p_connection: conn, p_plugin_version: "wix-app" });
  if (!sync.error) await wixSyncCoupons(fetchFn, token, (sync.data?.coupons ?? []) as Coupon[]);
  return { status: 302, redirect: back(cfg, sync.error ? { org, error: "app_not_verified" } : { org, ok: "app_connected" }) };
}

export async function wixSyncCoupons(fetchFn: Fetch, token: string, coupons: Coupon[]) {
  const out = { created: 0, kept: 0 };
  for (const cp of coupons.filter((c) => c.active)) {
    const q = await wixApi(fetchFn, token, "/stores/v2/coupons/query", { query: { filter: JSON.stringify({ "specification.code": cp.code }) } });
    const found = q.ok ? ((await q.json())?.coupons ?? []).length > 0 : true;   // unknown → don't risk a duplicate
    if (found) { out.kept++; continue; }
    await wixApi(fetchFn, token, "/stores/v2/coupons", { specification: { name: `LINKUP ${cp.code}`, code: cp.code,
      startTime: new Date().toISOString(), percentOffRate: Math.max(0, Math.min(100, cp.discount_pct)), scope: { namespace: "stores" } } });
    out.created++;
  }
  return out;
}

export async function wixWebhook(rpc: Rpc, cfg: Config, raw: string): Promise<Reply> {
  const p = await verifyWixJwt(raw, cfg.wixPublicKey ?? "");
  if (!p) return { status: 401, body: { error: "unauthorized" } };
  const parse = (x: any) => (typeof x === "string" ? (() => { try { return JSON.parse(x); } catch { return null; } })() : x);
  const outer = parse(p.data) ?? {}; const eventType = String(outer.eventType ?? ""); const instanceId = String(outer.instanceId ?? "").toLowerCase();
  if (/app_removed|AppRemoved/i.test(eventType)) {
    const r = await rpc("app_uninstalled", { p_platform: "wix", p_shop: instanceId });
    return { status: 200, body: { ok: true, ...(r.data ?? {}) } };
  }
  if (!/order_(created|approved|canceled|updated|payment_status_updated)/i.test(eventType)) return { status: 200, body: { ok: true, ignored: eventType } };
  let cur: any = parse(outer.data); let order: any = null;
  for (let i = 0; i < 5 && cur && !order; i++) {
    if (cur.order) order = cur.order; else if (cur.priceSummary && cur.id) order = cur;
    else cur = parse(cur.data ?? cur.updatedEvent?.currentEntity ?? cur.createdEvent?.entity ?? cur.actionEvent?.body);
  }
  const n = wixOrder(order);
  if (!n) return { status: 200, body: { ok: true, ignored: "not_an_order" } };
  const c = (await rpc("app_connection_by_shop", { p_platform: "wix", p_shop: instanceId })).data as { connection_id: string } | null;
  if (!c) return { status: 200, body: { ok: true, ignored: "unknown_instance" } };
  const at = order.updatedDate ?? order.createdDate ?? new Date().toISOString();
  const r = await rpc("ingest_order_event", { p_connection: c.connection_id, p_event: {
    event_id: `wix:${outer.id ?? `${order.id}:${eventType}:${at}`}`, type: `order.${eventType.split(".").pop()}`, occurred_at: at, order: n } });
  if (r.error) {
    if (/connection_disconnected|invalid_event/.test(r.error.message)) return { status: 200, body: { ok: false } };
    return { status: 500, body: { error: "temporary_error" } };
  }
  return { status: 200, body: { ok: true, result: r.data } };
}
