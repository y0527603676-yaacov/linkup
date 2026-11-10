import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";

/** Creator commission is before VAT. VAT only by a verified classification; never estimated. Withholding is entered,
 *  never computed. Separate base · VAT · withholding · net · transferred. Legacy agreements: no VAT until decided. */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const u: Record<string, Who> = {};
const org: Record<string, string> = {};
const code: Record<string, string> = {};
let conn = "";
let seq = 0;

const rpc = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  const row = await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
  return row.r;
};
const q = <T = any>(sql: string, p: unknown[] = []) => db.as<T>(owner, sql, p);
const backdate = (sql: string, p: unknown[] = []) =>
  db.transaction(async (tx) => { await tx.exec(`set local session_replication_role = replica`); await tx.query(sql, p); });
const sale = (c: string) => rpc(svc, "ingest_order_event", { p_connection: conn, p_event: JSON.stringify({ event_id: `ct-${++seq}`,
  occurred_at: new Date(Date.now() + seq).toISOString(), order: { id: `o-${c}`, status: "completed", currency: "ILS", total: 11_800, tax: 1_800,
  shipping: 0, shipping_tax: 0, coupons: [code[c]], created_at: new Date().toISOString(), refunds: [] } }) });
const profile = (c: string, cls: string) => rpc(u[c]!, "save_tax_profile", { p_org: org[c], p_legal_name: "Biz " + cls, p_classification: cls,
  p_tax_id: "123456789", p_address: "Address 1", p_country: "IL", p_no_il_presence: false, p_evidence: null, p_payment_method: null });
const report = (c: string, amount: number, extra: Record<string, unknown> = {}) => rpc(u.s!, "report_creator_payment", { p_store: org.S,
  p_creator: org[c], p_amount_minor: amount, p_vat_minor: null, p_method: "bank_transfer", p_paid_on: null, p_reference: "TR", p_idempotency_key: null, ...extra });
const pair = async (c: string) => (await rpc<any[]>(u.s!, "payout_balances", { p_org: org.S })).find((x) => x.other_org_id === org[c]);

