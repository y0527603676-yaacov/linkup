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
  cronSecret?: string;     // protects the periodic sync route
  refSecret?: string;      // signs personal-link visits (same value as LINKUP_REF_SECRET in the web app)
  claimHours?: number;     // how long after the order a storefront purchase event may still be linked to it (default 72)
  sleep?: (ms: number) => Promise<void>;   // injectable for tests
  allowedShops?: string[]; // controlled test: only these Shopify shops may install / report orders (undefined = all)
};
export type Reply = { status: number; body?: unknown; redirect?: string };

export const SHOPIFY_SCOPES = ["read_orders", "read_products", "write_discounts", "write_pixels", "read_customer_events"];
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
/* ---------- retries: platform rate limits (429) and temporary errors (5xx / network) ---------- */
export function retrying(fetchFn: Fetch, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 3): Fetch {
  return async (url, init) => {
    let last: Awaited<ReturnType<Fetch>> | null = null;
    for (let i = 0; i < attempts; i++) {
      try {
        last = await fetchFn(url, init);
        if (last.status !== 429 && last.status < 500) return last;
      } catch (e) { if (i === attempts - 1) throw e; }
      if (i < attempts - 1) await sleep(Math.min(4000, 500 * 2 ** i));
    }
    return last!;
  };
}

/* ---------- personal link → ref ----------
 * The /r/CODE redirect adds lku=CODE, lkt=<visit time> and lks=<LINKUP signature of CODE|time>. Storefront scripts keep
 * "CODE|time|sig". The server accepts a link ref only with a valid signature (when LINKUP_REF_SECRET is set), so a
 * browser cannot invent a creator code or a visit time; the engine receives "CODE|time" and applies the agreement's
 * attribution window and all other rules. Three separate times:
 *   - attribution window: per agreement (1–90 days), enforced in the database from the signed visit time;
 *   - storage of the ref in the visitor's browser: up to 90 days (the longest window LINKUP allows), consent permitting;
 *   - claim time: how long after an order a storefront purchase event may still be linked to it (claimHours). */
const CODE_RE = /^[A-Za-z0-9]{4,16}$/;
export const REF_RE = /^[A-Za-z0-9]{4,16}\|\d{9,11}$/;
export const RAW_REF_RE = /^[A-Za-z0-9]{4,16}\|\d{9,11}(\|[A-Za-z0-9_-]{22})?$/;
/** Reads lku / lkt / lks from a landing URL, also when URL-encoded (e.g. inside /discount/CODE?redirect=…). */
export function refFromUrl(u: unknown): { code: string; at: number | null; sig: string | null } | null {
  let s = String(u ?? ""); if (!s || s.length > 4000) return null;
  for (let i = 0; i < 3; i++) { try { const d = decodeURIComponent(s.replace(/\+/g, " ")); if (d === s) break; s = d; } catch { break; } }
  const m = s.match(/[?&]lku=([A-Za-z0-9]{4,16})(?![A-Za-z0-9])/); if (!m) return null;
  const t = s.match(/[?&]lkt=(\d{9,11})(?!\d)/); const g = s.match(/[?&]lks=([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/);
  return { code: m[1]!, at: t ? Number(t[1]) : null, sig: g ? g[1]! : null };
}
const rawFrom = (code: string, at: number | null, sig: string | null) =>
  CODE_RE.test(code) && at && at > 1e9 ? `${code}|${Math.floor(at)}${sig ? `|${sig}` : ""}` : "";
const b64url = (b: Uint8Array) => b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** Signature LINKUP's redirect puts on a visit: base64url of the first 16 bytes of HMAC-SHA256(secret, "CODE|time"). */
export async function signVisit(secret: string, code: string, at: number) { return b64url((await hmac(secret, `${code}|${at}`)).slice(0, 16)); }
/** "CODE|time|sig" (or "CODE|time" when signing is not configured) → "CODE|time" for the engine, or "" if not trusted. */
export async function acceptRef(cfg: Config, raw: string): Promise<string> {
  if (!RAW_REF_RE.test(raw)) return "";
  const [code, at, sig] = raw.split("|") as [string, string, string | undefined];
  if (Number(at) > Date.now() / 1000 + 300) return "";
  if (cfg.refSecret) { if (!sig || !same(await signVisit(cfg.refSecret, code, Number(at)), sig)) return ""; }
  return `${code}|${at}`;
}

export type NormalizedOrder = { id: string; status: string; currency: string; total: number; tax: number; shipping: number; shipping_tax: number;
  coupons: string[]; ref: string; email_hash: string; created_at: string; refunds: { id: string; amount: number }[] };

export function shopifyOrder(o: any, emailHash = ""): NormalizedOrder | null {
  if (o?.id == null || !o.currency) return null;
  const cur = String(o.currency).toUpperCase(); const fs = o.financial_status ?? "";
  const status = o.cancelled_at || fs === "voided" ? "cancelled" : fs === "refunded" ? "refunded"
    : ["paid", "partially_refunded"].includes(fs) ? (o.fulfillment_status === "fulfilled" ? "completed" : "processing") : "pending";
  // 1) cart attribute set by the LINKUP theme app embed, 2) the landing page Shopify recorded for the order.
  const attr = String((o.note_attributes ?? []).find((a: any) => a?.name === "linkup_ref")?.value ?? "");
  const land = refFromUrl(o.landing_site);
  // Raw (possibly signed) — the webhook verifies it with acceptRef before ingestion.
  const ref = RAW_REF_RE.test(attr) ? attr : land ? rawFrom(land.code, land.at, land.sig) : "";
  return {
    id: String(o.id), status, currency: cur, total: toMinor(o.total_price, cur), tax: toMinor(o.total_tax, cur),
    shipping: toMinor(o.total_shipping_price_set?.shop_money?.amount, cur),
    shipping_tax: (o.shipping_lines ?? []).flatMap((l: any) => l.tax_lines ?? []).reduce((s: number, t: any) => s + toMinor(t.price, cur), 0),
    coupons: (o.discount_codes ?? []).map((d: any) => String(d?.code ?? "")).filter(Boolean),
    ref, email_hash: emailHash,
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
    refunds: wixRefunds(o, cur, total),
  };
}
/** Refunds from the order's activities (initiated refunds that did not fail, manual refunds); a fully refunded order
 *  always counts in full. The engine caps the sum at the order total, so overlaps can't over-refund. */
function wixRefunds(o: any, cur: string, total: number) {
  const acts: any[] = Array.isArray(o.activities) ? o.activities : [];
  const failed = new Set(acts.filter((a) => a?.type === "PAYMENT_REFUND_FAILED").map((a) => a?.paymentRefundFailed?.refundId).filter(Boolean));
  const out: { id: string; amount: number }[] = [];
  for (const a of acts) {
    if (a?.type === "REFUND_INITIATED" && a.refundInitiated?.refundId && !failed.has(a.refundInitiated.refundId))
      out.push({ id: `r:${a.refundInitiated.refundId}`, amount: toMinor(a.refundInitiated.amount?.amount, cur) });
    else if (a?.type === "ORDER_REFUNDED" && a.id) out.push({ id: `m:${a.id}`, amount: toMinor(a.orderRefunded?.amount?.amount, cur) });
  }
  if (o.paymentStatus === "FULLY_REFUNDED") out.push({ id: "full", amount: total });
  return out.filter((r) => r.amount > 0);
}

/* ---------- Shopify ---------- */
const gql = (fetchFn: Fetch, cfg: Config, shop: string, token: string, query: string, variables: Record<string, unknown> = {}) =>
  fetchFn(`https://${shop}/admin/api/${cfg.shopifyApiVersion ?? "2026-07"}/graphql.json`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token }, body: JSON.stringify({ query, variables }),
  });
