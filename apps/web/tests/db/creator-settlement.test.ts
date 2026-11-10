import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";

/** Creator settlement: balance, due date, partial payments, no unapproved/double payment, confirm/dispute/withdraw,
 *  proofs, protected payment details, statement, reminders. LINKUP never moves creator money. */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const u: Record<string, Who> = {};
const org: Record<string, string> = {};
let conn = "";
let code = "";
let seq = 0;

const rpc = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  const row = await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
  return row.r;
};
const q = <T = any>(sql: string, p: unknown[] = []) => db.as<T>(owner, sql, p);
const backdate = (sql: string, p: unknown[] = []) =>
  db.transaction(async (tx) => { await tx.exec(`set local session_replication_role = replica`); await tx.query(sql, p); });
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const sale = (id: string, total = 11_800, refunds: unknown[] = [], status = "completed") =>
  rpc(svc, "ingest_order_event", { p_connection: conn, p_event: JSON.stringify({ event_id: `cs-${++seq}`, occurred_at: new Date(Date.now() + seq).toISOString(),
    order: { id, status, currency: "ILS", total, tax: 1_800, shipping: 0, shipping_tax: 0, coupons: [code], created_at: new Date().toISOString(), refunds } }) });
const bal = async (who: Who = u.s!) => (await rpc(who, "payout_balances", { p_org: who === u.c ? org.C : org.S }))[0];
const report = (amount: number, key: string | null = null, vat = 0) => rpc(u.s!, "report_creator_payment", { p_store: org.S, p_creator: org.C,
  p_amount_minor: amount, p_vat_minor: vat, p_method: "bank_transfer", p_paid_on: null, p_reference: "TR-" + amount, p_idempotency_key: key });