beforeAll(async () => {
  db = await createDb();
  for (const k of ["s", "admin", "unv", "dealer", "exempt", "priv", "legacy"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@ct.test`) };
  await q(`insert into platform_admins(user_id) values ($1)`, [(u.admin as any).userId]);
  org.S = await rpc(u.s!, "create_organization", { p_type: "store", p_name: "Store" });
  conn = (await rpc(u.s!, "create_store_connection", { p_org: org.S, p_site_url: "ct.co.il" })).connection_id;
  await rpc(svc, "plugin_sync", { p_connection: conn, p_plugin_version: "0.3.1" });
  const opp = await rpc(u.s!, "save_standing_opportunity", { p_store: org.S, p_title: "Offer", p_description: null,
    p_commission_bps: 1000, p_coupon_pct: 10, p_auto_approve: true, p_status: "live" });
  for (const c of ["unv", "dealer", "exempt", "priv", "legacy"]) {
    org[c] = await rpc(u[c]!, "create_organization", { p_type: "creator", p_name: "Creator " + c });
    code[c] = (await rpc(u[c]!, "join_opportunity", { p_opportunity: opp, p_creator: org[c] })).code;
    await sale(c);   // base 10 000 → commission 1 000
  }
  await profile("unv", "authorized_dealer");                 // saved, never verified
  for (const [c, cls] of [["dealer", "authorized_dealer"], ["exempt", "exempt_dealer"], ["priv", "private_individual"], ["legacy", "authorized_dealer"]]) {
    await profile(c!, cls!); await rpc(u.admin!, "verify_tax_profile", { p_org: org[c!], p_zero_rate: false });
  }
  await backdate(`update orders set completed_at = now() - interval '40 days'`);
  await rpc(svc, "approve_matured_commissions");
  // A collaboration made before the definition was shown (as the migration marks every existing agreement).
  await q(`update agreements set commission_vat_basis = 'unspecified' where creator_org_id = $1`, [org.legacy]);
}, 60_000);

describe("VAT basis", () => {
  it("new agreements are agreed before VAT", async () => {
    const r = await q<{ b: string }>(`select commission_vat_basis b from agreements where creator_org_id = $1`, [org.dealer]);
    expect(r[0]!.b).toBe("plus_vat");
  });

  it("verified VAT-registered dealer: VAT computed on the base, shown separately", async () => {
    const p = await pair("dealer");
    expect([p.vat_basis, p.vat_bps, Number(p.outstanding_base_minor), Number(p.outstanding_vat_minor), Number(p.outstanding_gross_minor)])
      .toEqual(["plus_vat", 1800, 1_000, 180, 1_180]);
  });

  it("exempt dealer: no VAT", async () => {
    const p = await pair("exempt");
    expect([p.vat_basis, p.vat_bps, Number(p.outstanding_vat_minor)]).toEqual(["exempt", 0, 0]);
  });

  it("unverified, private individual, legacy agreement: nothing computed", async () => {
    for (const [c, reason] of [["unv", "classification_unverified"], ["priv", "needs_accountant"], ["legacy", "agreement_unspecified"]]) {
      const p = await pair(c!);
      expect([p.vat_basis, p.vat_reason, p.vat_bps, p.outstanding_vat_minor, p.outstanding_gross_minor]).toEqual(["undetermined", reason, null, null, null]);
      expect(Number(p.outstanding_minor)).toBe(1_000);   // the agreed commission itself is unchanged
    }
  });
});

describe("reporting a payment", () => {
  it("dealer: VAT set by the server, withholding entered, net = base + VAT − withholding", async () => {
    await expect(report("dealer", 1_000, { p_vat_minor: 50 })).rejects.toThrow(/vat_mismatch/);
    await expect(report("dealer", 1_000, { p_withholding_minor: 1_180 })).rejects.toThrow(/invalid_amount/);
    const r = await report("dealer", 600, { p_withholding_minor: 30, p_withholding_ref: "cert 123" });
    expect([r.amount_minor, r.vat_minor, r.withholding_minor, r.net_minor, r.remaining_minor].map(Number)).toEqual([600, 108, 30, 678, 400]);
    const p = await pair("dealer");
    expect([p.reported_base_minor, p.reported_vat_minor, p.withheld_minor, p.transferred_minor, p.outstanding_base_minor].map(Number))
      .toEqual([600, 108, 30, 678, 400]);
  });

  it("undetermined basis: VAT refused, base payment still recordable", async () => {
    await expect(report("unv", 1_000, { p_vat_minor: 180 })).rejects.toThrow(/creator_tax_undetermined/);
    const r = await report("unv", 1_000);
    expect([r.vat_minor, r.net_minor].map(Number)).toEqual([0, 1_000]);
    const row = await q<{ t: string; b: number | null }>(`select tax_basis t, vat_bps b from creator_payouts where creator_org_id = $1`, [org.unv]);
    expect([row[0]!.t, row[0]!.b]).toEqual(["undetermined", null]);
  });

  it("recorded breakdown cannot be changed afterwards", async () => {
    await expect(q(`update creator_payouts set withholding_minor = 0 where creator_org_id = $1`, [org.dealer])).rejects.toThrow(/append_only/);
  });

  it("statement shows the breakdown for both sides", async () => {
    const st = await rpc(u.dealer!, "creator_statement", { p_store: org.S, p_creator: org.dealer });
    expect(st.tax.vat_basis).toBe("plus_vat");
    expect([st.payments[0].amount_minor, st.payments[0].vat_minor, st.payments[0].withholding_minor, st.payments[0].net_minor].map(Number))
      .toEqual([600, 108, 30, 678]);
  });
});

describe("legacy agreement decision", () => {
  it("only the platform admin, with a reason; then VAT applies from the decision on", async () => {
    const id = (await q<{ id: string }>(`select id from agreements where creator_org_id = $1`, [org.legacy]))[0]!.id;
    expect((await rpc<any[]>(u.admin!, "admin_vat_basis_pending")).map((x) => x.id)).toContain(id);
    await expect(rpc(u.s!, "set_commission_vat_basis", { p_agreement: id, p_note: "x" })).rejects.toThrow(/forbidden/);
    await expect(rpc(u.admin!, "set_commission_vat_basis", { p_agreement: id, p_note: " " })).rejects.toThrow(/reason_required/);
    await rpc(u.admin!, "set_commission_vat_basis", { p_agreement: id, p_note: "Both parties confirmed: before VAT" });
    expect((await pair("legacy")).vat_basis).toBe("plus_vat");
    await expect(rpc(u.admin!, "set_commission_vat_basis", { p_agreement: id, p_note: "again" })).rejects.toThrow(/not_found/);
  });
});