const gqlJson = async (fetchFn: Fetch, cfg: Config, shop: string, token: string, query: string, variables: Record<string, unknown> = {}) => {
  const r = await gql(fetchFn, cfg, shop, token, query, variables);
  return r.ok ? await r.json().catch(() => null) : null;
};

/* ---------- Shopify access tokens: expiring offline tokens (required for public apps created from 1.4.2026) ----------
 * Stored in the existing Vault secret as JSON {"a": access, "r": refresh, "e": access expiry (unix s), "re": refresh
 * expiry}. A plain string is an older non-expiring token and keeps working as before. "revoked" = uninstalled. */
export type ShopToken = { a: string; r?: string; e?: number; re?: number };
export function parseToken(raw: unknown): ShopToken | null {
  const s = String(raw ?? ""); if (!s || s === "revoked") return null;
  if (s.startsWith("{")) { try { const t = JSON.parse(s); return t && typeof t.a === "string" && t.a ? t : null; } catch { return null; } }
  return { a: s };
}
export const packToken = (t: ShopToken) => JSON.stringify(t);
function tokenFromResponse(j: any, nowSec: number): ShopToken | null {
  if (!j?.access_token) return null;
  return j.refresh_token
    ? { a: j.access_token, r: j.refresh_token, e: nowSec + Number(j.expires_in ?? 3600), re: nowSec + Number(j.refresh_token_expires_in ?? 7776000) }
    : { a: j.access_token };
}
const refreshing = new Map<string, Promise<string | null>>();   // one refresh per connection at a time in this instance
/** A valid access token for the shop: refreshed shortly before it expires. If the refresh fails (e.g. another instance
 *  already used the refresh token), the stored credentials are read again and a newer valid token is used. */
export async function shopifyAccess(rpc: Rpc, fetchFn: Fetch, cfg: Config, conn: string, now = () => Math.floor(Date.now() / 1000)):
  Promise<{ shop: string; token: string } | null> {
  const read = async () => {
    const c = (await rpc("app_credentials", { p_connection: conn })).data as { shop: string; token: string } | null;
    return c ? { shop: c.shop, t: parseToken(c.token) } : null;
  };
  const c = await read(); if (!c?.t) return null;
  if (!c.t.e || c.t.e - now() > 300) return { shop: c.shop, token: c.t.a };
  if (!c.t.r) return null;
  let p = refreshing.get(conn);
  if (!p) {
    p = (async () => {
      const r = await fetchFn(`https://${c.shop}/admin/oauth/access_token`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: cfg.shopifyKey, client_secret: cfg.shopifySecret, grant_type: "refresh_token", refresh_token: c.t!.r }) });
      const t = r.ok ? tokenFromResponse(await r.json().catch(() => null), now()) : null;
      if (t) { await rpc("app_save_token", { p_connection: conn, p_token: packToken(t) }); return t.a; }
      const again = await read();   // someone else may have refreshed in the meantime
      if (again?.t && again.t.a !== c.t!.a && (!again.t.e || again.t.e - now() > 60)) return again.t.a;
      await rpc("app_sync_failed", { p_connection: conn, p_reason: "token_refresh_failed" });
      return null;
    })().finally(() => refreshing.delete(conn));
    refreshing.set(conn, p);
  }
  const token = await p;
  return token ? { shop: c.shop, token } : null;
}

export function shopifyInstallUrl(cfg: Config, shop: string, state: string): string | null {
  if (!SHOP_RE.test(shop) || !cfg.shopifyKey) return null;
  const q = new URLSearchParams({ client_id: cfg.shopifyKey, scope: SHOPIFY_SCOPES.join(","), redirect_uri: `${cfg.functionsBase}/shopify/callback`, state });
  return `https://${shop}/admin/oauth/authorize?${q}`;
}

/** Controlled activation: shops outside the allow-list can't install, and their order events are ignored. */
export const shopAllowed = (cfg: Config, shop: string) => !cfg.allowedShops || cfg.allowedShops.includes("*") || cfg.allowedShops.includes(shop);

/** Start of the install (from LINKUP's connect page): the one-time state was created by start_app_install for the
 *  signed-in store owner; this route only adds the app's Client ID (kept in function secrets) and sends the owner to
 *  Shopify's approval screen. */
