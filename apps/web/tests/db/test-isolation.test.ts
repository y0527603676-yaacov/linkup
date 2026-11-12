import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";
import * as core from "../../../../supabase/functions/apps/core";

/**
 * Test activities (organizations.is_test) behave exactly like real ones for orders and commissions, but their
 * amounts can never become billable or payable, and never appear in platform-wide financial reports.
 * Also: partial refunds after a coupon discount use the money really refunded; coupon beats link; one creator per order.
 */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const u: Record<string, Who> = {};
const org: Record<string, string> = {};
let connT = "", connR = "", codeA = "", codeB = "", codeR = "";
const rpc = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  return (await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]))).r;
};
const q = <T = any>(sql: string, p: unknown[] = []) => db.as<T>(owner, sql, p);
const num = async (sql: string, p: unknown[] = []) => Number((await q<{ n: string }>(sql, p))[0]!.n);
let seq = 0;
const ev = (c: string, o: Record<string, unknown>) =>
  rpc(svc, "ingest_order_event", { p_connection: c, p_event: JSON.stringify({ event_id: `t-${++seq}`, occurred_at: new Date(Date.now() + seq * 1000).toISOString(),
    order: { status: "processing", currency: "USD", tax: 0, shipping: 0, shipping_tax: 0, coupons: [], created_at: new Date().toISOString(), refunds: [], ...o } }) });
const led = (role: string, ext: string) => num(`select coalesce(sum(l.amount_minor),0) n from commission_ledger l join attributions a on a.id = l.attribution_id
  join orders o on o.id = a.order_id where l.party_role = $1 and o.external_order_id = $2`, [role, ext]);
const who = async (ext: string) => q(`select a.method, a.creator_org_id from attributions a join orders o on o.id = a.order_id where o.external_order_id = $1`, [ext]);
const ref = (c: string) => `${c}|${Math.floor(Date.now() / 1000) - 60}`;
const agree = async (store: string, storeUser: Who, creatorUser: Who, creator: string, bps: number, pct: number) => {
  const p = await rpc(storeUser, "create_proposal", { p_from_org: store, p_commission_bps: bps, p_invitee_name: "x", p_invitee_contact: "x", p_coupon_discount_pct: pct });
  return (await rpc(creatorUser, "accept_proposal", { p_token: p.token, p_org: creator })).code as string;
};

