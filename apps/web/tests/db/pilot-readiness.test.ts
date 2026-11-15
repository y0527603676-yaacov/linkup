import { createHmac, createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";
import * as core from "../../../../supabase/functions/apps/core";

/**
 * Pilot readiness: scheduled app sync without reconnecting (database-held token), privacy (Shopify redaction requests
 * and retention, financial records kept), operator alerts without duplicates, real pilot invitations.
 */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const u: Record<string, Who> = {};
const org: Record<string, string> = {};
let conn = "", connTest = "";
const call = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  return (await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
    keys.map((k) => (typeof args[k] === "object" && args[k] !== null && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k])))).r;
};
const rpc: core.Rpc = async (fn, args = {}) => { try { return { data: await call(svc, fn, args), error: null }; } catch (e) { return { data: null, error: { message: (e as Error).message } }; } };
const q = <T = any>(sql: string, p: unknown[] = []) => db.as<T>(owner, sql, p);
const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
const SECRET = "shpss_secret";
const cfg: core.Config = { shopifyKey: "key123", shopifySecret: SECRET, functionsBase: "https://fn.example/functions/v1/apps", appBase: "https://app.example" };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hook = (topic: string, body: unknown, id: string, shop = "pilot.myshopify.com") => {
  const raw = JSON.stringify(body);
  const h = new Map([["x-shopify-topic", topic], ["x-shopify-shop-domain", shop], ["x-shopify-webhook-id", id],
    ["x-shopify-hmac-sha256", createHmac("sha256", SECRET).update(raw).digest("base64")]]);
  return { raw, headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null } };
};
let seq = 0;
const ingest = (c: string, id: string, email: string, extra: object = {}) => call(svc, "ingest_order_event", { p_connection: c, p_event: {
  event_id: `e-${++seq}`, occurred_at: new Date().toISOString(),
  order: { id, status: "processing", currency: "USD", total: 10_000, tax: 0, shipping: 0, shipping_tax: 0, coupons: [], refunds: [],
    created_at: new Date().toISOString(), email_hash: sha(email), ...extra } } });