export function shopifyInstall(cfg: Config, params: URLSearchParams): Reply {
  const shop = (params.get("shop") ?? "").toLowerCase(); const state = params.get("state") ?? "";
  if (!SHOP_RE.test(shop) || !/^[A-Za-z0-9_-]{20,128}$/.test(state)) return { status: 302, redirect: back(cfg, { error: "app_install_failed" }) };
  if (!shopAllowed(cfg, shop)) return { status: 302, redirect: back(cfg, { error: "shop_not_allowed" }) };
  const url = shopifyInstallUrl(cfg, shop, state);
  return url ? { status: 302, redirect: url } : { status: 302, redirect: back(cfg, { error: "app_install_failed" }) };
}

const back = (cfg: Config, params: Record<string, string>) => `${cfg.appBase}/app/connect?${new URLSearchParams(params)}`;

export async function shopifyCallback(rpc: Rpc, fetchRaw: Fetch, cfg: Config, params: URLSearchParams): Promise<Reply> {
  const fetchFn = retrying(fetchRaw, cfg.sleep);
  const shop = (params.get("shop") ?? "").toLowerCase(); const state = params.get("state") ?? ""; const code = params.get("code") ?? "";
  if (!SHOP_RE.test(shop) || !state || !code || !(await verifyShopifyQuery(params, cfg.shopifySecret ?? ""))) {
    return { status: 302, redirect: back(cfg, { error: "app_install_failed" }) };
  }
  if (!shopAllowed(cfg, shop)) return { status: 302, redirect: back(cfg, { error: "shop_not_allowed" }) };
  const tr = await fetchFn(`https://${shop}/admin/oauth/access_token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: cfg.shopifyKey, client_secret: cfg.shopifySecret, code, expiring: 1 }),
  });
  if (!tr.ok) return { status: 302, redirect: back(cfg, { error: "app_install_failed" }) };
  const tok = await tr.json() as { access_token?: string; scope?: string; refresh_token?: string; expires_in?: number };
  const granted = new Set(String(tok.scope ?? "").split(",").map((s) => s.trim()));
  if (!tok.access_token || !SHOPIFY_SCOPES.every((s) => granted.has(s) || (s.startsWith("read_") && granted.has(s.replace("read_", "write_"))))) {
    return { status: 302, redirect: back(cfg, { error: "app_scopes_missing" }) };
  }
  const stored = tokenFromResponse(tok, Math.floor(Date.now() / 1000))!;
  const done = await rpc("complete_app_install", { p_state: state, p_platform: "shopify", p_shop: shop, p_token: packToken(stored),
    p_refresh: null, p_scopes: tok.scope ?? "", p_site_url: null });
  if (done.error) return { status: 302, redirect: back(cfg, { error: done.error.message.match(/[a-z_]{6,}/)?.[0] ?? "app_install_failed" }) };
  const { connection_id: conn, org_id: org } = done.data as { connection_id: string; org_id: string };
  const r = await shopifyActivate(rpc, fetchFn, cfg, conn);
  return { status: 302, redirect: back(cfg, r.ok ? { org, ok: "app_connected" } : r.partial ? { org, error: "app_partial" } : { org, error: "app_not_verified" }) };
}

/** What must exist in the shop for orders, cancellations, refunds, uninstall and personal links to work. */
export const SHOPIFY_REQUIRED = [...SHOPIFY_TOPICS, "PIXEL"] as const;
/** Reads what really exists in the shop (webhook subscriptions to LINKUP, LINKUP's pixel) and creates what is missing.
 *  An existing subscription counts; nothing else in the shop is touched. Returns the components still missing. */
export async function shopifyEnsureComponents(fetchFn: Fetch, cfg: Config, shop: string, token: string): Promise<string[] | null> {
  const hook = `${cfg.functionsBase}/shopify/webhook`;
  const list = async () => {
    const j = await gqlJson(fetchFn, cfg, shop, token, "{ webhookSubscriptions(first: 100) { nodes { topic uri } } webPixel { id } }");
    if (!j?.data) return null;
    const topics = new Set<string>((j.data.webhookSubscriptions?.nodes ?? []).filter((n: any) => n?.uri === hook).map((n: any) => String(n.topic)));
    return { topics, pixel: !!j.data.webPixel?.id };
  };
  const before = await list(); if (!before) return null;
  for (const topic of SHOPIFY_TOPICS) {
    if (before.topics.has(topic)) continue;
    await gql(fetchFn, cfg, shop, token,
      `mutation($topic: WebhookSubscriptionTopic!, $url: URL!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: { callbackUrl: $url, format: JSON }) { userErrors { message } } }`,
      { topic, url: hook });
  }
  await shopifyEnsurePixel(fetchFn, cfg, shop, token);   // creates it, or refreshes its settings
  const after = await list(); if (!after) return null;
  return [...SHOPIFY_TOPICS.filter((t) => !after.topics.has(t)), ...(after.pixel ? [] : ["PIXEL"])];
}

/** Real API call to the shop and a real check of every component; only when all exist is the store "connected"
 *  (plugin_sync). Otherwise the connection is marked partial (shown to the owner with "complete the connection"). */
async function shopifyVerifyAndSync(rpc: Rpc, fetchFn: Fetch, cfg: Config, conn: string, withProducts: boolean) {
  const acc = await shopifyAccess(rpc, fetchFn, cfg, conn);
  if (!acc) return { ok: false as const, partial: false, reason: "no_credentials" };
  const j = await gqlJson(fetchFn, cfg, acc.shop, acc.token, "{ shop { myshopifyDomain primaryDomain { url } currencyCode } }");
  if (!j?.data?.shop?.myshopifyDomain) return { ok: false as const, partial: false, reason: "shop_unreachable" };
  const missing = await shopifyEnsureComponents(fetchFn, cfg, acc.shop, acc.token);
  if (missing === null) return { ok: false as const, partial: false, reason: "shop_unreachable" };
  if (missing.length) {
    await rpc("app_sync_failed", { p_connection: conn, p_reason: `partial:${missing.join(",").toLowerCase()}` });
    return { ok: false as const, partial: true, reason: "partial", missing };
  }
  const sync = await rpc("plugin_sync", { p_connection: conn, p_plugin_version: "shopify-app" });
  if (sync.error) return { ok: false as const, partial: false, reason: "sync_failed" };
  const coupons = await shopifySyncCoupons(fetchFn, cfg, acc.shop, acc.token, (sync.data?.coupons ?? []) as Coupon[],
    (code, id, active) => rpc("app_coupon_mark", { p_connection: conn, p_code: code, p_external_id: id, p_active: active }).then(() => undefined));
  const products = withProducts ? await shopifySyncProducts(rpc, fetchFn, cfg, conn, acc.shop, acc.token) : null;
  return { ok: true as const, partial: false, coupons, products };
}

/** Live check of an app connection (read-only toward Shopify): is the stored token accepted, and does every required
 *  component exist? Called when the owner opens the connect page, so the status shown is the real one.
 *  - "reconnect": Shopify rejects the token (e.g. an old non-expiring token after switching to public distribution,
 *    an expired refresh token, or the app was removed) → the owner repeats the approval; nothing is deleted.
 *  - "partial": the token works but components are missing → "complete the connection".
 *  - "ok": everything exists. */
export async function shopifyCheck(rpc: Rpc, fetchFn: Fetch, cfg: Config, conn: string):
  Promise<{ state: "ok" | "partial" | "reconnect" | "unknown"; missing?: string[] }> {
  const acc = await shopifyAccess(rpc, fetchFn, cfg, conn);
  if (!acc) { await rpc("app_sync_failed", { p_connection: conn, p_reason: "token_invalid" }); return { state: "reconnect" }; }
  const r = await gql(fetchFn, cfg, acc.shop, acc.token, "{ webhookSubscriptions(first: 100) { nodes { topic uri } } webPixel { id } }");
  if (r.status === 401 || r.status === 403) { await rpc("app_sync_failed", { p_connection: conn, p_reason: "token_invalid" }); return { state: "reconnect" }; }
  const j = r.ok ? await r.json().catch(() => null) : null;
  if (!j?.data) return { state: "unknown" };   // temporary problem: say nothing new
  const hook = `${cfg.functionsBase}/shopify/webhook`;
  const topics = new Set<string>((j.data.webhookSubscriptions?.nodes ?? []).filter((n: any) => n?.uri === hook).map((n: any) => String(n.topic)));
  const missing = [...SHOPIFY_TOPICS.filter((t) => !topics.has(t)), ...(j.data.webPixel?.id ? [] : ["PIXEL"])];
  if (missing.length) { await rpc("app_sync_failed", { p_connection: conn, p_reason: `partial:${missing.join(",").toLowerCase()}` }); return { state: "partial", missing }; }
  return { state: "ok" };
}

export async function shopifyActivate(rpc: Rpc, fetchFn: Fetch, cfg: Config, conn: string) {
  return shopifyVerifyAndSync(rpc, fetchFn, cfg, conn, true);
}

/** Opened from Shopify (the app's App URL with Shopify's signed query): if this shop has no working LINKUP connection,
 *  send the owner to LINKUP's connect page to finish it with one click (a new one-time state is created there for the
 *  signed-in owner). Unsigned or foreign requests are ignored. */
export async function shopifyOpen(rpc: Rpc, cfg: Config, params: URLSearchParams): Promise<Reply> {
  const shop = (params.get("shop") ?? "").toLowerCase();
  if (!SHOP_RE.test(shop) || !(await verifyShopifyQuery(params, cfg.shopifySecret ?? "")) || !shopAllowed(cfg, shop))
    return { status: 302, redirect: `${cfg.appBase}/app` };
  const ts = Number(params.get("timestamp") ?? 0);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 600) return { status: 302, redirect: `${cfg.appBase}/app` };
  const cr = await rpc("app_connection_by_shop", { p_platform: "shopify", p_shop: shop });
  const c = cr.data as { connection_id: string; org_id: string; status: string } | null;
  if (c && c.status === "connected") return { status: 302, redirect: `${cfg.appBase}/app/connect?${new URLSearchParams({ org: c.org_id })}` };
  return { status: 302, redirect: `${cfg.appBase}/app/connect?${new URLSearchParams({ ...(c ? { org: c.org_id } : {}), resume: shop })}` };
}

type Coupon = { code: string; discount_pct: number; active: boolean };
type Mark = (code: string, externalId: string | null, active: boolean) => Promise<void>;
/** Creates missing partner coupons in the shop and deactivates coupons LINKUP turned off. Never touches other discounts.
 *  Records which codes really exist in the shop (used for the auto-applied discount link). */
export async function shopifySyncCoupons(fetchFn: Fetch, cfg: Config, shop: string, token: string, coupons: Coupon[], mark?: Mark) {
  const out = { created: 0, deactivated: 0, kept: 0, failed: 0, skipped: 0 };
  for (const cp of coupons) {
    if (!CODE_RE.test(cp.code)) { out.skipped++; continue; }
    const q = await gqlJson(fetchFn, cfg, shop, token, `query($code: String!) { codeDiscountNodeByCode(code: $code) { id codeDiscount { ... on DiscountCodeBasic { status title } } } }`, { code: cp.code });
    if (!q?.data) { out.failed++; continue; }   // unknown state → don't risk a duplicate; next sync retries
    const node = q.data.codeDiscountNodeByCode; const ours = String(node?.codeDiscount?.title ?? "").startsWith("LINKUP ");
    if (!node && cp.active) {
      if (!(cp.discount_pct > 0)) { out.skipped++; await mark?.(cp.code, null, false); continue; }   // no customer discount → nothing to create
      const r = await gqlJson(fetchFn, cfg, shop, token,
        `mutation($d: DiscountCodeBasicInput!) { discountCodeBasicCreate(basicCodeDiscount: $d) { codeDiscountNode { id } userErrors { message } } }`,
        { d: { title: `LINKUP ${cp.code}`, code: cp.code, startsAt: new Date().toISOString(), customerSelection: { all: true },
               customerGets: { value: { percentage: Math.min(100, cp.discount_pct) / 100 }, items: { all: true } } } });
      const res = r?.data?.discountCodeBasicCreate;
      if (!res || (res.userErrors ?? []).length) { out.failed++; continue; }
      out.created++; await mark?.(cp.code, res.codeDiscountNode?.id ?? null, true);
    } else if (node && !cp.active && ours) {
      const r = await gqlJson(fetchFn, cfg, shop, token, `mutation($id: ID!) { discountCodeDeactivate(id: $id) { userErrors { message } } }`, { id: node.id });
      if (!r?.data || (r.data.discountCodeDeactivate?.userErrors ?? []).length) { out.failed++; continue; }
      out.deactivated++; await mark?.(cp.code, node.id, false);
    } else {
      out.kept++;
      if (node) await mark?.(cp.code, node.id, cp.active && ours && String(node.codeDiscount?.status ?? "ACTIVE") === "ACTIVE");
    }
  }
  return out;
}

/** Catalog for creators (title, link, image, price, stock). Full sync only when every page was read. */
export async function shopifySyncProducts(rpc: Rpc, fetchFn: Fetch, cfg: Config, conn: string, shop: string, token: string) {
  const started = new Date().toISOString(); let after: string | null = null; let n = 0; let complete = false;
  for (let page = 0; page < 10; page++) {
    const j = await gqlJson(fetchFn, cfg, shop, token, `query($after: String) { products(first: 100, after: $after, query: "status:active") {
      nodes { id title onlineStoreUrl featuredImage { url } totalInventory tracksInventory priceRangeV2 { minVariantPrice { amount currencyCode } } }
      pageInfo { hasNextPage endCursor } } }`, { after });
    const p = j?.data?.products; if (!p) break;
    const rows = (p.nodes ?? []).map((x: any) => {
      const cur = String(x.priceRangeV2?.minVariantPrice?.currencyCode ?? "").toUpperCase();
      return { id: String(x.id).split("/").pop(), name: x.title, url: x.onlineStoreUrl ?? null, image: x.featuredImage?.url ?? null,
        price: String(toMinor(x.priceRangeV2?.minVariantPrice?.amount, cur)), currency: cur,
        in_stock: x.tracksInventory ? Number(x.totalInventory ?? 0) > 0 : true,
        stock_qty: x.tracksInventory ? String(x.totalInventory ?? 0) : null, status: "publish" };
    });
    const last = !p.pageInfo?.hasNextPage;
    if (rows.length || (last && after === null)) {
      const r = await rpc("plugin_sync_products", { p_connection: conn, p_products: rows, p_full_started_at: last && after === null ? started : null });
      if (r.error) break; n += rows.length;
    }
    if (last) { complete = true; break; }
    after = p.pageInfo.endCursor;
  }
  // Multi-page catalogs: mark products that disappeared only after every page was read.
  if (complete && after !== null) await rpc("plugin_sync_products", { p_connection: conn, p_products: [], p_full_started_at: started });
  return { upserted: n, complete };
}

/** Shopify's own attribution of the order (official customerJourneySummary): last visit first, then first visit.
 *  Used only when the order has no LINKUP coupon and no link data in the webhook. Returns "" while not ready. */
export async function shopifyJourneyRef(fetchFn: Fetch, cfg: Config, shop: string, token: string, orderId: string): Promise<string> {
  // Returns a raw ref; the caller verifies it (acceptRef).
  const j = await gqlJson(fetchFn, cfg, shop, token, `query($id: ID!) { order(id: $id) { customerJourneySummary { ready
    lastVisit { landingPage occurredAt } firstVisit { landingPage occurredAt } } } }`, { id: `gid://shopify/Order/${orderId}` });
  const s = j?.data?.order?.customerJourneySummary; if (!s?.ready) return "";
  for (const v of [s.lastVisit, s.firstVisit]) {
    const r = refFromUrl(v?.landingPage); if (!r) continue;
    // Signed links carry their own visit time; an unsigned landing page counts only when signing is not configured.
    const ref = r.at && r.sig ? rawFrom(r.code, r.at, r.sig)
      : cfg.refSecret ? "" : rawFrom(r.code, r.at ?? (v?.occurredAt ? Math.floor(Date.parse(v.occurredAt) / 1000) : null), null);
    if (ref) return ref;
  }
  return "";
}

