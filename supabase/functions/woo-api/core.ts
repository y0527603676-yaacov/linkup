// LINKUP ↔ WooCommerce without a plugin: REST API keys from WooCommerce's official auth endpoint.
// Pure logic shared by the Edge Function (Deno) and Node tests: WebCrypto + injected fetch/rpc only.
// Secrets arrive from Vault through service-role RPCs and are never logged or returned.

export type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: { message: string } | null }>;
export type Fetch = typeof fetch;
type Creds = {
  connection_id: string; org_id: string; site_url: string; status: string; key: string; secret: string; webhook_secret: string;
  webhook_ids: number[]; currency: string | null; synced_orders_at: string | null; products_page: number; products_pass_started_at: string | null;
  products_pass_done_at: string | null;
};

const enc = new TextEncoder();
const PERMANENT = new Set(["invalid_event", "unknown_connection", "connection_disconnected"]);
export const WEBHOOK_TOPICS = ["order.created", "order.updated", "product.created", "product.updated"] as const;
const PRODUCT_PASS_EVERY_MS = 6 * 3600_000;

/* ---------- mapping (same shape and event ids as the plugin) ---------- */
export const toMinor = (v: unknown) => Math.round((Number.parseFloat(String(v ?? "0")) || 0) * 100);
const gmt = (s: unknown) => (typeof s === "string" && s ? Date.parse(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`) : NaN);

async function sha256Hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

type Meta = { key?: string; value?: unknown }[];
const meta = (m: Meta | undefined, k: string) => (m ?? []).find((x) => x?.key === k)?.value;

/** LINKUP referral of an order, as "CODE|unix-time" like the plugin: the plugin's cookie (_linkup_ref) or
 *  WooCommerce Order Attribution (utm_source=linkup, same visit only; time = the visit's start). */
export function orderRef(o: { meta_data?: Meta; date_created_gmt?: string }): string {
  const plugin = meta(o.meta_data, "_linkup_ref");
  if (typeof plugin === "string" && plugin) return plugin;
  const src = String(meta(o.meta_data, "_wc_order_attribution_utm_source") ?? "").toLowerCase();
  const campaign = String(meta(o.meta_data, "_wc_order_attribution_utm_campaign") ?? "");
  if (src !== "linkup" || !/^[A-Za-z0-9]{4,16}$/.test(campaign)) return "";
  const start = gmt(String(meta(o.meta_data, "_wc_order_attribution_session_start_time") ?? "").replace(" ", "T"));
  const at = Number.isNaN(start) ? gmt(o.date_created_gmt) : start;
  return Number.isNaN(at) ? "" : `${campaign.toUpperCase()}|${Math.floor(at / 1000)}`;
}

export async function mapOrder(o: any) {
  const modified = Math.floor((gmt(o.date_modified_gmt) || gmt(o.date_modified) || Date.now()) / 1000);
  const created = gmt(o.date_created_gmt) || gmt(o.date_created);
  const refunds = (Array.isArray(o.refunds) ? o.refunds : []).map((r: any) => ({ id: String(r.id), amount: Math.abs(toMinor(r.total ?? r.amount)) }));
  const email = String(o.billing?.email ?? "").trim().toLowerCase();
  const status = String(o.status ?? "");
  return {
    event_id: `o${o.id}-m${modified}-r${refunds.length}-${status}`,
    type: "order.upserted",
    occurred_at: new Date(modified * 1000).toISOString(),
    order: {
      id: String(o.id), status, currency: String(o.currency ?? "").toUpperCase(),
      total: toMinor(o.total), tax: toMinor(o.cart_tax), shipping: toMinor(o.shipping_total), shipping_tax: toMinor(o.shipping_tax),
      coupons: (Array.isArray(o.coupon_lines) ? o.coupon_lines : []).map((c: any) => String(c.code ?? "")).filter(Boolean),
      ref: orderRef(o), email_hash: email ? await sha256Hex(email) : "",
      created_at: new Date(Number.isNaN(created) ? modified * 1000 : created).toISOString(), refunds,
    },
  };
}

export function mapProduct(p: any, currency: string) {
  if (!p || p.type === "variation") return null;
  const price = p.price === "" || p.price == null ? null : toMinor(p.price);
  return {
    id: String(p.id), name: String(p.name ?? "").replace(/<[^>]*>/g, "").trim(), url: String(p.permalink ?? ""),
    image: String(p.images?.[0]?.src ?? ""), price, currency,
    in_stock: p.stock_status === "instock" || p.stock_status === "onbackorder",
    stock_qty: p.manage_stock ? Number(p.stock_quantity ?? 0) : null,
    categories: (p.categories ?? []).map((c: any) => String(c.name ?? "")).filter(Boolean).slice(0, 10),
    status: p.status === "publish" && p.catalog_visibility !== "hidden" ? "publish" : "hidden",
  };
}

/* ---------- webhook signature: base64(HMAC-SHA256(secret, raw body)) ---------- */
export async function wooSignature(secret: string, raw: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(raw)));
  let bin = ""; for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}
export async function verifyWooSignature(secret: string, raw: string, given: string | null) {
  if (!secret || !given) return false;
  const want = await wooSignature(secret, raw);
  if (want.length !== given.length) return false;
  let d = 0; for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ given.charCodeAt(i);
  return d === 0;
}

/* ---------- WooCommerce REST client (HTTPS + Basic auth) ---------- */
export class WooError extends Error { constructor(public code: string, public status = 0) { super(code); } }

export function wooClient(site: string, key: string, secret: string, f: Fetch) {
  const base = `${site.replace(/\/+$/, "")}/wp-json/wc/v3`;
  const auth = `Basic ${btoa(`${key}:${secret}`)}`;
  const call = async (method: string, path: string, body?: unknown, query?: Record<string, string | number>) => {
    const u = new URL(base + path);
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await f(u.toString(), { method, headers: { authorization: auth, "content-type": "application/json", "user-agent": "LINKUP/1.0" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    } catch { throw new WooError("store_unreachable"); }
    if (res.status === 401 || res.status === 403) throw new WooError("access_revoked", res.status);
    if (res.status === 404 && path !== "" && !path.startsWith("/webhooks/") && !path.startsWith("/coupons/")) throw new WooError("rest_unavailable", 404);
    if (res.status >= 500) throw new WooError("store_error", res.status);
    const text = await res.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { throw new WooError("rest_unavailable", res.status); }
    if (!res.ok) throw new WooError(String(json?.code ?? "store_rejected").slice(0, 60), res.status);
    return json;
  };
  return { get: (p: string, q?: Record<string, string | number>) => call("GET", p, undefined, q), post: (p: string, b: unknown) => call("POST", p, b),
    put: (p: string, b: unknown) => call("PUT", p, b), del: (p: string) => call("DELETE", p, undefined, { force: "true" }) };
}

/* ---------- partner coupons ---------- */
const MANAGED = "linkup_managed";
const isManaged = (c: any) => meta(c.meta_data, MANAGED) === "1" || meta(c.meta_data, "_linkup_managed") === "1" || c.description === "LINKUP partner coupon";

export async function ensureCoupon(woo: ReturnType<typeof wooClient>, want: { code: string; discount_pct: number; active: boolean }) {
  if (!/^[A-Z0-9]{4,16}$/.test(want.code)) return "skipped";
  const found = (await woo.get("/coupons", { code: want.code.toLowerCase(), per_page: 5 })) as any[];
  const existing = (found ?? []).find((c) => String(c.code).toLowerCase() === want.code.toLowerCase());
  // Inactive = expired yesterday (WooCommerce's REST API has no draft status for coupons).
  const expires = want.active ? null : new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const body = { discount_type: "percent", amount: String(want.discount_pct), date_expires: expires };
  if (!existing) {
    await woo.post("/coupons", { code: want.code.toLowerCase(), description: "LINKUP partner coupon", ...body, meta_data: [{ key: MANAGED, value: "1" }] });
    return "created";
  }
  if (!isManaged(existing)) return "foreign";   // never touch a coupon the store made itself
  const same = Number(existing.amount) === want.discount_pct && existing.discount_type === "percent" && (existing.date_expires ? !want.active : want.active);
  if (same) return "same";
  await woo.put(`/coupons/${existing.id}`, body);
  return "updated";
}

/* ---------- operations ---------- */
const creds = async (rpc: Rpc, id: string): Promise<Creds | null> => {
  const { data, error } = await rpc("woo_api_credentials", { p_connection: id });
  if (error) throw new Error("db_unavailable");
  return data as Creds | null;
};
const errCode = (e: unknown) => (e instanceof WooError ? e.code : e instanceof Error ? e.message : "unknown_error").slice(0, 80);

/** WooCommerce posted the keys (JSON) to our callback. */
export async function handleAuthCallback(rpc: Rpc, raw: string) {
  let b: any; try { b = JSON.parse(raw); } catch { return { status: 400, body: { error: "invalid_json" } }; }
  const { data, error } = await rpc("woo_api_complete", { p_state: String(b?.user_id ?? ""), p_key: String(b?.consumer_key ?? ""),
    p_secret: String(b?.consumer_secret ?? ""), p_permissions: String(b?.key_permissions ?? ""), p_key_id: Number(b?.key_id) || null });
  if (error) return { status: 400, body: { error: error.message } };
  return { status: 200, body: { ok: true }, connectionId: String(data.connection_id) };
}

export async function registerWebhooks(rpc: Rpc, f: Fetch, c: Creds, deliveryBase: string) {
  const woo = wooClient(c.site_url, c.key, c.secret, f);
  const keep: number[] = [];
  const have = new Set<string>();
  for (const id of c.webhook_ids ?? []) {
    try {
      const w = await woo.get(`/webhooks/${id}`);
      if (w?.id && String(w.delivery_url ?? "").startsWith(deliveryBase)) {
        if (w.status !== "active") await woo.put(`/webhooks/${id}`, { status: "active" });   // re-enable after delivery failures
        keep.push(Number(w.id)); have.add(String(w.topic));
      }
    } catch (e) { if (errCode(e) === "access_revoked") throw e; }
  }
  for (const topic of WEBHOOK_TOPICS) {
    if (have.has(topic)) continue;
    const w = await woo.post("/webhooks", { name: `LINKUP ${topic}`, topic, status: "active",
      delivery_url: `${deliveryBase}?c=${c.connection_id}`, secret: c.webhook_secret });
    keep.push(Number(w.id));
  }
  await rpc("woo_api_save_state", { p_connection: c.connection_id, p_state: { webhook_ids: keep } });
  return keep;
}

/** Reconcile one connection: coupons, recent orders, one page of products. */
export async function syncConnection(rpc: Rpc, f: Fetch, id: string, deliveryBase: string, now = Date.now()) {
  const c = await creds(rpc, id);
  if (!c) return { id, skipped: true };
  const woo = wooClient(c.site_url, c.key, c.secret, f);
  if (c.status === "disconnected") {   // clean up once: remove our webhooks, forget the keys
    for (const w of c.webhook_ids ?? []) { try { await woo.del(`/webhooks/${w}`); } catch { /* store may be gone */ } }
    await rpc("woo_api_forget", { p_connection: id });
    return { id, forgotten: true };
  }
  const out = { id, coupons: 0, orders: 0, products: 0, error: null as string | null };
  try {
    const currency = c.currency ?? String((await woo.get("/data/currencies/current"))?.code ?? "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new WooError("rest_unavailable");
    await registerWebhooks(rpc, f, c, deliveryBase);

    const s = await rpc("plugin_sync", { p_connection: id, p_plugin_version: "api" });
    if (s.error) throw new Error(s.error.message);
    for (const cp of (s.data?.coupons ?? []) as any[]) {
      if ((await ensureCoupon(woo, { code: String(cp.code), discount_pct: Number(cp.discount_pct), active: !!cp.active })) !== "same") out.coupons++;
    }

    // Orders changed since the last run (5-minute overlap; deterministic event ids make repeats harmless).
    const since = new Date((c.synced_orders_at ? Date.parse(c.synced_orders_at) : now - 2 * 86_400_000) - 300_000).toISOString().slice(0, 19);
    let latest = c.synced_orders_at ? Date.parse(c.synced_orders_at) : now - 2 * 86_400_000;
    for (let page = 1; page <= 5; page++) {
      const list = (await woo.get("/orders", { modified_after: since, dates_are_gmt: "true", per_page: 50, page, orderby: "modified", order: "asc" })) as any[];
      for (const o of list ?? []) {
        const r = await rpc("ingest_order_event", { p_connection: id, p_event: await mapOrder(o) });
        if (r.error && !PERMANENT.has(r.error.message)) throw new Error("db_unavailable");
        out.orders++;
        latest = Math.max(latest, gmt(o.date_modified_gmt) || 0);
      }
      if (!list || list.length < 50) break;
    }

    // Products: one page per run, a full pass every 6 hours (missing products are hidden at the end of a pass).
    let pg = c.products_page || 1;
    let started = c.products_pass_started_at;
    const due = !!started || !c.products_pass_done_at || now - Date.parse(c.products_pass_done_at) > PRODUCT_PASS_EVERY_MS;
    if (due) {
      if (!started) { started = new Date(now).toISOString(); pg = 1; }
      const list = (await woo.get("/products", { per_page: 100, page: pg, status: "any", orderby: "id", order: "asc" })) as any[];
      const items = (list ?? []).map((p) => mapProduct(p, currency)).filter(Boolean);
      const last = !list || list.length < 100;
      const r = await rpc("plugin_sync_products", { p_connection: id, p_products: items, p_full_started_at: last ? started : null });
      if (r.error && !PERMANENT.has(r.error.message)) throw new Error("db_unavailable");
      out.products = items.length;
      await rpc("woo_api_save_state", { p_connection: id, p_state: last ? { products_page: 1, products_pass_started_at: null, products_pass_done_at: new Date(now).toISOString() } : { products_page: pg + 1, products_pass_started_at: started } });
    }
    await rpc("woo_api_save_state", { p_connection: id, p_state: { currency, synced_orders_at: new Date(Math.max(latest, now - 2 * 86_400_000)).toISOString() } });
    await rpc("woo_api_report", { p_connection: id, p_error: null });
  } catch (e) {
    out.error = errCode(e);
    await rpc("woo_api_report", { p_connection: id, p_error: out.error });
  }
  return out;
}

/** A WooCommerce webhook delivery. Always 200 for permanent problems so WooCommerce does not disable the webhook. */
export async function handleWebhook(rpc: Rpc, connectionId: string, headers: Headers, raw: string) {
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return { status: 401, body: { error: "unauthorized" } };
  const c = await creds(rpc, connectionId);
  if (!c || c.status === "disconnected") return { status: 200, body: { ignored: true } };
  if (raw.startsWith("webhook_id=")) return { status: 200, body: { ok: true } };   // WooCommerce's creation ping
  if (!(await verifyWooSignature(c.webhook_secret, raw, headers.get("x-wc-webhook-signature")))) return { status: 401, body: { error: "unauthorized" } };
  const topic = headers.get("x-wc-webhook-topic") ?? "";
  let b: any; try { b = JSON.parse(raw); } catch { return { status: 200, body: { ignored: "invalid_json" } }; }
  const r = topic.startsWith("order.")
    ? await rpc("ingest_order_event", { p_connection: connectionId, p_event: await mapOrder(b) })
    : topic.startsWith("product.")
    ? await rpc("plugin_sync_products", { p_connection: connectionId, p_products: [mapProduct(b, c.currency ?? "ILS")].filter(Boolean), p_full_started_at: null })
    : { data: null, error: null };
  if (r.error && !PERMANENT.has(r.error.message)) return { status: 503, body: { error: "temporary_error" } };
  return { status: 200, body: { ok: true } };
}
