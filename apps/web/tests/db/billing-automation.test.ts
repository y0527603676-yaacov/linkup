import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";
import { runBilling } from "../../src/lib/payments/runner";
import { simulatedDocuments, simulatedPayments } from "../../src/lib/payments/simulated";
import type { Rpc } from "../../src/lib/payments/types";

/** Automatic collection of the LINKUP fee with the simulated provider: authorisation and timing chosen by the store,
 *  master switch, scheduling, charge, retries, final failure → exception, documents, refunds, webhook idempotency. */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const u: Record<string, Who> = {};
const org: Record<string, string> = {};
const conn: Record<string, string> = {};
const code: Record<string, string> = {};
const inv: Record<string, string> = {};
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
const pay = simulatedPayments(), docs = simulatedDocuments();
const run = () => runBilling(svcRpc, pay, docs);
const method = (store: string, who: Who, token: string, timing = "days_after_delivery", days: number | null = 3) =>
  rpc(who, "save_payment_method", { p_store: store, p_provider: "simulated", p_token_ref: token, p_brand: "visa", p_last4: "4242",
    p_exp_month: 12, p_exp_year: 2030, p_charge_timing: timing, p_charge_days: days, p_authorization_version: "draft-1" });

beforeAll(async () => {
  db = await createDb();
  for (const k of ["a", "b", "c", "admin", "staff"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@ba.test`) };
  await q(`insert into platform_admins(user_id) values ($1)`, [(u.admin as any).userId]);
  org.C = await rpc(u.c!, "create_organization", { p_type: "creator", p_name: "Creator C" });
  for (const k of ["A", "B"]) {
    const who = u[k.toLowerCase()]!;
    org[k] = await rpc(who, "create_organization", { p_type: "store", p_name: `Store ${k}` });
    conn[k] = (await rpc(who, "create_store_connection", { p_org: org[k], p_site_url: `${k.toLowerCase()}.co.il` })).connection_id;
    await rpc(svc, "plugin_sync", { p_connection: conn[k], p_plugin_version: "0.3.1" });
    const opp = await rpc(who, "save_standing_opportunity", { p_store: org[k], p_title: `Store ${k} offer`, p_description: null,
      p_commission_bps: 1000, p_coupon_pct: 10, p_auto_approve: true, p_status: "live" });
    code[k] = (await rpc(u.c!, "join_opportunity", { p_opportunity: opp, p_creator: org.C })).code;
    await rpc(svc, "ingest_order_event", { p_connection: conn[k], p_event: JSON.stringify({ event_id: `ba-${++seq}`, occurred_at: new Date(Date.now() - 20 * 864e5).toISOString(),
      order: { id: `${k}-1`, status: "completed", currency: "ILS", total: 118_000, tax: 18_000, shipping: 0, shipping_tax: 0, coupons: [code[k]], created_at: new Date().toISOString(), refunds: [] } }) });
  }
  const t = (await rpc(u.a!, "invite_team_member", { p_org: org.A, p_email: "staff@ba.test", p_role: "member" })).token;
  await rpc(u.staff!, "accept_team_invite", { p_token: t });
  await rpc(svc, "approve_matured_commissions");
  await backdate(`update commission_ledger set approved_at = $1 where state = 'approved'`, [`${month(1)}T12:00:00Z`]);
  await q(`update app_settings set value = 'true' where key = 'invoicing_tax_approved'`);
  await rpc(u.admin!, "generate_invoices", { p_period_start: month(1) });
  for (const k of ["A", "B"]) {
    inv[k] = (await q(`select id from invoices where store_org_id = $1`, [org[k]]))[0].id;
    await rpc(u.admin!, "mark_invoice_delivered", { p_invoice: inv[k], p_method: "email", p_reference: "test" });
  }
}, 60_000);

describe("payment method and authorisation", () => {
  it("only a store admin saves it, with an explicit authorisation and a chosen timing; only a masked card is visible", async () => {
    await expect(method(org.A, u.staff!, "sim_ok_a")).rejects.toThrow(/forbidden/);
    await expect(rpc(u.a!, "save_payment_method", { p_store: org.A, p_provider: "simulated", p_token_ref: "sim_ok_a", p_brand: "visa", p_last4: "4242",
      p_exp_month: 12, p_exp_year: 2030, p_charge_timing: "days_after_delivery", p_charge_days: 3, p_authorization_version: "" })).rejects.toThrow(/legal_acceptance_required/);
    await expect(method(org.A, u.a!, "sim_ok_a", "days_after_delivery", 20)).rejects.toThrow(/invalid_input/);   // beyond the 14-day term
    await expect(rpc(u.a!, "save_payment_method", { p_store: org.A, p_provider: "morning", p_token_ref: "tok", p_brand: null, p_last4: null,
      p_exp_month: null, p_exp_year: null, p_charge_timing: "on_due_date", p_charge_days: null, p_authorization_version: "v" })).rejects.toThrow(/invalid_input/);
    await method(org.A, u.a!, "sim_ok_a", "days_after_delivery", 3);
    await method(org.B, u.b!, "sim_flaky_b", "on_due_date", null);
    const m = (await rpc(u.a!, "my_billing", { p_store: org.A })).method;
    expect(m).toMatchObject({ last4: "4242", charge_timing: "days_after_delivery", charge_days: 3 });
    expect(JSON.stringify(m)).not.toContain("sim_ok_a");
    await expect(db.as(u.a!, `select 1 from billing_payment_methods`)).rejects.toThrow(/permission denied/);
  });
});

describe("automatic collection", () => {
  it("does nothing while the master switch is off", async () => {
    const r = await run();
    expect([r.scheduled, r.charged]).toEqual([0, 0]);
    expect(await q(`select 1 from billing_charges`)).toHaveLength(0);
  });
  it("schedules on the date each store chose — never after the contractual due date", async () => {
    await q(`update app_settings set value = 'true' where key = 'auto_collection_enabled'`);
    const r = await run();
    expect(r.scheduled).toBe(2);
    const c = await q(`select i.store_org_id s, round(extract(epoch from c.scheduled_for - i.delivered_at) / 86400) d, c.scheduled_for <= i.due_at ok
                         from billing_charges c join invoices i on i.id = c.invoice_id order by d`);
    expect(c.map((x: any) => [x.s === org.A ? "A" : "B", Number(x.d), x.ok])).toEqual([["A", 3, true], ["B", 14, true]]);
    expect(r.charged).toBe(0);                                                         // not due yet
  });
  it("charges when due: success → request paid, rewards settled, tax document recorded", async () => {
    await backdate(`update billing_charges set scheduled_for = now() - interval '1 minute' where store_org_id = $1`, [org.A]);
    const r = await run();
    expect([r.charged, r.documents]).toEqual([1, 1]);
    expect((await q(`select status, paid_reference from invoices where id = $1`, [inv.A]))[0]).toMatchObject({ status: "paid" });
    expect(await q(`select issuer, doc_type from accounting_documents where invoice_id = $1`, [inv.A])).toEqual([{ issuer: "linkup", doc_type: "tax_invoice_receipt" }]);
    expect((await run()).charged).toBe(0);                                             // idempotent
  });
  it("a failed charge retries after the configured days; success on retry; final failure goes to the exceptions queue", async () => {
    await backdate(`update billing_charges set scheduled_for = now() - interval '1 minute' where store_org_id = $1`, [org.B]);
    const r1 = await run();
    expect(r1.retries).toBe(1);
    const next = (await q(`select attempt, round(extract(epoch from scheduled_for - now()) / 86400) d from billing_charges where store_org_id = $1 and status = 'scheduled'`, [org.B]))[0];
    expect([next.attempt, Number(next.d)]).toEqual([2, 2]);
    await backdate(`update billing_charges set scheduled_for = now() - interval '1 minute' where store_org_id = $1 and status = 'scheduled'`, [org.B]);
    expect((await run()).charged).toBe(1);                                             // flaky token succeeds on attempt 2
    expect((await q(`select status from invoices where id = $1`, [inv.B]))[0].status).toBe("paid");
  });
  it("final failure after all retries → notification and an exception with a retry action; admin can retry now", async () => {
    // a third store request, with a card that always declines
    const who = u.a!;
    await backdate(`insert into invoices(store_org_id, period_start, currency, fees_minor, vat_bps, vat_minor, credit_minor, total_minor, delivered_at, due_at, delivery_method)
                    values ($1, $2, 'ILS', 1000, 1800, 180, 0, 1180, now() - interval '20 days', now() - interval '6 days', 'email')`, [org.A, month(2)]);
    inv.A2 = (await q(`select id from invoices where store_org_id = $1 and status = 'issued'`, [org.A]))[0].id;
    await method(org.A, who, "sim_decline_a", "days_after_delivery", 0);
    await run();                                                                        // schedules attempt 1 (due: delivered + 0)
    for (let i = 0; i < 3; i++) {
      await backdate(`update billing_charges set scheduled_for = now() - interval '1 minute' where invoice_id = $1 and status = 'scheduled'`, [inv.A2]);
      await run();
    }
    expect(await q(`select attempt, status from billing_charges where invoice_id = $1 order by attempt`, [inv.A2]))
      .toEqual([{ attempt: 1, status: "failed" }, { attempt: 2, status: "failed" }, { attempt: 3, status: "failed" }]);
    expect(await q(`select 1 from notifications where org_id = $1 and kind = 'charge_failed_final'`, [org.A])).toHaveLength(1);
    const ex = (await rpc(u.admin!, "billing_exceptions")).filter((x: any) => x.kind === "charge_failed");
    expect(ex).toHaveLength(1);
    await expect(rpc(u.a!, "billing_exceptions")).rejects.toThrow(/forbidden/);
    await method(org.A, who, "sim_ok_a2", "days_after_delivery", 0);                  // store updates its card
    await rpc(u.admin!, "retry_charge_now", { p_invoice: inv.A2 });
    expect((await run()).charged).toBe(1);
  });
  it("an open dispute stops automatic charging of that request", async () => {
    await backdate(`insert into invoices(store_org_id, period_start, currency, fees_minor, vat_bps, vat_minor, credit_minor, total_minor, delivered_at, due_at, delivery_method)
                    values ($1, $2, 'ILS', 500, 1800, 90, 0, 590, now() - interval '1 day', now() + interval '13 days', 'email')`, [org.A, month(3)]);
    const id = (await q(`select id from invoices where store_org_id = $1 and status = 'issued'`, [org.A]))[0].id;
    await rpc(u.a!, "open_invoice_dispute", { p_invoice: id, p_disputed_minor: 100, p_reason: "wrong order" });
    await run();
    expect(await q(`select 1 from billing_charges where invoice_id = $1`, [id])).toHaveLength(0);
    expect((await rpc(u.admin!, "billing_exceptions")).some((x: any) => x.kind === "request_disputed")).toBe(true);
  });
});

describe("refunds, webhooks, dashboard", () => {
  it("refund: admin request → provider → credit note recorded; cannot exceed the charge", async () => {
    const ch = (await q(`select id, amount_minor from billing_charges where invoice_id = $1 and status = 'succeeded'`, [inv.A]))[0];
    await expect(rpc(u.admin!, "request_refund", { p_charge: ch.id, p_amount_minor: Number(ch.amount_minor) + 1, p_reason: "too much" })).rejects.toThrow(/invalid_amount/);
    await expect(rpc(u.a!, "request_refund", { p_charge: ch.id, p_amount_minor: 100, p_reason: "x" })).rejects.toThrow(/forbidden/);
    await rpc(u.admin!, "request_refund", { p_charge: ch.id, p_amount_minor: 100, p_reason: "goodwill credit" });
    expect((await run()).refunds).toBe(1);
    expect(await q(`select doc_type from accounting_documents where invoice_id = $1 order by created_at`, [inv.A])).toEqual([{ doc_type: "tax_invoice_receipt" }, { doc_type: "credit_note" }]);
  });
  it("a webhook event is processed once; a bad signature is rejected", async () => {
    const ok = await pay.parseWebhook(new Headers({ "x-sim-signature": "valid" }), JSON.stringify({ id: "ev_1", kind: "charge.succeeded", payload: {} }));
    expect(await pay.parseWebhook(new Headers(), "{}")).toBeNull();
    expect(await rpc(svc, "billing_record_webhook", { p_provider: "simulated", p_event_id: ok!.eventId, p_kind: ok!.kind, p_payload: "{}" })).toBe("new");
    expect(await rpc(svc, "billing_record_webhook", { p_provider: "simulated", p_event_id: ok!.eventId, p_kind: ok!.kind, p_payload: "{}" })).toBe("duplicate");
  });
  it("the owner's dashboard sums it up; charge history is never deleted or rewritten", async () => {
    const d = await rpc(u.admin!, "finance_dashboard");
    expect(Number(d.auto_collected_month_minor)).toBeGreaterThan(0);
    expect(Number(d.refunds_month_minor)).toBe(100);
    expect(Number(d.stores_with_method)).toBe(2);
    await expect(q(`delete from billing_charges`)).rejects.toThrow(/append_only/);
    await expect(q(`update billing_charges set amount_minor = 1`)).rejects.toThrow(/append_only/);
    await expect(rpc(u.a!, "finance_dashboard")).rejects.toThrow(/forbidden/);
  });
  it("removing the card cancels charges not yet started; manual 'paid' cancels a waiting charge", async () => {
    await backdate(`insert into invoices(store_org_id, period_start, currency, fees_minor, vat_bps, vat_minor, credit_minor, total_minor, delivered_at, due_at, delivery_method)
                    values ($1, $2, 'ILS', 700, 1800, 126, 0, 826, now(), now() + interval '14 days', 'email')`, [org.B, month(4)]);
    const id = (await q(`select id from invoices where store_org_id = $1 and status = 'issued'`, [org.B]))[0].id;
    await run();
    expect((await q(`select status from billing_charges where invoice_id = $1`, [id]))[0].status).toBe("scheduled");
    await rpc(u.admin!, "mark_invoice_paid", { p_invoice: id, p_reference: "bank transfer" });
    expect((await q(`select status, failure_code from billing_charges where invoice_id = $1`, [id]))[0]).toEqual({ status: "cancelled", failure_code: "paid_otherwise" });
    await rpc(u.b!, "remove_payment_method", { p_store: org.B });
    expect((await rpc(u.b!, "my_billing", { p_store: org.B })).method).toBeNull();
  });
});
