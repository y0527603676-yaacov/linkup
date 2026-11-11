import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";
import { shopifyOrderToEvent } from "../../src/lib/adapters/shopify";
import { wixOrderToEvent } from "../../src/lib/adapters/wix";

/**
 * Universal Connect (migration 20261111101700): custom-site signed API connections, manual coupon mode, sale claims,
 * tracking labels – all through the existing order ingestion and commission engine.
 */
let db: Db;
const TODAY = new Date().toISOString().slice(0, 10);
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
let store: Who, creator: Who, staff: Who, stranger: Who, woo: Who;
let storeOrg: string, creatorOrg: string, wooOrg: string, agreement: string, code: string;

const rpc = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
  return (await db.one<{ r: T }>(who, sql, keys.map((k) => args[k]))).r;
};
const q = <T = any>(sql: string, params: unknown[] = []) => db.as<T>(owner, sql, params);
const creatorTotal = async (orderId: string) => Number((await q(`select coalesce(sum(l.amount_minor),0) n from commission_ledger l
  join attributions a on a.id = l.attribution_id join orders o on o.id = a.order_id
  where o.external_order_id = $1 and l.party_role = 'creator'`, [orderId]))[0].n);

beforeAll(async () => {
  db = await createDb();
  store = { role: "authenticated", userId: await createUser(db, "owner@custom.co.il") };
  creator = { role: "authenticated", userId: await createUser(db, "noa@creator.com") };
  staff = { role: "authenticated", userId: await createUser(db, "staff@custom.co.il") };
  stranger = { role: "authenticated", userId: await createUser(db, "nobody@x.com") };
  woo = { role: "authenticated", userId: await createUser(db, "owner@woo.co.il") };
  storeOrg = await rpc(store, "create_organization", { p_type: "store", p_name: "Custom Shop" });
  creatorOrg = await rpc(creator, "create_organization", { p_type: "creator", p_name: "Noa" });
  wooOrg = await rpc(woo, "create_organization", { p_type: "store", p_name: "Woo Shop" });
  await q(`insert into memberships(user_id, org_id, role) values ($1, $2, 'member')`, [(staff as any).userId, storeOrg]);
  const p = await rpc(store, "create_proposal", { p_from_org: storeOrg, p_commission_bps: 1000, p_invitee_name: "Noa", p_invitee_contact: "x" });
  const r = await rpc(creator, "accept_proposal", { p_token: p.token, p_org: creatorOrg });
  agreement = r.agreement_id; code = r.code;
}, 120_000);

describe("existing connections are untouched", () => {
  it("a WooCommerce plugin connection keeps platform/method; manual or API cannot take over a connected one", async () => {
    const k = await rpc(woo, "create_store_connection", { p_org: wooOrg, p_site_url: "woo.co.il" });
    await rpc(svc, "plugin_sync", { p_connection: k.connection_id, p_plugin_version: "0.4.1" });
    expect((await q(`select platform, method, status from store_connections where id = $1`, [k.connection_id]))[0])
      .toEqual({ platform: "woocommerce", method: "plugin", status: "connected" });
    await expect(rpc(woo, "create_api_connection", { p_org: wooOrg, p_site_url: "woo.co.il" })).rejects.toThrow(/already_connected/);
    expect(await rpc(woo, "tracking_mode", { p_store: wooOrg })).toBe("automatic");
  });
});

