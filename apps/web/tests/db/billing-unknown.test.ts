import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";
import { runBilling } from "../../src/lib/payments/runner";
import { simulatedDocuments, simulatedPayments } from "../../src/lib/payments/simulated";
import type { PaymentProvider, Rpc } from "../../src/lib/payments/types";

/** No second charge while a result is unknown: lost answers, stale workers, late and duplicate webhooks,
 *  a success after a decline, and a payment after the request was paid otherwise. */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const u: Record<string, Who> = {};
const org: Record<string, string> = {};
const inv: Record<string, string> = {};
const STORES = ["T", "N", "W", "D", "M", "S"];
let seq = 0;

const rpc = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  const row = await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
  return row.r;
};
const svcRpc: Rpc = (fn, args = {}) => rpc(svc, fn, args);
const q = <T = any>(sql: string, p: unknown[] = []) => db.as<T>(owner, sql, p);
const backdate = (sql: string, p: unknown[] = []) =>
  db.transaction(async (tx) => { await tx.exec(`set local session_replication_role = replica`); await tx.query(sql, p); });
const month = (back: number) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1)).toISOString().slice(0, 10); };
const charges = (k: string) => q<{ attempt: number; status: string; resolution_source: string | null }>(
  `select attempt, status, resolution_source from billing_charges where invoice_id = $1 order by attempt`, [inv[k]]);
const invStatus = async (k: string) => (await q<{ s: string }>(`select status s from invoices where id = $1`, [inv[k]]))[0]!.s;
const event = (k: string, outcome = "succeeded", id = `ev-${++seq}`) =>
  rpc(svc, "billing_apply_provider_event", { p_provider: "simulated", p_event_id: id, p_invoice: inv[k], p_outcome: outcome, p_provider_ref: "prov-" + k });
const docs = simulatedDocuments();
// A provider that never answers and has no record to look up (e.g. an outage).
const silent: PaymentProvider = { ...simulatedPayments(), charge: async () => { throw new Error("socket hang up"); }, findCharge: async () => null };

