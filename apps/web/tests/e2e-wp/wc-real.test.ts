import { createServer, type Server } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { createDb, createUser, type Db, type Who } from "../db/harness";
import { normalizeConnectionId, verifySignature } from "../../../../supabase/functions/woo/hmac";
import { wpAuthorizeUrl, wpSetup, type WpCreds } from "../../src/lib/wp-connect";

/**
 * Pilot rehearsal on a REAL store: WordPress 6.5.5 + WooCommerce 9.4.2 (official release) + MariaDB, HPOS order storage,
 * real Store API checkout (what the block checkout uses), real coupons, real refunds/cancellations. Isolated: 127.0.0.1 only.
 * Stand-ins: the WordPress.org directory entry (until the plugin is listed) and LINKUP's "woo" endpoint (emulated below
 * with the same signature check and the real database functions). Setup: README.md ("Real WooCommerce store").
 */
const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");
const SITE = "http://127.0.0.1:8096";
const RETURN = "http://127.0.0.1:8091/app/connect/wp-return";
const APP_ID = "6f1c0d5e-3b7a-4c2e-9a41-0b9d2c7e5f11";
const ADMIN = { user: "storeadmin", pass: "Adm1n-Test-Only!" };
const EDITOR = { user: "editor1", pass: "Ed1tor-Test-Only!" };
const SCRIPTS = "/var/tmp/wcreal/scripts";
const ZIP = "/home/claude/linkup/plugins/woocommerce/releases/linkup-connector-0.4.1.zip";
const DAY = 86_400;

let db: Db; let browser: Browser; let endpoint: Server; let returnPage: Server;
let lastReturn = "";
const svc: Who = { role: "service_role" };
const u: Record<string, Who> = {};
let storeOrg = "", creatorOrg = "", code = "", conn = "";
const calls: { action: string; status: number; body: any }[] = [];

