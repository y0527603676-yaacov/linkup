import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";

/** Accounting basis approved by the accountant: separate VAT on fee and on referral reward, offset as settlement,
 *  tax profiles, zero-rate for verified foreign stores, external documents, immutable payment requests. */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const u: Record<string, Who> = {};
const org: Record<string, string> = {};
const conn: Record<string, string> = {};
const code: Record<string, string> = {};
const inv: Record<string, string> = {};

const rpc = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  const row = await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
  return row.r;
};
const q = <T = any>(sql: string, p: unknown[] = []) => db.as<T>(owner, sql, p);
const backdate = (sql: string, p: unknown[] = []) =>
  db.transaction(async (tx) => { await tx.exec(`set local session_replication_role = replica`); await tx.query(sql, p); });
let seq = 0;
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const month = (back: number) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1)).toISOString().slice(0, 10); };
const sale = (store: string, id: string, o: Record<string, number>) =>
  rpc(svc, "ingest_order_event", { p_connection: conn[store], p_event: JSON.stringify({ event_id: `ac-${++seq}`, occurred_at: ago(20),
    order: { id, status: "completed", currency: "ILS", shipping: 0, shipping_tax: 0, tax: 0, ...o, coupons: [code[store]], created_at: new Date().toISOString(), refunds: [] } }) });
const profile = (who: Who, o: string, cls: string, extra: Record<string, unknown> = {}) =>
  rpc(who, "save_tax_profile", { p_org: o, p_legal_name: "Biz " + cls, p_classification: cls, p_tax_id: "123456789",
    p_address: "Address 1", p_country: "IL", p_no_il_presence: false, p_evidence: null, p_payment_method: null, ...extra });