beforeAll(async () => {
  db = await createDb();
  for (const k of ["c", "admin", ...STORES.map((s) => s.toLowerCase())]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@bu.test`) };
  await q(`insert into platform_admins(user_id) values ($1)`, [(u.admin as any).userId]);
  org.C = await rpc(u.c!, "create_organization", { p_type: "creator", p_name: "Creator" });
  for (const k of STORES) {
    const who = u[k.toLowerCase()]!;
    org[k] = await rpc(who, "create_organization", { p_type: "store", p_name: `Store ${k}` });
    const conn = (await rpc(who, "create_store_connection", { p_org: org[k], p_site_url: `${k.toLowerCase()}.co.il` })).connection_id;
    await rpc(svc, "plugin_sync", { p_connection: conn, p_plugin_version: "0.3.1" });
    const opp = await rpc(who, "save_standing_opportunity", { p_store: org[k], p_title: `Offer ${k}`, p_description: null,
      p_commission_bps: 1000, p_coupon_pct: 10, p_auto_approve: true, p_status: "live" });
    const code = (await rpc(u.c!, "join_opportunity", { p_opportunity: opp, p_creator: org.C })).code;
    await rpc(svc, "ingest_order_event", { p_connection: conn, p_event: JSON.stringify({ event_id: `bu-${++seq}`, occurred_at: new Date(Date.now() - 20 * 864e5).toISOString(),
      order: { id: `${k}-1`, status: "completed", currency: "ILS", total: 118_000, tax: 18_000, shipping: 0, shipping_tax: 0, coupons: [code], created_at: new Date().toISOString(), refunds: [] } }) });
  }
  await rpc(svc, "approve_matured_commissions");
  await backdate(`update commission_ledger set approved_at = $1 where state = 'approved'`, [`${month(1)}T12:00:00Z`]);
  await q(`update app_settings set value = 'true' where key in ('invoicing_tax_approved', 'auto_collection_enabled')`);
  await rpc(u.admin!, "generate_invoices", { p_period_start: month(1) });
  const token: Record<string, string> = { T: "sim_timeout_t", N: "sim_ok_n", W: "sim_ok_w", D: "sim_decline_d", M: "sim_ok_m", S: "sim_ok_s" };
  for (const k of STORES) {
    inv[k] = (await q(`select id from invoices where store_org_id = $1`, [org[k]]))[0].id;
    await rpc(u.admin!, "mark_invoice_delivered", { p_invoice: inv[k], p_method: "email", p_reference: "test" });
  }
  // M: paid by bank transfer before any card exists
  await rpc(u.admin!, "mark_invoice_paid", { p_invoice: inv.M, p_reference: "bank 123" });
}, 90_000);

// Each scenario gives only its own store a card, so a run touches only that store's request.
const card = (k: string, token: string) => rpc(u[k.toLowerCase()]!, "save_payment_method", { p_store: org[k], p_provider: "simulated",
  p_token_ref: token, p_brand: "visa", p_last4: "4242", p_exp_month: 12, p_exp_year: 2030, p_charge_timing: "days_after_delivery",
  p_charge_days: 0, p_authorization_version: "draft-1" });
const exceptions = async () => (await rpc<any[]>(u.admin!, "billing_exceptions")).map((x) => x.kind);

describe("lost answer", () => {
  it("a timeout is 'unknown', not a decline: no retry; the next run finds the charge at the provider and settles once", async () => {
    await card("T", "sim_timeout_t");
    const pay = simulatedPayments();
    const r1 = await runBilling(svcRpc, pay, docs);
    expect([r1.unknown, r1.charged, r1.retries]).toEqual([1, 0, 0]);
    expect(await charges("T")).toEqual([{ attempt: 1, status: "unknown", resolution_source: null }]);
    expect(await invStatus("T")).toBe("issued");
    const r2 = await runBilling(svcRpc, pay, docs);
    expect(r2.resolved).toBe(1);
    expect(await charges("T")).toEqual([{ attempt: 1, status: "succeeded", resolution_source: "provider_query" }]);
    expect(await invStatus("T")).toBe("paid");
    expect((await q(`select count(*)::int n from accounting_documents where invoice_id = $1`, [inv.T]))[0].n).toBe(1);
    expect((await event("T")) as string).toBe("duplicate");                 // a late webhook changes nothing
  });
});

describe("unknown that the provider cannot confirm", () => {
  it("stays unknown across runs; blocks charging, manual 'paid' and retry; only the owner resolves, with a reason", async () => {
    await card("N", "sim_ok_n");
    expect((await runBilling(svcRpc, silent, docs)).unknown).toBe(1);
    for (let i = 0; i < 2; i++) expect((await runBilling(svcRpc, silent, docs))).toMatchObject({ unknown: 0, charged: 0, resolved: 0, scheduled: 0 });
    expect(await charges("N")).toEqual([{ attempt: 1, status: "unknown", resolution_source: null }]);
    await expect(rpc(u.admin!, "mark_invoice_paid", { p_invoice: inv.N, p_reference: "x" })).rejects.toThrow(/charge_outcome_unknown/);
    await expect(rpc(u.admin!, "retry_charge_now", { p_invoice: inv.N })).rejects.toThrow(/charge_outcome_unknown/);
    expect(await exceptions()).toContain("charge_unknown");
    const ch = (await q<{ id: string }>(`select id from billing_charges where invoice_id = $1`, [inv.N]))[0]!.id;
    await expect(rpc(u.n!, "admin_resolve_charge", { p_charge: ch, p_outcome: "failed", p_provider_ref: null, p_note: "x" })).rejects.toThrow(/forbidden/);
    await expect(rpc(u.n!, "billing_resolve_unknown", { p_charge: ch, p_outcome: "succeeded", p_provider_ref: null, p_source: "webhook" })).rejects.toThrow(/permission denied/);
    await expect(rpc(u.admin!, "admin_resolve_charge", { p_charge: ch, p_outcome: "failed", p_provider_ref: null, p_note: " " })).rejects.toThrow(/reason_required/);
    const r = await rpc(u.admin!, "admin_resolve_charge", { p_charge: ch, p_outcome: "failed", p_provider_ref: null, p_note: "Not in the provider dashboard" });
    expect(r.result).toBe("retry_scheduled");                                  // definitive now → normal retry policy
    expect((await charges("N")).map((c) => c.status)).toEqual(["failed", "scheduled"]);
  });
});

describe("webhooks", () => {
  it("resolves an unknown charge once; duplicates and late copies are harmless", async () => {
    await card("W", "sim_ok_w");
    expect((await runBilling(svcRpc, silent, docs)).unknown).toBe(1);
    expect(await event("W", "succeeded", "dl-1")).toBe("resolved_paid");
    expect(await event("W", "succeeded", "dl-1")).toBe("duplicate");
    expect(await event("W", "succeeded", "dl-2")).toBe("duplicate");
    expect(await invStatus("W")).toBe("paid");
    expect((await charges("W")).map((c) => [c.status, c.resolution_source])).toEqual([["succeeded", "webhook"]]);
    // a scheduled run later does nothing more for W
    expect((await runBilling(svcRpc, simulatedPayments(), docs)).charged).toBe(0);
  });

  it("success reported after LINKUP saw a decline: waiting retry cancelled immediately, owner alerted, nothing charged", async () => {
    await card("D", "sim_decline_d");
    expect((await runBilling(svcRpc, simulatedPayments(), docs)).retries).toBe(1);
    expect(await event("D")).toBe("alert");
    expect((await charges("D")).map((c) => c.status)).toEqual(["failed", "cancelled"]);
    await expect(rpc(u.admin!, "retry_charge_now", { p_invoice: inv.D })).rejects.toThrow(/charge_outcome_unknown/);
    expect(await exceptions()).toContain("provider_alert");
    const a = (await q<{ id: string }>(`select id from billing_alerts where invoice_id = $1`, [inv.D]))[0]!.id;
    await expect(rpc(u.admin!, "handle_billing_alert", { p_alert: a, p_note: "" })).rejects.toThrow(/reason_required/);
    await rpc(u.admin!, "handle_billing_alert", { p_alert: a, p_note: "Confirmed in provider dashboard; marked paid manually" });
    await expect(q(`delete from billing_alerts`)).rejects.toThrow(/append_only/);
  });

  it("payment reported for a request already paid otherwise → alert for a refund decision, request untouched", async () => {
    expect(await event("M")).toBe("alert");
    expect((await q<{ kind: string }>(`select kind from billing_alerts where invoice_id = $1`, [inv.M]))[0]!.kind).toBe("payment_after_paid");
    expect(await invStatus("M")).toBe("paid");
  });
});

describe("worker stopped mid-charge", () => {
  it("a charge left 'processing' becomes unknown and is never charged again blindly", async () => {
    await card("S", "sim_ok_s");
    await rpc(svc, "billing_schedule");
    const c = (await rpc<any[]>(svc, "billing_claim_due", { p_limit: 5 })).find((x) => x.invoice_id === inv.S);
    expect(c).toBeTruthy();
    await backdate(`update billing_charges set started_at = now() - interval '1 hour' where id = $1`, [c.charge_id]);
    expect(await rpc(svc, "billing_sweep_stale", { p_minutes: 15 })).toBe(1);
    expect((await charges("S")).map((x) => x.status)).toEqual(["unknown"]);
    expect((await rpc<any[]>(svc, "billing_claim_due", { p_limit: 5 })).find((x) => x.invoice_id === inv.S)).toBeUndefined();
  });
});