describe("custom site: signed API (same endpoint and ingestion as the plugin)", () => {
  let conn: string;
  it("only a store admin creates it; key shown once in the plugin's format; pending until the first signed call", async () => {
    await expect(rpc(staff, "create_api_connection", { p_org: storeOrg, p_site_url: "api.custom.co.il" })).rejects.toThrow(/forbidden/);
    await expect(rpc(stranger, "create_api_connection", { p_org: storeOrg, p_site_url: "api.custom.co.il" })).rejects.toThrow(/forbidden/);
    await expect(rpc(creator, "create_api_connection", { p_org: creatorOrg, p_site_url: "x.co.il" })).rejects.toThrow(/not_a_store/);
    await expect(rpc(store, "create_api_connection", { p_org: storeOrg, p_site_url: "not a url" })).rejects.toThrow(/invalid_url/);
    const r = await rpc(store, "create_api_connection", { p_org: storeOrg, p_site_url: "api.custom.co.il" });
    conn = r.connection_id;
    expect(r.connection_key).toMatch(/^lk_[0-9a-f]{32}_[A-Za-z0-9]{64}$/);
    expect((await q(`select platform, method, status from store_connections where id = $1`, [conn]))[0]).toEqual({ platform: "custom", method: "signed_api", status: "pending" });
    expect(await rpc(store, "tracking_mode", { p_store: storeOrg })).toBe("none");
    // Founders clock: creating a key is a technical step only – it does not start the benefit period.
    expect((await q(`select founders_until from organizations where id = $1`, [storeOrg]))[0].founders_until).toBeNull();
    const sync = await rpc(svc, "plugin_sync", { p_connection: conn, p_plugin_version: "api" });
    expect(sync.coupons.map((c: any) => c.code)).toContain(code);           // the site can create the partner coupons itself
    expect(await rpc(store, "tracking_mode", { p_store: storeOrg })).toBe("store_api");
    // …it starts when the site is really connected (first signed call).
    const fu = new Date((await q(`select founders_until from organizations where id = $1`, [storeOrg]))[0].founders_until);
    expect(fu.getTime()).toBeGreaterThan(Date.now() + 150 * 86400_000);
    // A second connection later never moves it.
    await q(`update store_connections set status = 'pending' where id = $1`, [conn]);
    await rpc(svc, "plugin_sync", { p_connection: conn, p_plugin_version: "api" });
    expect(new Date((await q(`select founders_until from organizations where id = $1`, [storeOrg]))[0].founders_until).getTime()).toBe(fu.getTime());
  });
  it("a store that already has founders terms (WooCommerce key) keeps them unchanged", async () => {
    const before = (await q(`select founders_until from organizations where id = $1`, [wooOrg]))[0].founders_until;
    expect(before).not.toBeNull();
    const k = (await q(`select id from store_connections where org_id = $1`, [wooOrg]))[0].id;
    await q(`update store_connections set status = 'pending' where id = $1`, [k]);
    await rpc(svc, "plugin_sync", { p_connection: k, p_plugin_version: "0.4.1" });
    expect((await q(`select founders_until from organizations where id = $1`, [wooOrg]))[0].founders_until).toEqual(before);
  });
  it("orders: unique per order id, duplicates ignored, refunds and cancellations reverse the commission", async () => {
    const ev = (id: string, extra: Record<string, unknown> = {}, evt = `e-${id}`) => rpc(svc, "ingest_order_event", { p_connection: conn,
      p_event: JSON.stringify({ event_id: evt, type: "order.upserted", occurred_at: new Date().toISOString(),
        order: { id, status: "completed", currency: "ILS", total: 11_800, tax: 1_800, shipping: 0, coupons: [code], created_at: new Date().toISOString(), refunds: [], ...extra } }) });
    expect((await ev("A1")).attributed).toBe(true);
    expect((await ev("A1")).status).toBe("duplicate");
    expect(await creatorTotal("A1")).toBe(1_000);
    await ev("A1", { refunds: [{ id: "r1", amount: 5_900 }] }, "e-A1-r1");
    expect(await creatorTotal("A1")).toBe(500);
    await ev("A1", { status: "cancelled" }, "e-A1-c");
    expect(await creatorTotal("A1")).toBe(0);
  });
  it("an older event arriving late (network retry) never overwrites a newer state", async () => {
    const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    const send = (evt: string, occurred: string, status: string) => rpc(svc, "ingest_order_event", { p_connection: conn,
      p_event: JSON.stringify({ event_id: evt, type: "order.upserted", occurred_at: occurred,
        order: { id: "B7", status, currency: "ILS", total: 11_800, tax: 1_800, shipping: 0, coupons: [code], created_at: at(30), refunds: [] } }) });
    await send("b7-new", at(1), "cancelled");
    await send("b7-old", at(20), "completed");      // delivered late
    expect((await q(`select status from orders where external_order_id = 'B7'`))[0].status).toBe("cancelled");
    expect(await creatorTotal("B7")).toBe(0);
  });
  it("switching to the plugin on the same address keeps the same connection, orders and commissions", async () => {
    const before = await creatorTotal("A1");
    const k = await rpc(store, "create_store_connection", { p_org: storeOrg, p_site_url: "api.custom.co.il" });
    expect(k.connection_id).toBe(conn);
    expect((await q(`select platform, method, status from store_connections where id = $1`, [conn]))[0]).toEqual({ platform: "woocommerce", method: "plugin", status: "pending" });
    expect((await q(`select count(*)::int n from orders where connection_id = $1`, [conn]))[0].n).toBeGreaterThan(0);
    expect(await creatorTotal("A1")).toBe(before);
    await rpc(svc, "plugin_sync", { p_connection: conn, p_plugin_version: "0.4.1" });
    const again = await rpc(store, "create_api_connection", { p_org: storeOrg, p_site_url: "api.custom.co.il" }).catch((e: Error) => e.message);
    expect(String(again)).toMatch(/already_connected/);           // a working plugin connection is never taken over
  });
  it("the same sale reported by two connections of one store earns one commission", async () => {
    const other = await rpc(store, "create_api_connection", { p_org: storeOrg, p_site_url: "www.api.custom.co.il" });
    await rpc(svc, "plugin_sync", { p_connection: other.connection_id, p_plugin_version: "api" });
    const now = new Date().toISOString();
    const ev = (c: string, e: string) => rpc(svc, "ingest_order_event", { p_connection: c, p_event: JSON.stringify({ event_id: e, type: "order.upserted", occurred_at: now,
      order: { id: "D9", status: "completed", currency: "ILS", total: 23_600, tax: 3_600, shipping: 0, coupons: [code], created_at: now, refunds: [] } }) });
    expect((await ev(conn, "d9-a")).attributed).toBe(true);
    expect((await ev(other.connection_id, "d9-b")).attributed).toBe(false);
    expect(await creatorTotal("D9")).toBe(2_000);
    expect((await q(`select count(*)::int n from audit_events where action = 'attribution.duplicate_skipped'`))[0].n).toBe(1);
    expect((await q(`select count(*)::int n from funnel_events where org_id is null`))[0].n).toBe(0);
  });
  it("a different order with the same number on another site of the store is still attributed", async () => {
    const other = (await q(`select id from store_connections where site_url like '%www.api.custom%'`))[0].id;
    const now = new Date().toISOString();
    const r = await rpc(svc, "ingest_order_event", { p_connection: other, p_event: JSON.stringify({ event_id: "d9-c", type: "order.upserted", occurred_at: now,
      order: { id: "D10", status: "completed", currency: "ILS", total: 5_900, tax: 900, shipping: 0, coupons: [code], created_at: now, refunds: [] } }) });
    expect(r.attributed).toBe(true);
  });
  it("manual reporting does not exist; manual connection kinds are rejected", async () => {
    await expect(rpc(store, "manual_report_order", { p_org: storeOrg })).rejects.toThrow(/does not exist/);
    await expect(q(`insert into store_connections(org_id, site_url, platform, method) values ($1, 'https://m.co.il', 'manual', 'manual')`, [storeOrg])).rejects.toThrow(/check/);
  });
  it("a tracking-only report (no order) never creates a commission", async () => {
    await expect(rpc(svc, "ingest_order_event", { p_connection: conn, p_event: JSON.stringify({ event_id: "v1", type: "visit", occurred_at: new Date().toISOString() }) }))
      .rejects.toThrow(/invalid_event/);
  });
  it("disconnecting revokes: the store shows as not tracked and further reports are refused", async () => {
    await rpc(store, "disconnect_store", { p_org: storeOrg });
    expect(await rpc(store, "tracking_mode", { p_store: storeOrg })).toBe("none");
    await expect(rpc(svc, "ingest_order_event", { p_connection: (await q(`select id from store_connections where org_id = $1 limit 1`, [storeOrg]))[0].id,
      p_event: JSON.stringify({ event_id: "after-disconnect", type: "order.upserted", occurred_at: new Date().toISOString(), order: { id: "Z1" } }) })).rejects.toThrow(/connection_disconnected/);
  });
});