beforeAll(async () => {
  db = await createDb();
  for (const k of ["s", "f", "c", "admin", "staff", "x"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@ac.test`) };
  await q(`insert into platform_admins(user_id) values ($1)`, [(u.admin as any).userId]);
  org.C = await rpc(u.c!, "create_organization", { p_type: "creator", p_name: "Creator C" });
  for (const [k, name, site] of [["S", "Store S", "s.co.il"], ["F", "Foreign F", "f.example.com"]] as const) {
    const who = u[k.toLowerCase()]!;
    org[k] = await rpc(who, "create_organization", { p_type: "store", p_name: name });
    conn[k] = (await rpc(who, "create_store_connection", { p_org: org[k], p_site_url: site })).connection_id;
    await rpc(svc, "plugin_sync", { p_connection: conn[k], p_plugin_version: "0.3.1" });
    const opp = await rpc(who, "save_standing_opportunity", { p_store: org[k], p_title: `${name} offer`, p_description: null,
      p_commission_bps: 1000, p_coupon_pct: 10, p_auto_approve: true, p_status: "live" });
    code[k] = (await rpc(u.c!, "join_opportunity", { p_opportunity: opp, p_creator: org.C })).code;
  }
  const t = (await rpc(u.s!, "invite_team_member", { p_org: org.S, p_email: "staff@ac.test", p_role: "member" })).token;
  await rpc(u.staff!, "accept_team_invite", { p_token: t });
  // S: total 120 360 = base 100 000 + VAT 18 000 + shipping 2 000 + shipping VAT 360 → fee 2% = 2 000
  await sale("S", "s-1", { total: 120_360, tax: 18_000, shipping: 2_000, shipping_tax: 360 });
  await sale("F", "f-1", { total: 50_000, tax: 0 });
  await rpc(svc, "approve_matured_commissions");
  await backdate(`update commission_ledger set approved_at = $1 where state = 'approved'`, [`${month(1)}T12:00:00Z`]);
  // S earned 500 as a FOUNDING PARTNERS referrer (wallet), recorded directly for this test.
  const l = (await q<{ id: string; attribution_id: string }>(`select id, attribution_id from commission_ledger where party_role = 'platform' limit 1`))[0]!;
  await backdate(`insert into referral_rewards(referral_id, referrer_org_id, ledger_id, attribution_id, share_bps, amount_minor, currency, idempotency_key)
                  values (gen_random_uuid(), $1, $2, $3, 4000, 500, 'ILS', 'test:wallet')`, [org.S, l.id, l.attribution_id]);
}, 60_000);

describe("tax profiles", () => {
  it("only an activity admin saves it; every change resets verification; history is kept", async () => {
    await expect(profile(u.staff!, org.S, "authorized_dealer")).rejects.toThrow(/forbidden/);
    await profile(u.s!, org.S, "authorized_dealer");
    await expect(rpc(u.s!, "verify_tax_profile", { p_org: org.S, p_zero_rate: false })).rejects.toThrow(/forbidden/);
    await rpc(u.admin!, "verify_tax_profile", { p_org: org.S, p_zero_rate: false });
    await profile(u.s!, org.S, "authorized_dealer", { p_address: "New address" });
    expect((await q(`select verified_at from tax_profiles where org_id = $1`, [org.S]))[0].verified_at).toBeNull();
    expect(await q(`select 1 from tax_profile_history where org_id = $1`, [org.S])).toHaveLength(3);
    await expect(db.as(u.x!, `select 1 from tax_profiles where org_id = $1`, [org.S])).resolves.toHaveLength(0);
  });
  it("VAT on a referral reward is never assumed: unverified or private → not settleable; exempt → 0; company/dealer → 18%", async () => {
    const rate = async (o: string) => (await q(`select public.reward_vat_bps($1) r`, [o]))[0].r;
    expect(await rate(org.S)).toBeNull();                      // unverified
    await profile(u.c!, org.C, "private_individual");
    await rpc(u.admin!, "verify_tax_profile", { p_org: org.C, p_zero_rate: false });
    expect(await rate(org.C)).toBeNull();                      // private individual: pending decision
    await profile(u.c!, org.C, "exempt_dealer");
    await rpc(u.admin!, "verify_tax_profile", { p_org: org.C, p_zero_rate: false });
    expect(await rate(org.C)).toBe(0);
    await profile(u.c!, org.C, "private_individual");          // back to private for the transfer test below
    await rpc(u.admin!, "verify_tax_profile", { p_org: org.C, p_zero_rate: false });
  });
  it("zero-rate VAT only for a verified foreign resident with evidence and no Israeli presence", async () => {
    await profile(u.f!, org.F, "authorized_dealer");
    await expect(rpc(u.admin!, "verify_tax_profile", { p_org: org.F, p_zero_rate: true })).rejects.toThrow(/zero_rate_not_allowed/);
    await profile(u.f!, org.F, "foreign_resident", { p_country: "US", p_no_il_presence: true });
    await expect(rpc(u.admin!, "verify_tax_profile", { p_org: org.F, p_zero_rate: true })).rejects.toThrow(/zero_rate_not_allowed/);
    await profile(u.f!, org.F, "foreign_resident", { p_country: "US", p_no_il_presence: true, p_evidence: "Certificate of incorporation DE 123",
      p_payment_method: "US bank account" });
    await rpc(u.admin!, "verify_tax_profile", { p_org: org.F, p_zero_rate: true });
    expect((await q(`select public.fee_vat_bps($1) r`, [org.F]))[0].r).toBe(0);
    expect((await q(`select public.fee_vat_bps($1) r`, [org.S]))[0].r).toBe(1800);
  });
});

describe("payment request: fee VAT, reward VAT and offset recorded separately", () => {
  it("without a verified classification no offset is taken (the reward stays in the wallet)", async () => {
    const pv = (await rpc(u.admin!, "preview_invoices", { p_period_start: month(1) })).find((x: any) => x.store === "Store S");
    expect(pv.offset_blocked).toBe(true);
    expect(Number(pv.credit_minor)).toBe(0);
    expect(Number(pv.total_minor)).toBe(2_360);
  });
  it("authorised dealer: VAT on the full fee; reward + its VAT offset as settlement; balance = the difference", async () => {
    await rpc(u.admin!, "verify_tax_profile", { p_org: org.S, p_zero_rate: false });
    const pv = (await rpc(u.admin!, "preview_invoices", { p_period_start: month(1) })).find((x: any) => x.store === "Store S");
    expect([pv.fees_minor, pv.vat_minor, pv.reward_offset_minor, pv.reward_vat_minor, pv.credit_minor, pv.total_minor].map(Number))
      .toEqual([2_000, 360, 500, 90, 590, 1_770]);
    await q(`update app_settings set value = 'true' where key = 'invoicing_tax_approved'`);
    expect(await rpc(u.admin!, "generate_invoices", { p_period_start: month(1) })).toBe(2);
    const i = (await q(`select * from invoices where store_org_id = $1`, [org.S]))[0];
    inv.S = i.id;
    expect([i.fees_minor, i.vat_bps, i.vat_minor, i.reward_offset_minor, i.reward_vat_bps, i.reward_vat_minor, i.credit_minor, i.total_minor].map(Number))
      .toEqual([2_000, 1800, 360, 500, 1800, 90, 590, 1_770]);
    expect(i.store_classification).toBe("authorized_dealer");
    const p = (await q(`select amount_minor::int a, vat_minor::int v, method from reward_payouts where org_id = $1`, [org.S]))[0];
    expect(p).toEqual({ a: 500, v: 90, method: "invoice_credit" });   // wallet is debited by the reward only, not its VAT
    expect(Number((await q(`select public.wallet_balance_minor($1, 'ILS') b`, [org.S]))[0].b)).toBe(0);
  });
  it("verified foreign store: zero-rate VAT captured on its request", async () => {
    const i = (await q(`select * from invoices where store_org_id = $1`, [org.F]))[0];
    inv.F = i.id;
    expect([Number(i.vat_bps), Number(i.vat_minor), Number(i.total_minor)]).toEqual([0, 0, Number(i.fees_minor)]);
  });
  it("the offset never exceeds what is due", async () => {
    const s = (await q(`select (public.reward_offset_split(100, 10000, 1800)).*`))[0];
    expect(Number(s.reward_used) + Number(s.reward_vat)).toBeLessThanOrEqual(100);
    expect(Number(s.reward_used)).toBe(84);
  });
});

describe("immutability", () => {
  it("a payment request's amounts can never be edited or deleted; lines and offsets are append-only", async () => {
    await expect(q(`update invoices set fees_minor = 1 where id = $1`, [inv.S])).rejects.toThrow(/append_only/);
    await expect(q(`update invoices set vat_minor = 0 where id = $1`, [inv.S])).rejects.toThrow(/append_only/);
    await expect(q(`delete from invoices where id = $1`, [inv.S])).rejects.toThrow(/append_only/);
    await expect(q(`delete from invoice_items where invoice_id = $1`, [inv.S])).rejects.toThrow(/append_only/);
    await expect(q(`delete from reward_payouts where invoice_id = $1`, [inv.S])).rejects.toThrow(/append_only/);
  });
  it("once delivered it cannot be voided; an undelivered one may be voided, keeping its history", async () => {
    await rpc(u.admin!, "mark_invoice_delivered", { p_invoice: inv.S, p_method: "email", p_reference: "to owner" });
    await expect(rpc(u.admin!, "void_invoice", { p_invoice: inv.S })).rejects.toThrow(/invoice_not_voidable/);
    await expect(q(`update invoices set due_at = now() where id = $1`, [inv.S])).rejects.toThrow(/append_only/);
    await rpc(u.admin!, "void_invoice", { p_invoice: inv.F });
    expect(await q(`select 1 from invoice_items where invoice_id = $1`, [inv.F])).toHaveLength(1);
    expect(await rpc(u.admin!, "generate_invoices", { p_period_start: month(1) })).toBe(1);   // lines re-billed once
    expect(await rpc(u.admin!, "generate_invoices", { p_period_start: month(1) })).toBe(0);
  });
});

describe("external accounting documents", () => {
  it("records both sides' documents linked to the request; flags what is missing", async () => {
    const before = (await rpc(u.admin!, "admin_invoices")).invoices.find((x: any) => x.id === inv.S);
    expect(before.missing_counterparty_doc).toBe(true);
    await expect(rpc(u.s!, "record_accounting_document", { p_issuer: "linkup", p_doc_type: "tax_invoice", p_number: "1", p_issued_on: month(0),
      p_invoice: inv.S, p_reward_payout: null, p_amount_minor: 2000, p_vat_minor: 360 })).rejects.toThrow(/forbidden/);
    await expect(rpc(u.admin!, "record_accounting_document", { p_issuer: "linkup", p_doc_type: "tax_invoice", p_number: "1", p_issued_on: "2999-01-01",
      p_invoice: inv.S, p_reward_payout: null, p_amount_minor: 2000, p_vat_minor: 360 })).rejects.toThrow(/invalid_dates/);
    await rpc(u.admin!, "record_accounting_document", { p_issuer: "counterparty", p_doc_type: "tax_invoice", p_number: "S-88", p_issued_on: month(0),
      p_invoice: inv.S, p_reward_payout: null, p_amount_minor: 500, p_vat_minor: 90, p_software: "external", p_note: "referral reward" });
    await rpc(u.admin!, "mark_invoice_paid", { p_invoice: inv.S, p_reference: "TRANSFER-1" });
    expect((await rpc(u.admin!, "admin_invoices")).invoices.find((x: any) => x.id === inv.S).missing_linkup_doc).toBe(true);
    await rpc(u.admin!, "record_accounting_document", { p_issuer: "linkup", p_doc_type: "tax_invoice_receipt", p_number: "L-1001", p_issued_on: month(0),
      p_invoice: inv.S, p_reward_payout: null, p_amount_minor: 2000, p_vat_minor: 360 });
    const after = (await rpc(u.admin!, "admin_invoices")).invoices.find((x: any) => x.id === inv.S);
    expect([after.missing_linkup_doc, after.missing_counterparty_doc]).toEqual([false, false]);
    expect(after.documents).toHaveLength(2);
    await expect(q(`update accounting_documents set doc_number = 'x'`)).rejects.toThrow(/append_only/);
    expect(await db.as(u.s!, `select doc_number from accounting_documents where org_id = $1 order by doc_number`, [org.S])).toHaveLength(2);
    expect(await db.as(u.f!, `select 1 from accounting_documents where org_id = $1`, [org.S])).toHaveLength(0);
    await expect(rpc(u.s!, "admin_invoices")).rejects.toThrow(/forbidden/);
  });
  it("a cash reward to a private individual is blocked pending a decision", async () => {
    await backdate(`insert into referral_rewards(referral_id, referrer_org_id, ledger_id, attribution_id, share_bps, amount_minor, currency, idempotency_key)
                    select gen_random_uuid(), $1, id, attribution_id, 4000, 50000, 'ILS', 'test:c' from commission_ledger where party_role = 'platform' limit 1`, [org.C]);
    await expect(rpc(u.admin!, "record_reward_transfer", { p_org: org.C, p_currency: "ILS", p_reference: "B", p_doc_type: "other",
      p_doc_number: "1", p_doc_date: null })).rejects.toThrow(/tax_profile_required/);
  });
});

describe("commission base breakdown", () => {
  it("keeps gross, shipping, the sale's VAT, the eligible base, the fee rate and the fee for each sale", async () => {
    const b = (await q(`select * from sale_fee_breakdown where external_order_id = 's-1'`))[0];
    expect([b.gross_sales_minor, b.shipping_minor, b.sale_vat_minor, b.eligible_base_minor, b.linkup_fee_bps, b.linkup_fee_minor].map(Number))
      .toEqual([120_360, 2_360, 18_000, 100_000, 200, 2_000]);
    await expect(db.as(u.s!, `select 1 from sale_fee_breakdown`)).rejects.toThrow(/permission denied/);
  });
});