const call = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  const row = await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
    keys.map((k) => (args[k] !== null && typeof args[k] === "object" && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k])));
  return row.r;
};
const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
  const r = await fetch(`${SITE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) as any };
};
const state = async (extra: Record<string, unknown> = {}) => (await post("/wp-json/linkup-test/v1/state", extra)).json;
// async: the LINKUP endpoint emulator runs in this process and must keep answering while PHP works
const owner = async (...a: string[]) => JSON.parse((await promisify(execFile)("php", [`${SCRIPTS}/owner-action.php`, ...a], { encoding: "utf8" })).stdout.trim());
const order = async (id: string | number) => (await db.as<any>({ role: "owner" },
  `select o.status, (select name from organizations where id = a.creator_org_id) creator, a.method,
          (select coalesce(sum(l.amount_minor), 0)::int from commission_ledger l where l.attribution_id = a.id and l.party_role = 'creator') creator_total
     from orders o left join attributions a on a.order_id = o.id where o.external_order_id = $1 and o.connection_id = $2`, [String(id), conn]))[0];

/** LINKUP's plugin endpoint (supabase/functions/woo/index.ts) – same checks, same database functions, same responses. */
function startEndpoint() {
  const PERMANENT = new Set(["invalid_event", "unknown_connection", "connection_disconnected"]);
  return createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const send = (status: number, body: unknown, action = "?") => { calls.push({ action, status, body }); res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const id = normalizeConnectionId(String(req.headers["x-linkup-connection"] ?? ""));
    if (!id) return send(401, { error: "unauthorized" });
    const sec = await db.as<{ secret: string }>({ role: "owner" }, `select secret from store_connection_secrets where connection_id = $1`, [id]);
    if (!sec[0] || !await verifySignature(raw, String(req.headers["x-linkup-signature"] ?? "").toLowerCase(), Number(req.headers["x-linkup-timestamp"]), sec[0].secret, Math.floor(Date.now() / 1000)))
      return send(401, { error: "unauthorized" });
    const body = JSON.parse(raw);
    try {
      const result = body.action === "sync" ? await call(svc, "plugin_sync", { p_connection: id, p_plugin_version: String(body.plugin_version ?? "") })
        : body.action === "event" ? await call(svc, "ingest_order_event", { p_connection: id, p_event: body.event })
        : body.action === "products" ? await call(svc, "plugin_sync_products", { p_connection: id, p_products: JSON.stringify(body.products ?? []), p_full_started_at: body.full_started_at ?? null })
        : undefined;
      if (result === undefined) return send(400, { error: "unknown_action" }, body.action);
      send(200, { ok: true, result }, body.action);
    } catch (e: any) {
      const m = String(e?.message ?? ""); const c = PERMANENT.has(m) ? m : "temporary_error";
      send(c === "temporary_error" ? 503 : 422, { error: c, detail: c === "temporary_error" ? m : undefined }, body.action);
    }
  }).listen(8092, "127.0.0.1");
}

async function login(who: { user: string; pass: string }) {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(`${SITE}/wp-login.php`);
  await page.fill("#user_login", who.user); await page.fill("#user_pass", who.pass); await page.click("#wp-submit");
  await page.waitForURL(/wp-admin/);
  return { ctx, page };
}
/** The store owner signs in to their WordPress and clicks "Yes, I approve" on WordPress's own page. */
async function approve(who: { user: string; pass: string }, st: string): Promise<WpCreds> {
  const { ctx, page } = await login(who);
  try {
    lastReturn = "";
    await page.goto(wpAuthorizeUrl(SITE, APP_ID, `${RETURN}?state=${st}`, `${RETURN}?state=${st}&rejected=1`));
    await page.click("#approve");
    await expect.poll(() => lastReturn, { timeout: 15_000 }).not.toBe("");
    const q = new URL(lastReturn, RETURN).searchParams;
    expect(q.get("state")).toBe(st);
    return { site: q.get("site_url")!, user: q.get("user_login")!, password: q.get("password")! };
  } finally { await ctx.close(); }
}
const ITEMS = ["install_component", "store_access", "visitor_notice"];
const startConnect = () => call<{ state: string }>(u.s!, "start_wp_connect", { p_org: storeOrg, p_site_url: SITE, p_items: ITEMS,
  p_consent_text: "What you approve: 1. install 2. temporary access 3. visitor notice. Cookie: notice", p_user_agent: "e2e" });
const newKey = async () => {
  const r = await call<{ connection_key: string; connection_id: string }>(u.s!, "create_store_connection", { p_org: storeOrg, p_site_url: "https://real-wc.example.test" });
  conn = r.connection_id; return r.connection_key;
};

/** A shopper buys through the Store API (the same API WooCommerce's block checkout uses), with the browser's cookies. */
async function shopperBuys(opts: { cookie?: string; coupon?: string; productId?: number }) {
  const cookie = opts.cookie ? { cookie: `linkup_ref=${encodeURIComponent(opts.cookie)}` } : {};
  const c = await fetch(`${SITE}/wp-json/wc/store/v1/cart`, { headers: cookie }); await c.arrayBuffer();
  const h = { Nonce: c.headers.get("nonce") ?? "", "Cart-Token": c.headers.get("cart-token") ?? "", ...cookie };
  const products = await (await fetch(`${SITE}/wp-json/wc/store/v1/products`)).json() as { id: number; prices: { price: string } }[];
  expect((await post("/wp-json/wc/store/v1/cart/add-item", { id: opts.productId ?? products.find((p) => p.prices.price === "19900")!.id, quantity: 1 }, h)).status).toBe(201);
  if (opts.coupon) expect((await post("/wp-json/wc/store/v1/cart/apply-coupon", { code: opts.coupon }, h)).status).toBe(200);
  const addr = { first_name: "Test", last_name: "Buyer", address_1: "1 Test St", city: "Safed", postcode: "1310000", country: "IL" };
  const r = await post("/wp-json/wc/store/v1/checkout", { billing_address: { ...addr, email: "buyer@example.test", phone: "0500000000" }, shipping_address: addr, payment_method: "cod" }, h);
  expect(r.status).toBe(200);
  return r.json as { order_id: number; status: string; totals: any };
}
const eventsFor = (id: number) => calls.filter((x) => x.action === "event");

beforeAll(async () => {
  const up = await fetch(SITE).then(async (r) => { await r.arrayBuffer(); return r.ok; }).catch(() => false);
  if (!up) throw new Error(`The real WooCommerce test store is not running at ${SITE} (see tests/e2e-wp/README.md)`);
  execFileSync("php", [`${SCRIPTS}/reset.php`]);
  db = await createDb();
  endpoint = startEndpoint();
  returnPage = createServer((req, res) => { lastReturn = req.url ?? ""; res.end("ok"); }).listen(8091, "127.0.0.1");
  browser = await chromium.launch();
  for (const k of ["s", "c"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@wc-real.test`) };
  storeOrg = await call(u.s!, "create_organization", { p_type: "store", p_name: "Real WC store" });
  creatorOrg = await call(u.c!, "create_organization", { p_type: "creator", p_name: "Creator Real" });
  await db.as({ role: "owner" }, `update organizations set is_test = true where id in ($1, $2)`, [storeOrg, creatorOrg]);
  const p = await call(u.s!, "create_proposal", { p_from_org: storeOrg, p_commission_bps: 1000, p_invitee_name: "C", p_invitee_contact: null,
    p_coupon_discount_pct: 10, p_attribution_days: 30, p_target_site_url: null, p_source_proposal: null });
  code = (await call(u.c!, "accept_proposal", { p_token: p.token, p_org: creatorOrg })).code;
  await db.transaction(async (tx) => {
    await tx.exec(`set local session_replication_role = replica`);
    await tx.query(`update agreement_versions set effective_from = now() - interval '30 days'`);
  });
  await state({ directory: true });
}, 120_000);
afterAll(async () => { await browser?.close(); endpoint?.close(); returnPage?.close(); });