beforeAll(async () => {
  db = await createDb();
  for (const k of ["t", "a", "b", "r", "rc", "admin"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@iso.test`) };
  await q(`insert into platform_admins(user_id) values ($1)`, [(u.admin as any).userId]);
  org.T = await rpc(u.t!, "create_organization", { p_type: "store", p_name: "Test Store" });
  org.A = await rpc(u.a!, "create_organization", { p_type: "creator", p_name: "TESTA" });
  org.B = await rpc(u.b!, "create_organization", { p_type: "creator", p_name: "TESTB" });
  org.R = await rpc(u.r!, "create_organization", { p_type: "store", p_name: "Real Store" });
  org.RC = await rpc(u.rc!, "create_organization", { p_type: "creator", p_name: "Real Creator" });
  connT = (await rpc(u.t!, "create_store_connection", { p_org: org.T, p_site_url: "test-store.co.il" })).connection_id;
  connR = (await rpc(u.r!, "create_store_connection", { p_org: org.R, p_site_url: "real-store.co.il" })).connection_id;
  await rpc(svc, "plugin_sync", { p_connection: connT, p_plugin_version: "0.3.0" });
  await rpc(svc, "plugin_sync", { p_connection: connR, p_plugin_version: "0.3.0" });
  codeA = await agree(org.T, u.t!, u.a!, org.A, 1000, 0);    // A: 10%, no discount
  codeB = await agree(org.T, u.t!, u.b!, org.B, 1500, 10);   // B: 15%, coupon 10%
  codeR = await agree(org.R, u.r!, u.rc!, org.RC, 1000, 0);
  await q(`update organizations set is_test = true where id = any($1)`, [[org.T, org.A, org.B]]);
}, 90_000);

describe("Shopify order data: discounts and refunds are the real amounts", () => {
  it("total is after the coupon discount; a partial refund is the money actually refunded (successful refund transactions only)", () => {
    const n = core.shopifyOrder({ id: 1, currency: "USD", total_price: "90.00", subtotal_price: "90.00", total_discounts: "10.00", total_tax: "0.00",
      financial_status: "partially_refunded", discount_codes: [{ code: "TESTB1234", amount: "10.00" }],
      refunds: [{ id: 5, transactions: [{ kind: "refund", status: "success", amount: "30.00" }, { kind: "refund", status: "failure", amount: "30.00" }] }] })!;
    expect(n).toMatchObject({ total: 9_000, coupons: ["TESTB1234"], refunds: [{ id: "5", amount: 3_000 }], status: "processing" });
  });
});

describe("commission engine on a test activity (same as real)", () => {
  it("link only (A) → 10% of 100.00", async () => {
    await ev(connT, { id: "1", total: 10_000, ref: ref(codeA) });
    expect(await who("1")).toEqual([{ method: "link", creator_org_id: org.A }]);
    expect(await led("creator", "1")).toBe(1_000);
  });
  it("coupon of B (after 10% discount, total 90.00) → 15% = 13.50", async () => {
    await ev(connT, { id: "2", total: 9_000, coupons: [codeB] });
    expect(await who("2")).toEqual([{ method: "coupon", creator_org_id: org.B }]);
    expect(await led("creator", "2")).toBe(1_350);
  });
  it("A's link AND B's coupon on one order → only B (coupon wins), one attribution, no commission for A", async () => {
    await ev(connT, { id: "3", total: 9_000, coupons: [codeB], ref: ref(codeA) });
    await ev(connT, { id: "3", total: 9_000, coupons: [codeB], ref: ref(codeA) });   // later event for the same order
    expect(await who("3")).toEqual([{ method: "coupon", creator_org_id: org.B }]);
    expect(await led("creator", "3")).toBe(1_350);
    expect(await num(`select count(*) n from commission_ledger l join attributions a on a.id = l.attribution_id join orders o on o.id = a.order_id
      where o.external_order_id = '3' and l.party_org_id = $1`, [org.A])).toBe(0);
  });
  it("an inactive coupon does not win: the link stays the valid source", async () => {
    await q(`update partner_codes set active = false where code = $1`, [codeB]);
    await ev(connT, { id: "4", total: 10_000, coupons: [codeB], ref: ref(codeA) });
    expect(await who("4")).toEqual([{ method: "link", creator_org_id: org.A }]);
    await q(`update partner_codes set active = true where code = $1`, [codeB]);
  });
  it("partial refund of 30.00 on the 90.00 coupon order → commission on 60.00 = 9.00; full refund → 0", async () => {
    await ev(connT, { id: "2", total: 9_000, coupons: [codeB], refunds: [{ id: "r1", amount: 3_000 }] });
    expect(await led("creator", "2")).toBe(900);
    await ev(connT, { id: "2", status: "refunded", total: 9_000, coupons: [codeB], refunds: [{ id: "r1", amount: 3_000 }, { id: "r2", amount: 6_000 }] });
    expect(await led("creator", "2")).toBe(0);
    expect(await led("platform", "2")).toBe(0);
  });
  it("cancellation → 0", async () => {
    await ev(connT, { id: "3", status: "cancelled", total: 9_000, coupons: [codeB] });
    expect(await led("creator", "3")).toBe(0);
  });
});

describe("test amounts never become billable, payable or reported", () => {
  it("approval skips test activities but still approves real ones in the same run", async () => {
    await ev(connR, { id: "R1", total: 10_000, ref: ref(codeR) });
    await ev(connT, { id: "5", total: 10_000, ref: ref(codeA) });
    await q(`update orders set status = 'completed', completed_at = now() - interval '60 days' where external_order_id in ('R1', '5', '1')`);
    await rpc(svc, "approve_matured_commissions");
    expect(await num(`select count(*) n from commission_ledger where store_org_id = $1 and state = 'approved'`, [org.R])).toBe(2);
    expect(await num(`select count(*) n from commission_ledger where store_org_id = $1 and state <> 'pending'`, [org.T])).toBe(0);
  });
  it("no path can approve a test row", async () => {
    await expect(q(`update commission_ledger set state = 'approved', approved_at = now() where store_org_id = $1`, [org.T])).rejects.toThrow(/test_data_not_billable/);
  });
  it("real-money tables refuse test activities", async () => {
    await expect(q(`insert into invoices(store_org_id, period_start, currency, fees_minor, total_minor, status) values ($1, '2026-10-01', 'USD', 100, 100, 'issued')`, [org.T]))
      .rejects.toThrow(/test_data_not_billable/);
    await expect(q(`insert into reward_payouts(org_id, currency, amount_minor, method) values ($1, 'USD', 100, 'bank_transfer')`, [org.A]))
      .rejects.toThrow(/test_data_not_billable/);
    await expect(rpc(u.t!, "report_creator_payment", { p_store: org.T, p_creator: org.A, p_amount_minor: 1000, p_vat_minor: 0, p_method: "bank_transfer",
      p_paid_on: new Date().toISOString().slice(0, 10), p_reference: "x", p_idempotency_key: "k1", p_currency: "USD", p_withholding_minor: 0, p_withholding_ref: null }))
      .rejects.toThrow(/test_data_not_billable|nothing_to_pay/);   // nothing is ever due on a test pair
  });
  it("platform reports leave test activities out", async () => {
    const f = await rpc(owner, "platform_fee_report", { p_from: "2000-01-01", p_to: "2100-01-01" });
    expect(f.map((x: any) => x.store_org_id)).toEqual([org.R]);
    const o = await rpc(u.admin!, "admin_overview");
    const real = await num(`select coalesce(sum(amount_minor),0) n from commission_ledger where party_role = 'platform' and state = 'pending' and store_org_id = $1`, [org.R]);
    expect(Number(o.platform_fees_pending_minor)).toBe(real);
    expect(Number(o.attributed_sales_30d)).toBe(1);
    const d = await rpc(u.admin!, "finance_dashboard");
    expect(Number(d.fees_pending_minor)).toBe(real);
    expect(Number(d.creator_outstanding_minor)).toBe(await num(`select coalesce(sum(amount_minor),0) n from commission_ledger where party_role = 'creator' and state = 'approved'`));
  });
  it("a test activity with sales cannot be switched back to real", async () => {
    await expect(q(`update organizations set is_test = false where id = $1`, [org.T])).rejects.toThrow(/test_activity_has_sales/);
    await expect(q(`update organizations set is_test = false where id = $1`, [org.A])).rejects.toThrow(/test_activity_has_sales/);
  });
  it("the test activity still sees its own figures on its own screen", async () => {
    const b = await rpc(owner, "creator_pair_balance", { p_store: org.T, p_creator: org.A, p_currency: "USD" });
    expect(Number(b.pending_minor)).toBeGreaterThan(0);
    expect(Number(b.outstanding_minor)).toBe(0);
  });
});