describe("sale claims (missing or wrong sales)", () => {
  let claim: string;
  it("the creator opens a claim; the store is notified; others cannot", async () => {
    await expect(rpc(stranger, "open_sale_claim", { p_agreement: agreement, p_order_ref: "1050", p_order_date: "2026-11-09", p_amount_minor: 30_000, p_note: "" })).rejects.toThrow(/forbidden/);
    await expect(rpc(store, "open_sale_claim", { p_agreement: agreement, p_order_ref: "1050", p_order_date: null, p_amount_minor: null, p_note: "" })).rejects.toThrow(/forbidden/);
    claim = await rpc(creator, "open_sale_claim", { p_agreement: agreement, p_order_ref: "1050", p_order_date: "2026-11-09", p_amount_minor: 30_000, p_note: "Used my coupon" });
    expect((await q(`select kind from notifications where org_id = $1 and kind = 'sale_claim_opened'`, [storeOrg])).length).toBe(1);
    expect((await rpc(store, "sale_claims_for", { p_org: storeOrg }))[0]).toMatchObject({ order_ref: "1050", status: "open", mine_as: "store", creator: "Noa" });
    expect((await rpc(creator, "sale_claims_for", { p_org: creatorOrg }))[0]).toMatchObject({ mine_as: "creator", store: "Custom Shop" });
    await expect(rpc(stranger, "sale_claims_for", { p_org: storeOrg })).rejects.toThrow(/forbidden/);
  });
  it("only the store answers; a rejection needs a reason; answered once; the creator is notified", async () => {
    await expect(rpc(creator, "answer_sale_claim", { p_claim: claim, p_status: "accepted", p_response: "" })).rejects.toThrow(/forbidden/);
    await expect(rpc(store, "answer_sale_claim", { p_claim: claim, p_status: "rejected", p_response: "" })).rejects.toThrow(/reason_required/);
    await rpc(store, "answer_sale_claim", { p_claim: claim, p_status: "rejected", p_response: "Order 1050 was paid without the coupon" });
    await expect(rpc(store, "answer_sale_claim", { p_claim: claim, p_status: "accepted", p_response: "" })).rejects.toThrow(/already_decided/);
    expect((await q(`select kind from notifications where org_id = $1 and kind = 'sale_claim_answered'`, [creatorOrg])).length).toBe(1);
    expect((await q(`select count(*)::int n from commission_ledger`))[0].n).toBeGreaterThan(0);   // claims never touch the ledger directly
  });
  it("claims are not readable directly from the table", async () => {
    await expect(db.as(creator, `select * from public.sale_claims`)).rejects.toThrow(/permission denied/);
  });
});