/** Personal links without any discount: LINKUP's app pixel (Shopify Web Pixels API) is switched on by the app itself
 *  (webPixelCreate) — no step for the owner. Shopify loads it only with the visitor's consent (customer_privacy in the
 *  extension). It keeps the signed ref and, on Shopify's checkout_completed event, sends { shop, order id, ref }. */
export async function shopifyEnsurePixel(fetchFn: Fetch, cfg: Config, shop: string, token: string) {
  const settings = JSON.stringify({ endpoint: `${cfg.functionsBase}/shopify/ref`, shop });
  const j = await gqlJson(fetchFn, cfg, shop, token,
    `mutation($s: JSON!) { webPixelCreate(webPixel: { settings: $s }) { webPixel { id } userErrors { code message } } }`, { s: settings });
  const res = j?.data?.webPixelCreate;
  if (res?.webPixel?.id) return "created";
  if ((res?.userErrors ?? []).some((e: any) => /TAKEN|exist/i.test(`${e.code} ${e.message}`))) {   // already there: refresh its settings
    const cur = await gqlJson(fetchFn, cfg, shop, token, "{ webPixel { id } }");
    const id = cur?.data?.webPixel?.id;
    if (id) { await gql(fetchFn, cfg, shop, token, `mutation($id: ID!, $s: JSON!) { webPixelUpdate(id: $id, webPixel: { settings: $s }) { userErrors { message } } }`, { id, s: settings }); return "updated"; }
  }
  return "failed";
}