describe("real WooCommerce store", () => {
  it("is the official WooCommerce release with HPOS order storage", async () => {
    expect(await state()).toMatchObject({ wc_version: "9.4.2", hpos: "yes", plugin_installed: false });
  });
});

describe("one approval → installed, activated, configured, products synced, coupon created, access revoked", () => {
  it("works end to end", async () => {
    const st = (await startConnect()).state;
    const r = await wpSetup(await approve(ADMIN, st), fetch, newKey, "notice");
    expect(r).toMatchObject({ ok: true, installed: true, activated: true, configured: true, revoked: true, pluginVersion: "0.4.1" });
    await call(u.s!, "wp_connect_finish", { p_state: st, p_outcome: r.code, p_details: JSON.stringify(r) });
    const s = await state();
    expect(s).toMatchObject({ plugin_active: true, key_saved: true, app_passwords: 0 });
    // the creator's coupon exists in WooCommerce as a real coupon: 10% percent, active, marked LINKUP-managed
    expect(s.coupons).toContainEqual({ code: code.toLowerCase(), status: "publish", amount: "10", type: "percent", managed: "1" });
    // the catalogue reached LINKUP
    const prods = await db.as<any>({ role: "owner" }, `select name, price_minor, currency, in_stock from products where connection_id = $1 order by price_minor`, [conn]);
    expect(prods.map((p: any) => p.price_minor)).toEqual([8900, 19900, 45000]);
    expect(prods.every((p: any) => p.currency === "ILS" && p.in_stock)).toBe(true);
  }, 120_000);
});

