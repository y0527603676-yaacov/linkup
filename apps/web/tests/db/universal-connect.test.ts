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
    for (const kind of ["manual", "custom"])
      await expect(rpc(woo, "create_platform_connection", { p_org: wooOrg, p_site_url: "woo.co.il", p_kind: kind })).rejects.toThrow(/already_connected/);
    expect(await rpc(woo, "tracking_mode", { p_store: wooOrg })).toBe("automatic");
  });
});

describe("custom site: signed API (same endpoint and ingestion as the plugin)", () => {
  let conn: string;
  it("only a store admin creates it; key shown once in the plugin's format; pending until the first signed call", async () => {
    await expect(rpc(staff, "create_platform_connection", { p_org: storeOrg, p_site_url: "api.custom.co.il", p_kind: "custom" })).rejects.toThrow(/forbidden/);
    await expect(rpc(stranger, "create_platform_connection", { p_org: storeOrg, p_site_url: "api.custom.co.il", p_kind: "custom" })).rejects.toThrow(/forbidden/);
    await expect(rpc(creator, "create_platform_connection", { p_org: creatorOrg, p_site_url: "x.co.il", p_kind: "custom" })).rejects.toThrow(/not_a_store/);
    await expect(rpc(store, "create_platform_connection", { p_org: storeOrg, p_site_url: "api.custom.co.il", p_kind: "magic" })).rejects.toThrow(/invalid_input/);
    const r = await rpc(store, "create_platform_connection", { p_org: storeOrg, p_site_url: "api.custom.co.il", p_kind: "custom" });
    conn = r.connection_id;
    expect(r.connection_key).toMatch(/^lk_[0-9a-f]{32}_[A-Za-z0-9]{64}$/);
    expect((await q(`select platform, method, status from store_connections where id = $1`, [conn]))[0]).toEqual({ platform: "custom", method: "signed_api", status: "pending" });
    expect(await rpc(store, "tracking_mode", { p_store: storeOrg })).toBe("none");
    const sync = await rpc(svc, "plugin_sync", { p_connection: conn, p_plugin_version: "api" });
    expect(sync.coupons.map((c: any) => c.code)).toContain(code);           // the site can create the partner coupons itself
    expect(await rpc(store, "tracking_mode", { p_store: storeOrg })).toBe("store_api");
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
  it("a tracking-only report (no order) never creates a commission", async () => {
    await expect(rpc(svc, "ingest_order_event", { p_connection: conn, p_event: JSON.stringify({ event_id: "v1", type: "visit", occurred_at: new Date().toISOString() }) }))
      .rejects.toThrow(/invalid_event/);
  });
});

describe("manual coupon mode", () => {
  it("connected at once; labelled 'manual'; only admins report; only this store's partner coupons", async () => {
    await expect(rpc(store, "manual_report_order", { p_org: storeOrg, p_order_id: "1001", p_order_date: TODAY, p_total_minor: 23_600, p_shipping_minor: 0, p_coupon: code }))
      .rejects.toThrow(/not_available/);
    await rpc(store, "create_platform_connection", { p_org: storeOrg, p_site_url: "custom.co.il", p_kind: "manual" });
    expect(await rpc(store, "store_tracking_modes", { p_stores: `{${storeOrg},${wooOrg}}` })).toEqual({ [storeOrg]: "store_api", [wooOrg]: "automatic" });
    await expect(rpc(staff, "manual_report_order", { p_org: storeOrg, p_order_id: "1001", p_order_date: TODAY, p_total_minor: 23_600, p_shipping_minor: 0, p_coupon: code })).rejects.toThrow(/forbidden/);
    await expect(rpc(stranger, "manual_report_order", { p_org: storeOrg, p_order_id: "1001", p_order_date: TODAY, p_total_minor: 23_600, p_shipping_minor: 0, p_coupon: code })).rejects.toThrow(/forbidden/);
    await expect(rpc(store, "manual_report_order", { p_org: storeOrg, p_order_id: "1001", p_order_date: TODAY, p_total_minor: 23_600, p_shipping_minor: 0, p_coupon: "NOTMINE" })).rejects.toThrow(/bad_code/);
    await expect(rpc(store, "manual_report_order", { p_org: storeOrg, p_order_id: "1001", p_order_date: "2099-01-01", p_total_minor: 23_600, p_shipping_minor: 0, p_coupon: code })).rejects.toThrow(/invalid_dates/);
    await expect(rpc(store, "manual_report_order", { p_org: storeOrg, p_order_id: "1001", p_order_date: TODAY, p_total_minor: 0, p_shipping_minor: 0, p_coupon: code })).rejects.toThrow(/invalid_amount/);
  });
  it("a reported order goes through the normal engine (implied VAT, refund window), once per order id", async () => {
    const r = await rpc(store, "manual_report_order", { p_org: storeOrg, p_order_id: "1001", p_order_date: TODAY, p_total_minor: 24_600, p_shipping_minor: 1_000, p_coupon: code.toLowerCase() });
    expect(r.attributed).toBe(true);
    expect(await creatorTotal("1001")).toBe(2_000);                           // (246 − 10) / 1.18 = 200 → 10%
    expect((await q(`select state from commission_ledger l join attributions a on a.id = l.attribution_id join orders o on o.id = a.order_id where o.external_order_id = '1001' limit 1`))[0].state).toBe("pending");
    await expect(rpc(store, "manual_report_order", { p_org: storeOrg, p_order_id: "1001", p_order_date: TODAY, p_total_minor: 24_600, p_shipping_minor: 1_000, p_coupon: code })).rejects.toThrow(/order_exists/);
    const list = await rpc(store, "manual_orders", { p_org: storeOrg });
    expect(list[0]).toMatchObject({ id: "1001", status: "completed", commission_minor: 2_000, creator: "Noa" });
    expect((await q(`select count(*)::int n from audit_events where action = 'manual_sale.reported' and target = '1001'`))[0].n).toBe(1);
  });
  it("partial refund, then cancellation; never more than was paid; others cannot touch it", async () => {
    await expect(rpc(store, "manual_update_order", { p_org: storeOrg, p_order_id: "1001", p_action: "refunded", p_amount_minor: 99_999 })).rejects.toThrow(/invalid_amount/);
    await expect(rpc(staff, "manual_update_order", { p_org: storeOrg, p_order_id: "1001", p_action: "cancelled" })).rejects.toThrow(/forbidden/);
    await expect(rpc(woo, "manual_update_order", { p_org: storeOrg, p_order_id: "1001", p_action: "cancelled" })).rejects.toThrow(/forbidden/);
    await rpc(store, "manual_update_order", { p_org: storeOrg, p_order_id: "1001", p_action: "refunded", p_amount_minor: 11_800 });
    expect(await creatorTotal("1001")).toBe(1_041);          // refunds reduce proportionally (same rule as WooCommerce)
    await rpc(store, "manual_update_order", { p_org: storeOrg, p_order_id: "1001", p_action: "cancelled" });
    expect(await creatorTotal("1001")).toBe(0);
    await expect(rpc(store, "manual_update_order", { p_org: storeOrg, p_order_id: "nope", p_action: "cancelled" })).rejects.toThrow(/not_found/);
  });
  it("issuing a plugin key for the same address turns it back into a WooCommerce plugin connection", async () => {
    await rpc(store, "create_platform_connection", { p_org: storeOrg, p_site_url: "switch.co.il", p_kind: "manual" });
    const k = await rpc(store, "create_store_connection", { p_org: storeOrg, p_site_url: "switch.co.il" });
    expect((await q(`select platform, method from store_connections where id = $1`, [k.connection_id]))[0]).toEqual({ platform: "woocommerce", method: "plugin" });
    expect((await q(`select status from store_connections where id = $1`, [k.connection_id]))[0].status).toBe("pending");   // connected only after the plugin reports
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
    expect(r).toEqual([{ agreement_id: agreement, store_org_id: storeOrg, store_name: "Custom Shop", tracking: "store_api" }]);
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