beforeAll(async () => {
  db = await createDb();
  for (const k of ["s", "c", "staff", "x"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@cs.test`) };
  org.S = await rpc(u.s!, "create_organization", { p_type: "store", p_name: "Store S" });
  org.C = await rpc(u.c!, "create_organization", { p_type: "creator", p_name: "Creator C" });
  org.X = await rpc(u.x!, "create_organization", { p_type: "store", p_name: "Other store" });
  conn = (await rpc(u.s!, "create_store_connection", { p_org: org.S, p_site_url: "s.co.il" })).connection_id;
  await rpc(svc, "plugin_sync", { p_connection: conn, p_plugin_version: "0.3.1" });
  const opp = await rpc(u.s!, "save_standing_opportunity", { p_store: org.S, p_title: "Store S offer", p_description: null,
    p_commission_bps: 1000, p_coupon_pct: 10, p_auto_approve: true, p_status: "live" });
  code = (await rpc(u.c!, "join_opportunity", { p_opportunity: opp, p_creator: org.C })).code;
  const t = (await rpc(u.s!, "invite_team_member", { p_org: org.S, p_email: "staff@cs.test", p_role: "member" })).token;
  await rpc(u.staff!, "accept_team_invite", { p_token: t });
  // three sales of base 10 000 → 1 000 commission each; two approved 20 and 10 days ago, one still pending
  await sale("o1"); await sale("o2"); await sale("o3");
  await backdate(`update orders set completed_at = now() - interval '40 days'`);
  await rpc(svc, "approve_matured_commissions");
  const ids = await q<{ id: string }>(`select l.id from commission_ledger l join attributions a on a.id = l.attribution_id join orders o on o.id = a.order_id
                                       where l.party_role = 'creator' order by o.external_order_id`);
  await backdate(`update commission_ledger set approved_at = now() - interval '20 days' where id = $1`, [ids[0]!.id]);
  await backdate(`update commission_ledger set approved_at = now() - interval '10 days' where id = $1`, [ids[1]!.id]);
  await backdate(`update commission_ledger set state = 'pending', approved_at = null where id = $1`, [ids[2]!.id]);
}, 60_000);

describe("balance and due date", () => {
  it("shows pending, approved, outstanding; due = oldest unpaid approval + 14 days; overdue flagged", async () => {
    const b = await bal();
    expect([b.pending_minor, b.approved_minor, b.outstanding_minor, b.sales].map(Number)).toEqual([1_000, 2_000, 2_000, 3]);
    expect(Math.round((Date.parse(b.due_at) - Date.now()) / 86_400_000)).toBe(-6);
    expect(b.overdue).toBe(true);
    const cb = await bal(u.c!);
    expect(Number(cb.outstanding_minor)).toBe(2_000);
  });
});

describe("reporting payments", () => {
  it("only approved, never more than outstanding, never twice; partial payments move the due date forward", async () => {
    await expect(rpc(u.staff!, "report_creator_payment", { p_store: org.S, p_creator: org.C, p_amount_minor: 100, p_vat_minor: 0,
      p_method: "bank_transfer", p_paid_on: null, p_reference: null, p_idempotency_key: null })).rejects.toThrow(/forbidden/);
    await expect(report(3_000)).rejects.toThrow(/invalid_amount/);          // includes the pending 1 000 → refused
    const r1 = await report(1_000, "k-1");                                 // creator not verified → no VAT (see creator-tax)
    expect(Number(r1.remaining_minor)).toBe(1_000);
    expect((await report(1_000, "k-1")).duplicate).toBe(true);             // double submit → same report
    const b = await bal();
    expect(Number(b.outstanding_minor)).toBe(1_000);
    expect(Math.round((Date.parse(b.due_at) - Date.now()) / 86_400_000)).toBe(4);   // now the 10-day-old approval
    expect(await q(`select count(*)::int n, sum(vat_minor)::int v from creator_payouts`)).toEqual([{ n: 1, v: 0 }]);
    await expect(q(`update creator_payouts set amount_minor = 1`)).rejects.toThrow(/append_only/);
    await expect(q(`delete from creator_payouts`)).rejects.toThrow(/append_only/);
  });
  it("creator confirms or reports not received; the store answers; a disputed report can still be confirmed later", async () => {
    const p = (await q<{ id: string }>(`select id from creator_payouts`))[0]!.id;
    await expect(rpc(u.s!, "respond_creator_payout", { p_payout: p, p_confirm: true })).rejects.toThrow(/forbidden/);
    await rpc(u.c!, "respond_creator_payout", { p_payout: p, p_confirm: false, p_reason: "nothing arrived in my account" });
    await rpc(u.s!, "answer_payout_dispute", { p_payout: p, p_response: "Sent on Monday, reference TR-1000, proof attached" });
    await rpc(u.s!, "attach_payout_proof", { p_payout: p, p_filename: "transfer.pdf", p_mime: "application/pdf", p_base64: Buffer.from("%PDF-1.4 proof").toString("base64") });
    await expect(rpc(u.s!, "attach_payout_proof", { p_payout: p, p_filename: "x.exe", p_mime: "application/x-msdownload", p_base64: "AA==" })).rejects.toThrow(/invalid_input/);
    const proof = (await q<{ id: string }>(`select id from payout_proofs`))[0]!.id;
    expect((await rpc(u.c!, "get_payout_proof", { p_proof: proof })).filename).toBe("transfer.pdf");
    await expect(rpc(u.x!, "get_payout_proof", { p_proof: proof })).rejects.toThrow(/forbidden/);
    await rpc(u.c!, "respond_creator_payout", { p_payout: p, p_confirm: true });
    expect(Number((await bal(u.c!)).confirmed_minor)).toBe(1_000);
    await expect(rpc(u.s!, "withdraw_creator_payout", { p_payout: p, p_note: "x" })).rejects.toThrow(/not_withdrawable/);
  });
  it("a report made by mistake is withdrawn, kept in history, and the balance returns", async () => {
    const r = await report(1_000, "k-2");
    expect(Number((await bal()).outstanding_minor)).toBe(0);
    await expect(report(1)).rejects.toThrow(/nothing_to_pay/);
    await rpc(u.s!, "withdraw_creator_payout", { p_payout: r.payout_id, p_note: "transfer bounced" });
    expect(Number((await bal()).outstanding_minor)).toBe(1_000);
    expect(await q(`select count(*)::int n from creator_payouts`)).toEqual([{ n: 2 }]);
    await expect(rpc(u.s!, "withdraw_creator_payout", { p_payout: r.payout_id, p_note: "again" })).rejects.toThrow(/not_withdrawable/);
  });
  it("a refund after payment shows as a negative balance (credit), never as money to pay", async () => {
    await report(1_000, "k-3");                                             // o3 matured meanwhile: everything approved is now paid
    for (const o of ["o1", "o2", "o3"]) await sale(o, 11_800, [{ id: "r-" + o, amount: 11_800 }], "refunded");
    await rpc(svc, "approve_matured_commissions");
    await backdate(`update commission_ledger set state = 'approved', approved_at = now() where state = 'pending' and party_role = 'creator'`);
    const b = await bal();
    expect(Number(b.outstanding_minor)).toBe(0);
    expect(Number(b.balance_minor)).toBeLessThan(0);
  });
});

describe("payment details are protected", () => {
  it("only the creator edits them; a store sees them only to pay an outstanding balance, and every view is audited", async () => {
    await expect(rpc(u.c!, "save_payout_details", { p_org: org.C, p_method: "bank_transfer", p_holder: "Creator C", p_bank: "12",
      p_branch: "", p_account: "", p_phone: null, p_link: null })).rejects.toThrow(/invalid_input/);
    await rpc(u.c!, "save_payout_details", { p_org: org.C, p_method: "bank_transfer", p_holder: "Creator C", p_bank: "12",
      p_branch: "634", p_account: "123456", p_phone: null, p_link: null });
    await expect(rpc(u.s!, "save_payout_details", { p_org: org.S, p_method: "bit", p_holder: null, p_bank: null, p_branch: null, p_account: null,
      p_phone: "0501234567", p_link: null })).rejects.toThrow(/forbidden/);
    await expect(db.as(u.s!, `select 1 from creator_payout_details`)).rejects.toThrow(/permission denied/);
    await expect(db.as(u.c!, `select 1 from creator_payout_details`)).rejects.toThrow(/permission denied/);
    await expect(rpc(u.s!, "payee_details", { p_store: org.S, p_creator: org.C })).rejects.toThrow(/nothing_to_pay/);   // nothing outstanding now
    await expect(rpc(u.x!, "payee_details", { p_store: org.X, p_creator: org.C })).rejects.toThrow(/forbidden/);       // no collaboration
    for (const o of ["o4", "o5", "o6"]) await sale(o);
    await backdate(`update orders set completed_at = now() - interval '40 days' where external_order_id in ('o4', 'o5', 'o6')`);
    await rpc(svc, "approve_matured_commissions");
    const d = await rpc(u.s!, "payee_details", { p_store: org.S, p_creator: org.C });
    expect(d).toMatchObject({ method: "bank_transfer", bank_code: "12", branch: "634", account_number: "123456" });
    expect(await q(`select count(*)::int n from audit_events where action = 'payout_details.viewed'`)).toEqual([{ n: 1 }]);
  });
});

describe("statement and reminders", () => {
  it("both sides get the same statement; outsiders get nothing", async () => {
    const s1 = await rpc(u.s!, "creator_statement", { p_store: org.S, p_creator: org.C });
    const s2 = await rpc(u.c!, "creator_statement", { p_store: org.S, p_creator: org.C });
    expect(s1.lines.length).toBe(s2.lines.length);
    expect(s1.lines.length).toBeGreaterThanOrEqual(4);
    expect(s1.payments.map((p: any) => p.status)).toEqual(["confirmed", "withdrawn", "awaiting"]);
    expect(s1.payments[0].proofs).toHaveLength(1);
    await expect(rpc(u.x!, "creator_statement", { p_store: org.S, p_creator: org.C })).rejects.toThrow(/forbidden/);
  });
  it("due-soon and overdue reminders go to both sides once per due date", async () => {
    await backdate(`update commission_ledger set approved_at = now() - interval '30 days' where party_role = 'creator' and state = 'approved'`);
    expect(await rpc(svc, "creator_payment_reminders")).toBe(1);
    expect(await rpc(svc, "creator_payment_reminders")).toBe(0);
    expect(await q(`select org_id from notifications where kind = 'payout_overdue' order by org_id`)).toHaveLength(2);
  });
});