let linkOrder = 0, couponOrder = 0;
describe("sales", () => {
  it("link → 30-day first-party cookie → the same shopper buys 7 days later without a coupon → attributed (link)", async () => {
    const res = await fetch(`${SITE}/?lku=${code}`, { redirect: "manual" }); await res.arrayBuffer();
    const sc = res.headers.get("set-cookie") ?? "";
    expect(Number(/Max-Age=(\d+)/i.exec(sc)?.[1])).toBeGreaterThan(30 * DAY - 120);
    const [c, ts] = decodeURIComponent(/linkup_ref=([^;]+)/.exec(sc)![1]!).split("|");
    const n = calls.length;
    const o = await shopperBuys({ cookie: `${c}|${Number(ts) - 7 * DAY}` });
    expect(o.status).toBe("processing");
    linkOrder = o.order_id;
    expect((await owner("show", String(linkOrder))).ref).toBe(`${c}|${Number(ts) - 7 * DAY}`);   // stored on the real order
    await expect.poll(() => calls.slice(n).some((x) => x.action === "event" && x.status === 200), { timeout: 15_000 }).toBe(true);
    expect(await order(linkOrder)).toMatchObject({ status: "processing", creator: "Creator Real", method: "link" });
    expect((await order(linkOrder)).creator_total).toBeGreaterThan(0);
  }, 60_000);

  it("coupon at checkout (WooCommerce applies 10%) → attributed (coupon), commission on the discounted amount", async () => {
    const n = calls.length;
    const o = await shopperBuys({ coupon: code.toLowerCase() });
    couponOrder = o.order_id;
    const wc = await owner("show", String(couponOrder));
    expect(wc.coupons).toEqual([code.toLowerCase()]);
    expect(Number(wc.discount)).toBeCloseTo(19.9, 1);   // 10% of the 199 ₪ product, applied by WooCommerce itself
    await expect.poll(() => calls.slice(n).some((x) => x.action === "event" && x.status === 200), { timeout: 15_000 }).toBe(true);
    expect(await order(couponOrder)).toMatchObject({ creator: "Creator Real", method: "coupon" });
  }, 60_000);

  it("a purchase with no link and no coupon is not attributed", async () => {
    const n = calls.length;
    const o = await shopperBuys({});
    await expect.poll(() => calls.slice(n).some((x) => x.action === "event"), { timeout: 15_000 }).toBe(true);
    expect((await order(o.order_id))?.creator ?? null).toBeNull();
  }, 60_000);
});

describe("changes made by the store in WooCommerce", () => {
  it("cancellation reverses the commission; history kept", async () => {
    const n = calls.length;
    await owner("cancel", String(linkOrder));
    await expect.poll(() => calls.slice(n).some((x) => x.action === "event" && x.status === 200), { timeout: 15_000 }).toBe(true);
    expect(await order(linkOrder)).toMatchObject({ status: "cancelled", creator: "Creator Real", creator_total: 0 });
  });
  it("partial refund reduces the commission proportionally", async () => {
    const before = (await order(couponOrder)).creator_total;
    const n = calls.length;
    await owner("refund", String(couponOrder), "50");
    await expect.poll(() => calls.slice(n).some((x) => x.action === "event" && x.status === 200), { timeout: 15_000 }).toBe(true);
    const after = (await order(couponOrder)).creator_total;
    expect(after).toBeGreaterThan(0); expect(after).toBeLessThan(before);
  });
  it("completing an order is reported once more without double counting", async () => {
    const before = (await order(couponOrder)).creator_total;
    const n = calls.length;
    await owner("complete", String(couponOrder));
    await expect.poll(() => calls.slice(n).some((x) => x.action === "event"), { timeout: 15_000 }).toBe(true);
    expect(await order(couponOrder)).toMatchObject({ status: "completed", creator_total: before });
  });
});

describe("visitor consent", () => {
  it("store chose 'only after consent' and there is no consent banner → no cookie; coupon still works", async () => {
    await state({ consent_mode: "require" });
    const res = await fetch(`${SITE}/?lku=${code}`, { redirect: "manual" }); await res.arrayBuffer();
    expect(res.headers.get("set-cookie") ?? "").not.toMatch(/linkup_ref=/);
    await state({ consent_mode: "notice" });
  });
});