// No customer contact fields (protected customer data level 2): the e-mail hash, when allowed, comes from the webhook.
const SHOP_ORDER_QUERY = `query($id: ID!) { order(id: $id) { legacyResourceId createdAt updatedAt cancelledAt currencyCode
  displayFinancialStatus displayFulfillmentStatus discountCodes
  totalPriceSet { shopMoney { amount } } totalTaxSet { shopMoney { amount } } totalShippingPriceSet { shopMoney { amount } }
  shippingLines(first: 20) { nodes { taxLines { priceSet { shopMoney { amount } } } } }
  refunds { id totalRefundedSet { shopMoney { amount } } } } }`;
/** Admin GraphQL order → the same normalized format as the order webhook (same ids for the order and its refunds). */
export function shopifyGqlOrder(o: any, emailHash = ""): NormalizedOrder | null {
  if (!o?.legacyResourceId || !o.currencyCode) return null;
  const cur = String(o.currencyCode).toUpperCase(); const fs = String(o.displayFinancialStatus ?? "").toLowerCase();
  const status = o.cancelledAt || fs === "voided" ? "cancelled" : fs === "refunded" ? "refunded"
    : ["paid", "partially_refunded"].includes(fs) ? (o.displayFulfillmentStatus === "FULFILLED" ? "completed" : "processing") : "pending";
  return {
    id: String(o.legacyResourceId), status, currency: cur, total: toMinor(o.totalPriceSet?.shopMoney?.amount, cur),
    tax: toMinor(o.totalTaxSet?.shopMoney?.amount, cur), shipping: toMinor(o.totalShippingPriceSet?.shopMoney?.amount, cur),
    shipping_tax: (o.shippingLines?.nodes ?? []).flatMap((l: any) => l.taxLines ?? []).reduce((s: number, t: any) => s + toMinor(t.priceSet?.shopMoney?.amount, cur), 0),
    coupons: (o.discountCodes ?? []).map(String).filter(Boolean), ref: "", email_hash: emailHash, created_at: o.createdAt,
    refunds: (o.refunds ?? []).map((r: any) => ({ id: String(r.id).split("/").pop()!, amount: toMinor(r.totalRefundedSet?.shopMoney?.amount, cur) }))
      .filter((r: { amount: number }) => r.amount > 0),
  };
}

