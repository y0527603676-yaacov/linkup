import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";

/**
 * One end-to-end money scenario with exact amounts (minor units, ILS):
 * sale → creator commission → LINKUP fee → approval → payment request → collected → referral rewards
 * (two different referrers) → partial refund / cancellation / full refund after payment → reward reversal
 * → wallet offset on the referrer-store's own bill → every "pay twice" path refused.
 */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const u: Record<string, Who> = {};
const org: Record<string, string> = {};
let conn = "", connRS = "", code = "", codeRS = "";

const rpc = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  const row = await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
  return row.r;
};
const q = <T = any>(sql: string, p: unknown[] = []) => db.as<T>(owner, sql, p);
const num = async (sql: string, p: unknown[] = []) => Number((await q<{ n: string }>(sql, p))[0]!.n);
const backdate = (sql: string, p: unknown[] = []) =>
  db.transaction(async (tx) => { await tx.exec(`set local session_replication_role = replica`); await tx.query(sql, p); });
let seq = 0;
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const ev = (c: string, o: Record<string, unknown>, occurred = new Date(Date.now() + ++seq).toISOString()) =>
  rpc(svc, "ingest_order_event", { p_connection: c, p_event: JSON.stringify({ event_id: `m-${++seq}`, occurred_at: occurred,
    order: { status: "completed", currency: "ILS", tax: 0, shipping: 0, shipping_tax: 0, coupons: [], created_at: new Date().toISOString(), refunds: [], ...o } }) });
const month = (back: number) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1)).toISOString().slice(0, 10); };
const ledger = (role: string, ext?: string) => num(
  `select coalesce(sum(l.amount_minor),0) as n from commission_ledger l join attributions a on a.id = l.attribution_id join orders o on o.id = a.order_id
    where l.party_role = $1 ${ext ? "and o.external_order_id = $2" : ""}`, ext ? [role, ext] : [role]);
const rewards = (orgId: string) => num(`select coalesce(sum(amount_minor),0) as n from referral_rewards where referrer_org_id = $1`, [orgId]);