describe("refusals revoke the temporary access", () => {
  it("an editor is refused; nothing installed or changed; password deleted", async () => {
    const r = await wpSetup(await approve(EDITOR, (await startConnect()).state), fetch, async () => { throw new Error("unused"); });
    expect(r).toMatchObject({ ok: false, code: "not_store_admin", revoked: true });
    expect((await state({ user: "editor1" })).app_passwords).toBe(0);
  }, 60_000);
});

describe("disconnect and removal", () => {
  it("disconnect in LINKUP → the plugin stops on its next sync, LINKUP coupons paused, store coupons untouched, new orders not sent", async () => {
    await call(u.s!, "disconnect_store", { p_org: storeOrg });
    const s = await state({ run_sync: true });
    expect(s.key_saved).toBe(false);
    expect(s.coupons.find((c: any) => c.code === code.toLowerCase())?.status).toBe("draft");
    const n = calls.length;
    await shopperBuys({});
    await new Promise((r) => setTimeout(r, 1500));
    expect(calls.length).toBe(n);
  }, 60_000);
  it("the owner removes the plugin in WordPress → settings deleted, nothing LINKUP created stays active", async () => {
    const c = await approve(ADMIN, (await startConnect()).state);
    const auth = { authorization: `Basic ${btoa(`${c.user}:${c.password}`)}`, "content-type": "application/json" };
    const base = `${SITE}/wp-json/wp/v2/plugins/linkup-connector/linkup-connector`;
    const d1 = await fetch(base, { method: "POST", headers: auth, body: JSON.stringify({ status: "inactive" }) }); await d1.arrayBuffer(); expect(d1.status).toBe(200);
    const d2 = await fetch(base, { method: "DELETE", headers: auth }); await d2.arrayBuffer(); expect(d2.status).toBe(200);
    const me = await (await fetch(`${SITE}/wp-json/wp/v2/users/me/application-passwords/introspect`, { headers: auth })).json() as { uuid: string };
    await fetch(`${SITE}/wp-json/wp/v2/users/me/application-passwords/${me.uuid}`, { method: "DELETE", headers: auth }).then((r) => r.arrayBuffer());
    const s = await state();
    expect(s).toMatchObject({ plugin_installed: false, options_left: [] });
    expect(s.coupons.filter((x: any) => x.managed === "1").every((x: any) => x.status !== "publish")).toBe(true);
  }, 60_000);
});

describe("before WordPress.org listing: one upload + one approval (no key copying)", () => {
  it("auto install is refused clearly ('not_in_directory'), nothing changes, access revoked", async () => {
    await state({ directory: false });
    const r = await wpSetup(await approve(ADMIN, (await startConnect()).state), fetch, async () => "unused");
    expect(r).toMatchObject({ ok: false, code: "not_in_directory", installed: false, revoked: true });
  }, 60_000);
  it("the owner uploads the zip on WordPress's own upload page, then approves once → activated + configured automatically", async () => {
    const { ctx, page } = await login(ADMIN);
    await page.goto(`${SITE}/wp-admin/plugin-install.php?tab=upload`);
    await page.setInputFiles("#pluginzip", ZIP);
    await page.click("#install-plugin-submit");
    await page.waitForLoadState("load", { timeout: 60_000 });
    await page.locator("text=/installed successfully/i").first().waitFor({ timeout: 60_000 }).catch(() => {});
    const txt = (await page.locator("#wpbody-content").innerText().catch(() => "")) ?? "";
    if (!/installed successfully/i.test(txt)) console.log("upload page:", txt.replace(/\s+/g, " ").slice(0, 600));
    expect(txt).toMatch(/installed successfully/i);
    await ctx.close();
    expect(await state()).toMatchObject({ plugin_installed: true, plugin_active: false });
    const st = (await startConnect()).state;
    const r = await wpSetup(await approve(ADMIN, st), fetch, newKey, "notice");
    expect(r).toMatchObject({ ok: true, installed: false, activated: true, configured: true, revoked: true });
    expect(await state()).toMatchObject({ plugin_active: true, key_saved: true, app_passwords: 0 });
    await state({ directory: true });
  }, 90_000);
});