/** Purchase event from LINKUP's Shopify pixel. The browser is trusted only for the signed ref; the order is read from
 *  Shopify's Admin API with the app token and goes through the same engine (coupon wins, one attribution per order,
 *  attribution window from the signed visit time, commission only once paid). */
export async function shopifyRef(rpc: Rpc, fetchRaw: Fetch, cfg: Config, raw: string): Promise<Reply> {
  let b: any; try { b = JSON.parse(raw); } catch { return { status: 400, body: { error: "invalid_json" } }; }
  const shop = String(b?.shop ?? "").toLowerCase(); const orderId = String(b?.order ?? "").split("/").pop() ?? ""; const rawRef = String(b?.ref ?? "");
  if (!SHOP_RE.test(shop) || !/^\d{1,20}$/.test(orderId) || !RAW_REF_RE.test(rawRef)) return { status: 400, body: { error: "invalid_input" } };
  if (!shopAllowed(cfg, shop)) return { status: 200, body: { ok: true, ignored: "shop_not_allowed" } };
  const ref = await acceptRef(cfg, rawRef);
  if (!ref) return { status: 200, body: { ok: true, ignored: "untrusted_ref" } };
  const cr = await rpc("app_connection_by_shop", { p_platform: "shopify", p_shop: shop });
  if (cr.error) return { status: 500, body: { error: "temporary_error" } };
  const c = cr.data as { connection_id: string; status: string } | null;
  if (!c || c.status === "disconnected") return { status: 200, body: { ok: true, ignored: "unknown_shop" } };
  const fetchFn = retrying(fetchRaw, cfg.sleep);
  const cred = await shopifyAccess(rpc, fetchFn, cfg, c.connection_id);
  if (!cred) return { status: 500, body: { error: "temporary_error" } };
  const j = await gqlJson(fetchFn, cfg, cred.shop, cred.token, SHOP_ORDER_QUERY, { id: `gid://shopify/Order/${orderId}` });
  if (!j) return { status: 500, body: { error: "temporary_error" } };
  const o = j.data?.order;
  if (!o) return { status: 409, body: { error: "order_not_ready" } };   // the pixel retries a few times
  return claimOrder(rpc, cfg, c.connection_id, `shopify-ref:${orderId}`, o.createdAt, o.updatedAt ?? o.createdAt,
    shopifyGqlOrder(o), ref);
}

/** Shared by the Shopify pixel and the Wix script: link a fresh, platform-verified order to a verified ref. */
async function claimOrder(rpc: Rpc, cfg: Config, conn: string, eventId: string, createdAt: string, at: string, n: NormalizedOrder | null, ref: string): Promise<Reply> {
  const created = Date.parse(createdAt ?? "");
  if (!n || !Number.isFinite(created)) return { status: 200, body: { ok: true, ignored: "not_an_order" } };
  if (Date.now() - created > (cfg.claimHours ?? 72) * 3600_000) return { status: 200, body: { ok: true, ignored: "claim_too_late" } };
  n.ref = ref;
  const ing = await rpc("ingest_order_event", { p_connection: conn, p_event: { event_id: eventId, type: "order.link", occurred_at: at, order: n } });
  if (ing.error) {
    if (/connection_disconnected|invalid_event/.test(ing.error.message)) return { status: 200, body: { ok: false } };
    return { status: 500, body: { error: "temporary_error" } };
  }
  return { status: 200, body: { ok: true, result: ing.data } };
}