beforeAll(async () => {
  db = await createDb();
  for (const k of ["rs", "rc", "s", "c", "admin"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@money.test`) };
  await q(`insert into platform_admins(user_id) values ($1)`, [(u.admin as any).userId]);
  await q(`update app_settings set value = 'true' where key = 'invoicing_tax_approved'`);
  await q(`update app_settings set value = 'true' where key = 'reward_settlement_approved'`); // as if the accountant had approved settlement
  org.RS = await rpc(u.rs!, "create_organization", { p_type: "store", p_name: "Referrer Store" });
  org.RC = await rpc(u.rc!, "create_organization", { p_type: "creator", p_name: "Referrer Creator" });
  const rc = async (o: string) => (await q<{ c: string }>(`select referral_code c from organizations where id=$1`, [o]))[0]!.c;
  org.S = await rpc(u.s!, "create_organization", { p_type: "store", p_name: "Shop", p_ref_code: await rc(org.RC) });
  org.C = await rpc(u.c!, "create_organization", { p_type: "creator", p_name: "Creator", p_ref_code: await rc(org.RS) });
  conn = (await rpc(u.s!, "create_store_connection", { p_org: org.S, p_site_url: "shop.co.il" })).connection_id;
  await rpc(svc, "plugin_sync", { p_connection: conn, p_plugin_version: "0.3.0" });
  const opp = await rpc(u.s!, "save_standing_opportunity", { p_store: org.S, p_title: "Shop", p_description: null,
    p_commission_bps: 1000, p_coupon_pct: 10, p_auto_approve: true, p_status: "live" });
  code = (await rpc(u.c!, "join_opportunity", { p_opportunity: opp, p_creator: org.C })).code;
}, 60_000);

describe("money paths, exact amounts", () => {
  it("sale → creator commission 10% and LINKUP fee 2% on the net base (VAT excluded), never deducted from the creator", async () => {
    await ev(conn, { id: "1", total: 11_800, tax: 1_800, coupons: [code] }, ago(20));            // base 10 000
    await ev(conn, { id: "2", total: 23_600, tax: 3_600, coupons: [code] }, ago(20));            // base 20 000
    expect(await ledger("creator", "1")).toBe(1_000);
    expect(await ledger("platform", "1")).toBe(200);
    expect(await ledger("creator", "2")).toBe(2_000);
    expect(await ledger("platform", "2")).toBe(400);
  });
  it("partial refund reduces both proportionally; cancellation zeroes the order", async () => {
    await ev(conn, { id: "2", total: 23_600, tax: 3_600, coupons: [code], refunds: [{ id: "r2", amount: 5_900 }] }, ago(19));
    expect(await ledger("creator", "2")).toBe(1_500);
    expect(await ledger("platform", "2")).toBe(300);
    await ev(conn, { id: "3", status: "processing", total: 11_800, tax: 1_800, coupons: [code] });
    await ev(conn, { id: "3", status: "cancelled", total: 11_800, tax: 1_800, coupons: [code] });
    expect(await ledger("creator", "3")).toBe(0);
    expect(await ledger("platform", "3")).toBe(0);
  });
  it("approval after the refund window; one payment request; generating twice never duplicates", async () => {
    await rpc(svc, "approve_matured_commissions");
    await backdate(`update commission_ledger set approved_at = $1 where state = 'approved'`, [`${month(2)}T12:00:00Z`]);
    expect(await rpc(u.admin!, "generate_invoices", { p_period_start: month(2) })).toBe(1);
    expect(await rpc(u.admin!, "generate_invoices", { p_period_start: month(2) })).toBe(0);
    const inv = (await q(`select * from invoices where store_org_id = $1`, [org.S]))[0];
    expect(Number(inv.fees_minor)).toBe(500);        // 200 + 300; cancelled order contributes nothing
    expect(Number(inv.vat_minor)).toBe(90);          // 18% VAT on the LINKUP fee
    expect(Number(inv.total_minor)).toBe(590);
    await expect(rpc(u.s!, "generate_invoices", { p_period_start: month(2) })).rejects.toThrow(/forbidden/);
  });
  it("no reward before collection; after payment, two referrers get 20% each (40% total)", async () => {
    expect(await rewards(org.RC) + await rewards(org.RS)).toBe(0);
    const inv = (await q(`select id from invoices where store_org_id = $1`, [org.S]))[0]!.id;
    await rpc(u.admin!, "mark_invoice_paid", { p_invoice: inv, p_reference: "GROW-1" });
    await expect(rpc(u.admin!, "mark_invoice_paid", { p_invoice: inv, p_reference: "GROW-1" })).rejects.toThrow(/invoice_not_payable/);
    await expect(rpc(u.admin!, "void_invoice", { p_invoice: inv })).rejects.toThrow(/invoice_not_voidable/);
    expect(await rewards(org.RC)).toBe(100);         // store-side referrer: 20% of 500
    expect(await rewards(org.RS)).toBe(100);         // creator-side referrer: 20% of 500
    expect(await num(`select public.settle_invoice_rewards($1) as n`, [inv])).toBe(0);
  });
  it("store pays the creator once; a second payout is refused", async () => {
    const p = await rpc(u.s!, "record_creator_payout", { p_store: org.S, p_creator: org.C, p_method: "bank_transfer", p_reference: "TR-1" });
    expect(p.amount_minor).toBe(2_500);              // 1 000 + 1 500
    await expect(rpc(u.s!, "record_creator_payout", { p_store: org.S, p_creator: org.C, p_method: "bank_transfer", p_reference: "TR-2" }))
      .rejects.toThrow(/nothing_to_pay/);
  });
  it("full refund after everything was paid: fee and creator lines reverse; rewards reverse immediately", async () => {
    await ev(conn, { id: "1", status: "refunded", total: 11_800, tax: 1_800, coupons: [code], refunds: [{ id: "r1", amount: 11_800 }] });
    expect(await ledger("creator", "1")).toBe(0);
    expect(await ledger("platform", "1")).toBe(0);
    await rpc(svc, "approve_matured_commissions");
    expect(await rewards(org.RC)).toBe(60);          // 100 − 40
    expect(await rewards(org.RS)).toBe(60);
    // The creator was already paid for order 1: the store now sees a negative balance (owed back / offset next time).
    const bal = (await rpc(u.s!, "payout_balances", { p_org: org.S })).find((b: any) => b.other_org_id === org.C);
    expect(Number(bal.approved_unpaid_minor)).toBe(-1_000);
    await expect(rpc(u.s!, "record_creator_payout", { p_store: org.S, p_creator: org.C, p_method: "bank_transfer", p_reference: "x" }))
      .rejects.toThrow(/nothing_to_pay/);
  });
  it("reversal reaches the next bill without a second reward reversal", async () => {
    await ev(conn, { id: "4", total: 59_000, tax: 9_000, coupons: [code] }, ago(20));            // base 50 000 → fee 1 000
    await rpc(svc, "approve_matured_commissions");
    await backdate(`update commission_ledger set approved_at = $1 where state = 'approved' and approved_at > $2`, [`${month(1)}T12:00:00Z`, `${month(1)}T00:00:00Z`]);
    await rpc(u.admin!, "generate_invoices", { p_period_start: month(1) });
    const inv = (await q(`select * from invoices where store_org_id = $1 and period_start = $2`, [org.S, month(1)]))[0];
    expect(Number(inv.fees_minor)).toBe(800);        // 1 000 − 200 (order 1 refunded)
    await rpc(u.admin!, "mark_invoice_paid", { p_invoice: inv.id, p_reference: "GROW-2" });
    expect(await rewards(org.RC)).toBe(260);         // 60 + 20% of 1 000; the −200 line was already reversed
    expect(await rewards(org.RS)).toBe(260);
    const total = await num(`select sum(amount_minor) as n from referral_rewards`);
    const collected = await num(`select sum(ii.amount_minor) as n from invoice_items ii join invoices i on i.id = ii.invoice_id where i.status = 'paid'`);
    expect(total).toBe(520);
    expect(total).toBeLessThanOrEqual(Math.floor(collected * 0.4));
  });
  it("a referrer that is a store gets its balance offset on its own bill, once", async () => {
    connRS = (await rpc(u.rs!, "create_store_connection", { p_org: org.RS, p_site_url: "refstore.co.il" })).connection_id;
    await rpc(svc, "plugin_sync", { p_connection: connRS, p_plugin_version: "0.3.0" });
    const opp = await rpc(u.rs!, "save_standing_opportunity", { p_store: org.RS, p_title: "RS", p_description: null,
      p_commission_bps: 1000, p_coupon_pct: 10, p_auto_approve: true, p_status: "live" });
    codeRS = (await rpc(u.c!, "join_opportunity", { p_opportunity: opp, p_creator: org.C })).code;
    await ev(connRS, { id: "rs-1", total: 118_000, tax: 18_000, coupons: [codeRS] }, ago(20));  // base 100 000 → fee 2 000
    await rpc(svc, "approve_matured_commissions");
    await backdate(`update commission_ledger set approved_at = $1 where state = 'approved' and store_org_id = $2`, [`${month(1)}T12:00:00Z`, org.RS]);
    await rpc(u.rs!, "save_tax_profile", { p_org: org.RS, p_legal_name: "Ref Store Ltd", p_classification: "company",
      p_tax_id: "515555555", p_address: "Haifa", p_country: "IL" });
    await rpc(u.admin!, "verify_tax_profile", { p_org: org.RS, p_zero_rate: false });
    await rpc(u.admin!, "generate_invoices", { p_period_start: month(1) });
    const inv = (await q(`select * from invoices where store_org_id = $1`, [org.RS]))[0];
    // fee 2 000 + VAT 360 (on the full fee) − offset 307 (reward 260 + VAT 47 on the reward) = 2 053
    expect([Number(inv.fees_minor), Number(inv.vat_minor), Number(inv.reward_offset_minor), Number(inv.reward_vat_minor),
            Number(inv.credit_minor), Number(inv.total_minor)]).toEqual([2_000, 360, 260, 47, 307, 2_053]);
    expect((await rpc(u.rs!, "my_wallet")).activities.find((a: any) => a.org_id === org.RS).balance_minor).toBe(0);
    // Referrer RS is a party to the RS↔C deal: it earns nothing on its own sale.
    expect(await rewards(org.RS)).toBe(260);
  });
  it("reward transfer: only above the minimum, with a verified profile and the referrer's document, never twice", async () => {
    const tr = (ref: string, n = "77") => rpc(u.admin!, "record_reward_transfer", { p_org: org.RC, p_currency: "ILS", p_reference: ref,
      p_doc_type: "exempt_invoice_receipt", p_doc_number: n, p_doc_date: null });
    await expect(tr("x")).rejects.toThrow(/below_minimum/);
    await backdate(`update app_settings set value = '100' where key = 'reward_transfer_min_minor'`);
    await expect(tr("BANK-1")).rejects.toThrow(/tax_profile_required/);
    await rpc(u.rc!, "save_tax_profile", { p_org: org.RC, p_legal_name: "Ref Creator", p_classification: "exempt_dealer",
      p_tax_id: "301234567", p_address: "Jerusalem", p_country: "IL" });
    await expect(tr("BANK-1")).rejects.toThrow(/tax_profile_required/);       // not verified yet
    await rpc(u.admin!, "verify_tax_profile", { p_org: org.RC, p_zero_rate: false });
    await expect(tr("BANK-1", " ")).rejects.toThrow(/document_required/);
    expect(await tr("BANK-1")).toBe(260);                                     // exempt dealer: no VAT added
    const doc = await q(`select issuer, doc_type, doc_number, amount_minor::int as a, vat_minor::int as v from accounting_documents where org_id = $1`, [org.RC]);
    expect(doc).toEqual([{ issuer: "counterparty", doc_type: "exempt_invoice_receipt", doc_number: "77", a: 260, v: 0 }]);
    await expect(tr("BANK-2")).rejects.toThrow(/below_minimum/);
    expect((await rpc(u.rc!, "my_wallet")).activities.find((a: any) => a.org_id === org.RC).balance_minor).toBe(0);
  });
});