describe("creator view", () => {
  it("lists partner stores with how their sales are tracked; members only", async () => {
    const r = await rpc(creator, "my_partner_stores", { p_creator: creatorOrg });
    expect(r).toEqual([{ agreement_id: agreement, store_org_id: storeOrg, store_name: "Custom Shop", tracking: "none" }]);
    await expect(rpc(stranger, "my_partner_stores", { p_creator: creatorOrg })).rejects.toThrow(/forbidden/);
  });
});

describe("prepared adapters feed the same engine (no change to fees or ledger)", () => {
  it("a Shopify-mapped and a Wix-mapped order create the same commission as any other order", async () => {
    const sh = (await q(`insert into store_connections(org_id, site_url, platform, method, status) values ($1, 'https://shop.myshopify.com', 'shopify', 'app', 'connected') returning id`, [storeOrg]))[0].id;
    const wx = (await q(`insert into store_connections(org_id, site_url, platform, method, status) values ($1, 'https://shop.wixsite.com', 'wix', 'app', 'connected') returning id`, [storeOrg]))[0].id;
    const now = new Date().toISOString();
    const e1 = shopifyOrderToEvent({ id: 7001, currency: "ILS", total_price: "118.00", total_tax: "18.00", discount_codes: [{ code }], financial_status: "paid", created_at: now, updated_at: now })!;
    const e2 = wixOrderToEvent({ id: "w1", number: "9001", currency: "ILS", status: "APPROVED", paymentStatus: "PAID", priceSummary: { total: { amount: "118" }, tax: { amount: "18" } }, appliedDiscounts: [{ coupon: { code } }], createdDate: now, updatedDate: now })!;
    expect((await rpc(svc, "ingest_order_event", { p_connection: sh, p_event: JSON.stringify(e1) })).attributed).toBe(true);
    expect((await rpc(svc, "ingest_order_event", { p_connection: wx, p_event: JSON.stringify(e2) })).attributed).toBe(true);
    expect(await creatorTotal("7001")).toBe(1_000);
    expect(await creatorTotal("9001")).toBe(1_000);
    expect((await rpc(svc, "ingest_order_event", { p_connection: sh, p_event: JSON.stringify(e1) })).status).toBe("duplicate");
  });
});

describe("safe rollback", () => {
  it("the rollback script applies cleanly on a database that does not use the new kinds, and WooCommerce keys still work", async () => {
    const fresh = await createDb();
    const { readFileSync } = await import("node:fs");
    const down = readFileSync(new URL("../../../../supabase/rollback/20261111101700.down.sql", import.meta.url), "utf8");
    await fresh.exec(down);
    const u = { role: "authenticated", userId: await createUser(fresh, "rb@x.co.il") } as Who;
    const org = (await fresh.one<{ r: string }>(u, `select public.create_organization(p_type => 'store', p_name => 'RB') as r`)).r;
    const k = (await fresh.one<{ r: any }>(u, `select public.create_store_connection(p_org => $1, p_site_url => 'rb.co.il') as r`, [org])).r;
    expect(k.connection_key).toMatch(/^lk_/);
    await expect(fresh.as(owner, `insert into store_connections(org_id, site_url, platform, method) values ($1, 'https://c.co.il', 'custom', 'signed_api')`, [org])).rejects.toThrow(/check/);
  }, 120_000);
});