export async function shopifyWebhook(rpc: Rpc, cfg: Config, headers: { get(k: string): string | null }, raw: string, fetchRaw?: Fetch): Promise<Reply> {
  if (!(await verifyShopifyWebhook(raw, headers.get("x-shopify-hmac-sha256"), cfg.shopifySecret ?? ""))) return { status: 401, body: { error: "unauthorized" } };
  const topic = headers.get("x-shopify-topic") ?? ""; const shop = (headers.get("x-shopify-shop-domain") ?? "").toLowerCase();
  const id = headers.get("x-shopify-webhook-id") ?? headers.get("x-shopify-event-id") ?? "";
  let body: any; try { body = JSON.parse(raw); } catch { return { status: 400, body: { error: "invalid_json" } }; }
  // Mandatory privacy webhooks: LINKUP stores no customer names/contacts (only an e-mail hash for self-referral checks).
  if (topic === "customers/data_request" || topic === "customers/redact") return { status: 200, body: { ok: true, stored_customer_data: "none" } };
  if (topic === "app/uninstalled" || topic === "shop/redact") {
    const r = await rpc("app_uninstalled", { p_platform: "shopify", p_shop: shop || String(body?.shop_domain ?? "") });
    if (r.error) return { status: 500, body: { error: "temporary_error" } };
    return { status: 200, body: { ok: true, ...(r.data ?? {}) } };
  }
  if (!topic.startsWith("orders/")) return { status: 200, body: { ok: true, ignored: topic } };
  if (!shopAllowed(cfg, shop)) return { status: 200, body: { ok: true, ignored: "shop_not_allowed" } };
  const cr = await rpc("app_connection_by_shop", { p_platform: "shopify", p_shop: shop });
  if (cr.error) return { status: 500, body: { error: "temporary_error" } };
  const c = cr.data as { connection_id: string } | null;
  if (!c) return { status: 200, body: { ok: true, ignored: "unknown_shop" } };
  const emailHash = typeof body?.email === "string" && body.email.includes("@") ? await sha256Hex(body.email.trim().toLowerCase()) : "";
  const order = shopifyOrder(body, emailHash);
  if (!order) return { status: 200, body: { ok: true, ignored: "not_an_order" } };
  order.ref = order.ref ? await acceptRef(cfg, order.ref) : "";
  if (!order.ref && !order.coupons.length && fetchRaw && order.status !== "cancelled") {
    const fetchFn = retrying(fetchRaw, cfg.sleep);
    const cred = await shopifyAccess(rpc, fetchFn, cfg, c.connection_id).catch(() => null);
    if (cred) order.ref = await acceptRef(cfg, await shopifyJourneyRef(fetchFn, cfg, cred.shop, cred.token, order.id).catch(() => ""));
  }
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
// Wix access tokens (client_credentials + instance id) are short-lived and minted on demand: nothing to refresh or store
// long-term. The stored token is only the one from the install (kept so the connection has credentials on record).
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

export async function wixCallback(rpc: Rpc, fetchRaw: Fetch, cfg: Config, params: URLSearchParams): Promise<Reply> {
  const fetchFn = retrying(fetchRaw, cfg.sleep);
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
  // Personal links on Wix: LINKUP's embedded script (consent-aware, loaded by Wix) is added to the site.
  await wixApi(fetchFn, token, "/apps/v1/scripts", { properties: { parameters: { endpoint: `${cfg.functionsBase}/wix/ref`, instance: instanceId } } }).catch(() => null);
  const r = await wixVerifyAndSync(rpc, fetchFn, cfg, conn, instanceId, true);
  return { status: 302, redirect: back(cfg, r.ok ? { org, ok: "app_connected" } : { org, error: "app_not_verified" }) };
}

async function wixVerifyAndSync(rpc: Rpc, fetchFn: Fetch, cfg: Config, conn: string, instanceId: string, withProducts: boolean) {
  const token = await wixToken(fetchFn, cfg, instanceId);
  if (!token) return { ok: false as const, reason: "no_token" };
  const site = await wixApi(fetchFn, token, "/apps/v1/instance");
  if (!site.ok) return { ok: false as const, reason: "site_unreachable" };
  const sync = await rpc("plugin_sync", { p_connection: conn, p_plugin_version: "wix-app" });
  if (sync.error) return { ok: false as const, reason: "sync_failed" };
  const coupons = await wixSyncCoupons(fetchFn, token, (sync.data?.coupons ?? []) as Coupon[],
    (code, id, active) => rpc("app_coupon_mark", { p_connection: conn, p_code: code, p_external_id: id, p_active: active }).then(() => undefined));
  const products = withProducts ? await wixSyncProducts(rpc, fetchFn, conn, token) : null;
  return { ok: true as const, coupons, products };
}

export async function wixSyncCoupons(fetchFn: Fetch, token: string, coupons: Coupon[], mark?: Mark) {
  const out = { created: 0, kept: 0, failed: 0, skipped: 0, deactivated: 0 };
  for (const cp of coupons) {
    if (!CODE_RE.test(cp.code)) { out.skipped++; continue; }
    const q = await wixApi(fetchFn, token, "/stores/v2/coupons/query", { query: { filter: JSON.stringify({ "specification.code": cp.code }) } });
    if (!q.ok) { out.failed++; continue; }   // unknown → don't risk a duplicate; next sync retries
    const found = ((await q.json())?.coupons ?? [])[0];
    if (found) {
      const ours = String(found.specification?.name ?? "").startsWith("LINKUP ");
      if (!cp.active && ours && found.id && found.specification?.active !== false) {
        const u = await fetchFn(`https://www.wixapis.com/stores/v2/coupons/${found.id}`, { method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: token }, body: JSON.stringify({ specification: { ...found.specification, active: false } }) });
        if (!u.ok) { out.failed++; continue; }
        out.deactivated++; await mark?.(cp.code, found.id, false); continue;
      }
      out.kept++; await mark?.(cp.code, found.id ?? null, cp.active && found.specification?.active !== false); continue;
    }
    if (!cp.active) { out.kept++; continue; }
    if (!(cp.discount_pct > 0)) { out.skipped++; await mark?.(cp.code, null, false); continue; }
    const c = await wixApi(fetchFn, token, "/stores/v2/coupons", { specification: { name: `LINKUP ${cp.code}`, code: cp.code,
      startTime: new Date().toISOString(), percentOffRate: Math.min(100, cp.discount_pct), scope: { namespace: "stores" }, active: true } });
    if (!c.ok) { out.failed++; continue; }
    out.created++; await mark?.(cp.code, ((await c.json().catch(() => null)) as any)?.id ?? null, true);
  }
  return out;
}