/** A Shopify app connection created the way complete_app_install leaves it (credentials in Vault). */
async function appConnection(orgId: string, shop: string) {
  const c = (await q(`insert into store_connections(org_id, platform, site_url, status, method) values ($1, 'shopify', $2, 'connected', 'app') returning id`, [orgId, `https://${shop}`]))[0].id;
  const t = (await q(`select vault.create_secret('{"a":"shpat_live"}', null, '') id`))[0].id;
  await q(`insert into store_app_credentials(connection_id, platform, shop, token_secret) values ($1, 'shopify', $2, $3)`, [c, shop, t]);
  return c as string;
}
/** Simulated Shopify for the scheduled sync; `failCoupon` makes discount creation fail. */
const st = { failCoupon: false };
const res = (status: number, j: unknown) => ({ ok: status < 400, status, json: async () => j, text: async () => JSON.stringify(j) });
const shopF: core.Fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : null; const qy: string = body?.query ?? "";
  if (qy.includes("shop {")) return res(200, { data: { shop: { myshopifyDomain: "pilot.myshopify.com", primaryDomain: { url: "https://pilot.co.il" }, currencyCode: "USD" } } });
  if (qy.includes("webhookSubscriptions(first")) return res(200, { data: { webhookSubscriptions: { nodes: ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "APP_UNINSTALLED"]
    .map((t) => ({ topic: t, uri: "https://fn.example/functions/v1/apps/shopify/webhook" })) }, webPixel: { id: "gid://shopify/WebPixel/1" } } });
  if (qy.includes("webPixelCreate")) return res(200, { data: { webPixelCreate: { webPixel: null, userErrors: [{ code: "TAKEN", message: "exists" }] } } });
  if (qy.includes("webPixel {")) return res(200, { data: { webPixel: { id: "gid://shopify/WebPixel/1" } } });
  if (qy.includes("webPixelUpdate")) return res(200, { data: { webPixelUpdate: { userErrors: [] } } });
  if (qy.includes("codeDiscountNodeByCode")) return res(200, { data: { codeDiscountNodeByCode: null } });
  if (qy.includes("discountCodeBasicCreate")) return st.failCoupon ? res(200, { data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ message: "x" }] } } })
    : res(200, { data: { discountCodeBasicCreate: { codeDiscountNode: { id: "gid://d/1" }, userErrors: [] } } });
  if (qy.includes("products(first")) return res(200, { data: { products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
  return res(404, {});
};

beforeAll(async () => {
  db = await createDb();
  for (const k of ["admin", "store", "creator", "tstore"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@pilot.test`) };
  await q(`insert into platform_admins(user_id) values ($1)`, [(u.admin as any).userId]);
  org.admin = await call(u.admin!, "create_organization", { p_type: "store", p_name: "Admin Org" });
  org.store = await call(u.store!, "create_organization", { p_type: "store", p_name: "Pilot Store" });
  org.creator = await call(u.creator!, "create_organization", { p_type: "creator", p_name: "Pilot Creator" });
  org.tstore = await call(u.tstore!, "create_organization", { p_type: "store", p_name: "Test Store" });
  await q(`update organizations set is_test = true where id = $1`, [org.tstore]);
  conn = await appConnection(org.store, "pilot.myshopify.com");
  connTest = await appConnection(org.tstore, "tst.myshopify.com");
  const p = await call(u.store!, "create_proposal", { p_from_org: org.store, p_commission_bps: 1000, p_invitee_name: "c", p_invitee_contact: "c", p_coupon_discount_pct: 10 });
  await call(u.creator!, "accept_proposal", { p_token: p.token, p_org: org.creator });
}, 90_000);

describe("Scheduled app sync: coupons and agreements reach the shop without reconnecting", () => {
  it("a scheduler job runs every 15 minutes with a token kept in the database (never shown); the route accepts it", async () => {
    const job = await one(`select schedule, command from cron.job where jobname = 'apps-sync'`);
    expect(job.schedule).toBe("*/15 * * * *");
    expect(job.command).toContain("apps_cron_token");
    const token = (await one(`select decrypted_secret t from vault.decrypted_secrets where name = 'apps_cron_token'`)).t as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await core.syncAll(rpc, shopF, cfg, { get: () => "wrong" })).status).toBe(401);
    expect((await core.syncAll(rpc, shopF, cfg, { get: () => null })).status).toBe(401);
    const r = await core.syncAll(rpc, shopF, cfg, { get: (k) => (k === "x-linkup-cron" ? token : null) });
    expect(r.status).toBe(200);
    expect((r.body as any).results.find((x: any) => x.connection === conn)).toMatchObject({ ok: true, coupons: { created: 1 } });
  });
  it("coupon creation failing → recorded (operator alert); next clean sync clears it", async () => {
    const token = (await one(`select decrypted_secret t from vault.decrypted_secrets where name = 'apps_cron_token'`)).t as string;
    await q(`delete from app_coupons`); st.failCoupon = true;
    await core.syncAll(rpc, shopF, cfg, { get: () => token });
    expect((await one(`select last_error from store_connections where id = $1`, [conn])).last_error).toBe("app_sync: coupons_failed:1");
    st.failCoupon = false;
    await core.syncAll(rpc, shopF, cfg, { get: () => token });
    expect((await one(`select last_error from store_connections where id = $1`, [conn])).last_error).toBeNull();
  });
});

describe("Privacy: Shopify redaction requests and retention (financial records kept)", () => {
  it("customers/redact removes that buyer's e-mail hash from orders and stored events; amounts and other buyers stay", async () => {
    await ingest(conn, "7001", "anna@example.com"); await ingest(conn, "7002", "anna@example.com"); await ingest(conn, "7003", "ben@example.com");
    const h = hook("customers/redact", { shop_domain: "pilot.myshopify.com", customer: { id: 1, email: "Anna@Example.com" }, orders_to_redact: [7001] }, "r1");
    const r = await core.shopifyWebhook(rpc, cfg, h.headers, h.raw);
    expect(r.body).toMatchObject({ ok: true, status: "redacted", orders: 2, events: 2 });
    expect(await q(`select external_order_id, customer_email_hash is null gone, total_minor from orders where connection_id = $1 order by 1`, [conn]))
      .toEqual([{ external_order_id: "7001", gone: true, total_minor: 10000 }, { external_order_id: "7002", gone: true, total_minor: 10000 }, { external_order_id: "7003", gone: false, total_minor: 10000 }]);
    expect((await one(`select count(*)::int n from order_events where connection_id = $1 and payload->'order' ? 'email_hash'`, [conn])).n).toBe(1);
    expect((await one(`select count(*)::int n from audit_events where action = 'privacy.customer_redacted'`)).n).toBe(1);
  });
  it("the order-event log stays append-only for everything else", async () => {
    await expect(q(`update order_events set payload = jsonb_set(payload, '{order,total}', '1') where connection_id = $1`, [conn])).rejects.toThrow(/append_only/);
    await expect(q(`delete from order_events where connection_id = $1`, [conn])).rejects.toThrow(/append_only/);
  });
  it("customers/data_request is recorded for the operator (LINKUP holds only the hash)", async () => {
    const h = hook("customers/data_request", { shop_domain: "pilot.myshopify.com", customer: { email: "ben@example.com" }, data_request: { id: 99 } }, "r2");
    expect((await core.shopifyWebhook(rpc, cfg, h.headers, h.raw)).body).toMatchObject({ ok: true, stored_customer_data: "email_hash_only" });
    expect((await one(`select details from audit_events where action = 'privacy.request_received'`)).details).toEqual({ kind: "data_request", ref: "99" });
  });
  it("retention: e-mail hashes older than 120 days are removed; recent ones stay", async () => {
    await ingest(connTest, "8001", "old@example.com"); await ingest(connTest, "8002", "new@example.com");
    await q(`update orders set order_created_at = now() - interval '200 days' where external_order_id = '8001'`);
    await q(`set session_replication_role = replica`);
    await q(`update order_events set received_at = now() - interval '200 days' where external_order_id = '8001'`);
    await q(`set session_replication_role = origin`);
    expect(await call(svc, "privacy_retention_run")).toEqual({ orders: 1, events: 1 });
    expect(await q(`select external_order_id, customer_email_hash is null gone from orders where connection_id = $1 order by 1`, [connTest]))
      .toEqual([{ external_order_id: "8001", gone: true }, { external_order_id: "8002", gone: false }]);
    expect((await one(`select cron.job.schedule from cron.job where jobname = 'privacy-retention'`)).schedule).toBe("43 3 * * *");
  });
  it("shop/redact removes every hash of the shop, revokes access and disconnects; orders and amounts kept", async () => {
    const h = hook("shop/redact", { shop_domain: "tst.myshopify.com" }, "r3", "tst.myshopify.com");
    expect((await core.shopifyWebhook(rpc, cfg, h.headers, h.raw)).body).toMatchObject({ ok: true, status: "redacted" });
    expect((await one(`select count(*)::int n from orders where connection_id = $1 and customer_email_hash is not null`, [connTest])).n).toBe(0);
    expect((await one(`select count(*)::int n from orders where connection_id = $1`, [connTest])).n).toBe(2);
    expect((await one(`select status from store_connections where id = $1`, [connTest])).status).toBe("disconnected");
    expect((await one(`select s.secret from vault.secrets s join store_app_credentials c on c.token_secret = s.id where c.shop = 'tst.myshopify.com'`)).secret).toBe("revoked");
  });
  it("privacy functions are service-only", async () => {
    for (const s of ["privacy_redact_shop(null, null)", "privacy_retention_run()", "privacy_redact_customer(null, null, null, null)", "ops_health_check()", "apps_check_cron(null)", "app_sync_ok(null)"])
      await expect(db.as(u.store!, `select public.${s}`)).rejects.toThrow(/permission denied/);
  });
});

describe("Operator alerts: only problems that need a person, no duplicates", () => {
  const notes = async () => (await one(`select count(*)::int n from notifications where kind = 'ops_alert'`)).n as number;
  it("token refresh failure on a real store → one alert, one notification to the admin; repeated checks don't repeat it", async () => {
    await q(`update store_connections set last_error = 'app_sync: token_refresh_failed', last_error_at = now(), last_sync_at = now() where id = $1`, [conn]);
    await call(svc, "ops_health_check"); await call(svc, "ops_health_check");
    const a = await call(u.admin!, "admin_ops_alerts");
    expect(a.map((x: any) => [x.kind, x.org])).toEqual([["token_refresh_failed", "Pilot Store"]]);
    expect(a[0].occurrences).toBe(2);
    expect(await notes()).toBe(1);
    expect((await one(`select org_id from notifications where kind = 'ops_alert'`)).org_id).toBe(org.admin);
  });
  it("cause gone → resolved automatically; the same problem flapping within 24 hours is not notified again", async () => {
    await q(`update store_connections set last_error = null where id = $1`, [conn]);
    expect(await call(svc, "ops_health_check")).toMatchObject({ open: 0, resolved: 1 });
    await q(`update store_connections set last_error = 'app_sync: token_refresh_failed', last_error_at = now() where id = $1`, [conn]);
    await call(svc, "ops_health_check");
    expect((await call(u.admin!, "admin_ops_alerts")).length).toBe(1);
    expect(await notes()).toBe(1);
    await q(`update store_connections set last_error = null where id = $1`, [conn]); await call(svc, "ops_health_check");
  });
  it("coupon failure, silent store and a store that left with active partnerships are alerts; test activities never are", async () => {
    await q(`update store_connections set last_error = 'app_sync: coupons_failed:2', last_error_at = now() where id = $1`, [conn]);
    await q(`update store_connections set status = 'connected', last_error = 'app_sync: token_refresh_failed', last_error_at = now() where id = $1`, [connTest]);
    await call(svc, "ops_health_check");
    expect((await call(u.admin!, "admin_ops_alerts")).map((x: any) => x.kind)).toEqual(["coupon_sync_failed"]);
    await q(`update store_connections set last_error = null, last_sync_at = now() - interval '2 days' where id = $1`, [conn]);
    await call(svc, "ops_health_check");
    expect((await call(u.admin!, "admin_ops_alerts")).map((x: any) => x.kind)).toEqual(["store_silent"]);
    await q(`update store_connections set status = 'disconnected' where id = $1`, [conn]);
    await call(svc, "ops_health_check");
    expect((await call(u.admin!, "admin_ops_alerts")).map((x: any) => x.kind)).toEqual(["store_disconnected"]);
    await q(`update store_connections set status = 'connected', last_sync_at = now() where id = $1`, [conn]);
    await call(svc, "ops_health_check");
    expect(await call(u.admin!, "admin_ops_alerts")).toEqual([]);
  });
  it("order events left unprocessed → backlog alert", async () => {
    await q(`insert into order_events(connection_id, event_id, external_order_id, event_type, occurred_at, payload, received_at)
             values ($1, 'stuck-1', '9001', 'order.create', now(), '{}', now() - interval '1 hour')`, [conn]);
    await call(svc, "ops_health_check");
    expect((await call(u.admin!, "admin_ops_alerts")).map((x: any) => [x.kind, x.detail])).toEqual([["order_backlog", "1 events"]]);
    await q(`update order_events set processed_at = now() where event_id = 'stuck-1'`);
    await call(svc, "ops_health_check");
    expect(await call(u.admin!, "admin_ops_alerts")).toEqual([]);
    expect((await one(`select schedule from cron.job where jobname = 'ops-health'`)).schedule).toBe("*/15 * * * *");
  });
  it("only the platform admin sees alerts", async () => {
    await expect(call(u.store!, "admin_ops_alerts")).rejects.toThrow(/forbidden/);
  });
});

describe("Pilot invitations (sign-up stays closed to the public)", () => {
  it("the admin approves an address as a real pilot participant; activities it creates are real, not test", async () => {
    await call(u.admin!, "admin_add_signup", { p_email: "Shop@Pilot.co.il", p_note: "first pilot store", p_is_test: false });
    expect(await one(`select is_test from signup_allowlist where email = 'shop@pilot.co.il'`)).toEqual({ is_test: false });
    expect(await call({ role: "anon" } as Who, "signup_allowed", { p_email: "shop@pilot.co.il" })).toBe(true);
    const id = await createUser(db, "shop@pilot.co.il");
    const o = await call({ role: "authenticated", userId: id }, "create_organization", { p_type: "store", p_name: "Real Pilot" });
    expect(await one(`select is_test from organizations where id = $1`, [o])).toEqual({ is_test: false });
    expect((await call(u.admin!, "admin_test_signups")).find((x: any) => x.email === "shop@pilot.co.il")).toMatchObject({ is_test: false, registered: true });
  });
  it("test addresses stay test; non-admins can't approve anyone", async () => {
    await call(u.admin!, "admin_add_signup", { p_email: "qa@pilot.test", p_note: null, p_is_test: true });
    expect(await one(`select is_test from signup_allowlist where email = 'qa@pilot.test'`)).toEqual({ is_test: true });
    await expect(call(u.store!, "admin_add_signup", { p_email: "x@y.co", p_note: null, p_is_test: false })).rejects.toThrow(/forbidden/);
  });
});