export async function wixSyncProducts(rpc: Rpc, fetchFn: Fetch, conn: string, token: string) {
  const started = new Date().toISOString(); let n = 0; let complete = false;
  for (let page = 0; page < 10; page++) {
    const r = await wixApi(fetchFn, token, "/stores/v1/products/query", { query: { paging: { limit: 100, offset: page * 100 } } });
    if (!r.ok) break;
    const list: any[] = ((await r.json())?.products ?? []);
    const rows = list.filter((p) => p?.visible !== false).map((p) => {
      const cur = String(p.priceData?.currency ?? p.price?.currency ?? "").toUpperCase();
      const url = p.productPageUrl?.base && p.productPageUrl?.path ? `${String(p.productPageUrl.base).replace(/\/$/, "")}${p.productPageUrl.path}` : null;
      return { id: String(p.id), name: p.name, url, image: p.media?.mainMedia?.image?.url ?? null,
        price: String(toMinor(p.priceData?.price ?? p.price?.price, cur)), currency: cur,
        in_stock: p.stock?.inStock !== false, stock_qty: p.stock?.trackInventory ? String(p.stock?.quantity ?? 0) : null, status: "publish" };
    });
    const last = list.length < 100;
    if (rows.length || (last && page === 0)) {
      const s = await rpc("plugin_sync_products", { p_connection: conn, p_products: rows, p_full_started_at: last && page === 0 ? started : null });
      if (s.error) break; n += rows.length;
    }
    if (last) { complete = true; if (page > 0) await rpc("plugin_sync_products", { p_connection: conn, p_products: [], p_full_started_at: started }); break; }
  }
  return { upserted: n, complete };
}

/** Personal link on Wix. Wix orders carry no landing page, so LINKUP's embedded script keeps the creator code on the
 *  site (only with the visitor's consent, enforced by Wix for the script's consent category) and, on Wix's own
 *  "Purchase" event on the thank-you page, sends { instance, order id, ref }.
 *  The browser is trusted ONLY for the ref: the order itself is read from Wix's API with the app's token and must be
 *  fresh; it then goes through the same engine (coupon wins over link, one attribution per order, no commission
 *  before payment, cancellations/refunds from Wix webhooks). */
export async function wixRef(rpc: Rpc, fetchRaw: Fetch, cfg: Config, raw: string): Promise<Reply> {
  let b: any; try { b = JSON.parse(raw); } catch { return { status: 400, body: { error: "invalid_json" } }; }
  const instance = String(b?.instance ?? "").toLowerCase(); const orderId = String(b?.order ?? ""); const rawRef = String(b?.ref ?? "");
  if (!/^[0-9a-f-]{36}$/.test(instance) || !/^[0-9a-f-]{36}$/i.test(orderId) || !RAW_REF_RE.test(rawRef)) return { status: 400, body: { error: "invalid_input" } };
  const ref = await acceptRef(cfg, rawRef);
  if (!ref) return { status: 200, body: { ok: true, ignored: "untrusted_ref" } };
  const cr = await rpc("app_connection_by_shop", { p_platform: "wix", p_shop: instance });
  if (cr.error) return { status: 500, body: { error: "temporary_error" } };
  const c = cr.data as { connection_id: string; status: string } | null;
  if (!c || c.status === "disconnected") return { status: 200, body: { ok: true, ignored: "unknown_instance" } };
  const fetchFn = retrying(fetchRaw, cfg.sleep);
  const token = await wixToken(fetchFn, cfg, instance);
  if (!token) return { status: 500, body: { error: "temporary_error" } };
  const r = await wixApi(fetchFn, token, `/ecom/v1/orders/${orderId}`);
  if (r.status === 404) return { status: 409, body: { error: "order_not_ready" } };   // the script retries a few times
  if (!r.ok) return { status: 500, body: { error: "temporary_error" } };
  const o = (await r.json())?.order;
  return claimOrder(rpc, cfg, c.connection_id, `wix-ref:${orderId}`, o?.createdDate, o?.updatedDate ?? o?.createdDate, wixOrder(o), ref);
}

export async function wixWebhook(rpc: Rpc, cfg: Config, raw: string): Promise<Reply> {
  const p = await verifyWixJwt(raw, cfg.wixPublicKey ?? "");
  if (!p) return { status: 401, body: { error: "unauthorized" } };
  const parse = (x: any) => (typeof x === "string" ? (() => { try { return JSON.parse(x); } catch { return null; } })() : x);
  const outer = parse(p.data) ?? {}; const eventType = String(outer.eventType ?? ""); const instanceId = String(outer.instanceId ?? "").toLowerCase();
  if (/app_removed|AppRemoved/i.test(eventType)) {
    const r = await rpc("app_uninstalled", { p_platform: "wix", p_shop: instanceId });
    if (r.error) return { status: 500, body: { error: "temporary_error" } };
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
  const cr = await rpc("app_connection_by_shop", { p_platform: "wix", p_shop: instanceId });
  if (cr.error) return { status: 500, body: { error: "temporary_error" } };
  const c = cr.data as { connection_id: string } | null;
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

/* ---------- periodic sync (scheduled): coupons, products, connection health ---------- */
/** For every app connection: real API call first (a revoked or broken shop is NOT marked connected), then plugin_sync,
 *  coupons and products. One failing shop never stops the others. */
export async function syncAll(rpc: Rpc, fetchRaw: Fetch, cfg: Config, headers: { get(k: string): string | null }): Promise<Reply> {
  if (!cfg.cronSecret || !same(headers.get("x-linkup-cron") ?? "", cfg.cronSecret)) return { status: 401, body: { error: "unauthorized" } };
  const fetchFn = retrying(fetchRaw, cfg.sleep); const out: Record<string, unknown>[] = [];
  for (const platform of ["shopify", "wix"] as const) {
    const ids = ([] as string[]).concat(((await rpc("app_connections", { p_platform: platform })).data ?? []) as string[] | string);
    for (const conn of ids) {
      try {
        let r: any;
        if (platform === "shopify") r = await shopifyVerifyAndSync(rpc, fetchFn, cfg, conn, true);
        else {
          const c = (await rpc("app_credentials", { p_connection: conn })).data as { shop: string } | null;
          r = c ? await wixVerifyAndSync(rpc, fetchFn, cfg, conn, c.shop, true) : { ok: false, reason: "no_credentials" };
        }
        if (!r.ok) await rpc("app_sync_failed", { p_connection: conn, p_reason: r.reason });
        out.push({ platform, connection: conn, ok: r.ok, reason: r.ok ? undefined : r.reason, coupons: r.coupons, products: r.products });
      } catch { out.push({ platform, connection: conn, ok: false, reason: "exception" }); }
    }
  }
  return { status: 200, body: { ok: true, connections: out.length, results: out } };
}
