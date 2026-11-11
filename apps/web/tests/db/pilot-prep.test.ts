import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";

/** Pilot preparation: VAT + delivery/due dates, per-store fee terms, legal acceptance, payout due dates. */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const anon: Who = { role: "anon" };
const u: Record<string, Who> = {};
const org: Record<string, string> = {};
const conn: Record<string, string> = {};
let code = "";

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
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const month = (back: number) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1)).toISOString().slice(0, 10); };
const sale = (store: string, id: string, total = 11_800, occurred = new Date(Date.now() + ++seq).toISOString()) =>
  rpc(svc, "ingest_order_event", { p_connection: conn[store], p_event: JSON.stringify({ event_id: `pp-${++seq}`, occurred_at: occurred,
    order: { id, status: "completed", currency: "ILS", total, tax: 0, shipping: 0, shipping_tax: 0, coupons: [code], created_at: new Date().toISOString(), refunds: [] } }) });
const feeOf = async (id: string) => (await q<{ f: number }>(`select a.platform_fee_bps f from attributions a join orders o on o.id = a.order_id where o.external_order_id = $1`, [id]))[0]!.f;

beforeAll(async () => {
  db = await createDb();
  for (const k of ["s", "c", "admin", "staff", "late", "x"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@pp.test`) };
  await q(`insert into platform_admins(user_id) values ($1)`, [(u.admin as any).userId]);
  org.S = await rpc(u.s!, "create_organization", { p_type: "store", p_name: "Store S" });
  org.C = await rpc(u.c!, "create_organization", { p_type: "creator", p_name: "Creator C" });
  conn.S = (await rpc(u.s!, "create_store_connection", { p_org: org.S, p_site_url: "s.co.il" })).connection_id;
  await rpc(svc, "plugin_sync", { p_connection: conn.S, p_plugin_version: "0.3.1" });
  const opp = await rpc(u.s!, "save_standing_opportunity", { p_store: org.S, p_title: "Store S offer", p_description: null,
    p_commission_bps: 1000, p_coupon_pct: 10, p_auto_approve: true, p_status: "live" });
  code = (await rpc(u.c!, "join_opportunity", { p_opportunity: opp, p_creator: org.C })).code;
  const t = (await rpc(u.s!, "invite_team_member", { p_org: org.S, p_email: "staff@pp.test", p_role: "member" })).token;
  await rpc(u.staff!, "accept_team_invite", { p_token: t });
}, 60_000);

describe("fee terms (locked per store)", () => {
  it("activation snapshots the promised terms: founders 2% until the end date, then standard 3%", async () => {
    const t = await q(`select kind, fee_bps, effective_until is not null as has_end, status from fee_terms where store_org_id = $1 order by effective_from`, [org.S]);
    expect(t).toEqual([{ kind: "founders", fee_bps: 200, has_end: true, status: "active" }, { kind: "standard", fee_bps: 300, has_end: false, status: "active" }]);
    await sale("S", "f-1");
    expect(await feeOf("f-1")).toBe(200);
  });
  it("new-store pricing changes only affect stores activated afterwards", async () => {
    await expect(rpc(u.s!, "set_new_store_pricing", { p_founders_bps: 150, p_founders_months: 3, p_standard_bps: 250, p_note: "x" })).rejects.toThrow(/forbidden/);
    await rpc(u.admin!, "set_new_store_pricing", { p_founders_bps: 150, p_founders_months: 3, p_standard_bps: 250, p_note: "pilot test" });
    expect(await q(`select fee_bps from fee_terms where store_org_id = $1 order by effective_from`, [org.S])).toEqual([{ fee_bps: 200 }, { fee_bps: 300 }]);
    org.N = await rpc(u.late!, "create_organization", { p_type: "store", p_name: "Late Store" });
    const k = await rpc(u.late!, "create_store_connection", { p_org: org.N, p_site_url: "late.co.il" });
    // Terms lock at the first verified connection (approved 11.11.2026), not when the key is issued.
    expect(await q(`select fee_bps from fee_terms where store_org_id = $1`, [org.N])).toEqual([]);
    await rpc({ role: "service_role" } as any, "plugin_sync", { p_connection: k.connection_id, p_plugin_version: "0.4.1" });
    expect(await q(`select fee_bps from fee_terms where store_org_id = $1 order by effective_from`, [org.N])).toEqual([{ fee_bps: 150 }, { fee_bps: 250 }]);
    await sale("S", "f-2");
    expect(await feeOf("f-2")).toBe(200); // existing store unaffected
    await rpc(u.admin!, "set_new_store_pricing", { p_founders_bps: 200, p_founders_months: 6, p_standard_bps: 300, p_note: "restore" });
  });
  it("a standard-rate change needs at least 30 days' notice and starts only after the founders period", async () => {
    await expect(rpc(u.admin!, "schedule_standard_rate_change", { p_new_bps: 350, p_effective_from: inDays(10), p_note: "x" })).rejects.toThrow(/notice_too_short/);
    expect(await rpc(u.admin!, "schedule_standard_rate_change", { p_new_bps: 350, p_effective_from: inDays(31), p_note: "increase" })).toBeGreaterThan(0);
    const p = (await q(`select status, effective_from > now() + interval '170 days' as after_founders from fee_terms where store_org_id = $1 and source = 'rate_change'`, [org.S]))[0];
    expect(p).toEqual({ status: "proposed", after_founders: true });
    expect(await db.as(u.s!, `select kind from notifications where org_id = $1 and kind = 'fee_change_notice'`, [org.S])).toHaveLength(1);
  });
  it("an increase never applies without explicit acceptance (silence ≠ consent); declining keeps the current rate", async () => {
    const term = (await q<{ id: string }>(`select id from fee_terms where store_org_id = $1 and source = 'rate_change'`, [org.S]))[0]!.id;
    const far = new Date(Date.now() + 400 * 86_400_000).toISOString();
    expect((await q(`select public.fee_bps_at($1, $2) f`, [org.S, far]))[0].f).toBe(300);   // proposed, not answered
    await expect(rpc(u.staff!, "respond_fee_change", { p_term: term, p_accept: true })).rejects.toThrow(/forbidden/);
    await rpc(u.s!, "respond_fee_change", { p_term: term, p_accept: false });
    expect((await q(`select public.fee_bps_at($1, $2) f`, [org.S, far]))[0].f).toBe(300);
    await expect(rpc(u.s!, "respond_fee_change", { p_term: term, p_accept: true })).rejects.toThrow(/already_decided/);
    expect(await q(`select action from audit_events where action = 'pricing.change_declined'`)).toHaveLength(1);
  });
  it("accepted changes apply from their date only; past sales keep their rate; decreases apply automatically", async () => {
    await rpc(u.admin!, "schedule_standard_rate_change", { p_new_bps: 280, p_effective_from: inDays(31), p_note: "decrease" });
    const dec = (await q(`select status from fee_terms where store_org_id = $1 and fee_bps = 280`, [org.S]))[0];
    expect(dec).toEqual({ status: "active" });
    // bring the store past its founders period and the decrease into force (test-only time travel)
    await backdate(`update fee_terms set effective_until = now() - interval '2 days' where store_org_id = $1 and kind = 'founders'`, [org.S]);
    await backdate(`update fee_terms set effective_from = now() - interval '2 days' where store_org_id = $1 and kind = 'standard' and source <> 'rate_change'`, [org.S]);
    await backdate(`update fee_terms set effective_from = now() - interval '1 day' where store_org_id = $1 and fee_bps = 280`, [org.S]);
    await sale("S", "f-3");
    expect(await feeOf("f-3")).toBe(280);
    expect(await feeOf("f-1")).toBe(200); // history untouched
  });
  it("an individual agreement wins from its date; it needs a documented note", async () => {
    await expect(rpc(u.admin!, "set_individual_fee", { p_store: org.S, p_fee_bps: 100, p_effective_from: new Date().toISOString(), p_effective_until: null, p_note: "" }))
      .rejects.toThrow(/note_required/);
    await expect(rpc(u.admin!, "set_individual_fee", { p_store: org.S, p_fee_bps: 100, p_effective_from: ago(5), p_effective_until: null, p_note: "x" }))
      .rejects.toThrow(/invalid_dates/);
    await rpc(u.admin!, "set_individual_fee", { p_store: org.S, p_fee_bps: 100, p_effective_from: new Date().toISOString(), p_effective_until: null, p_note: "signed agreement #1" });
    await sale("S", "f-4");
    expect(await feeOf("f-4")).toBe(100);
  });
  it("fee terms are history: never deleted or rewritten; visible to store admins only", async () => {
    await expect(q(`delete from fee_terms where store_org_id = $1`, [org.S])).rejects.toThrow(/append_only/);
    await expect(q(`update fee_terms set fee_bps = 1 where store_org_id = $1`, [org.S])).rejects.toThrow(/append_only/);
    const v = await rpc(u.s!, "store_fee_terms", { p_store: org.S });
    expect(v.current_bps).toBe(100);
    expect(v.vat_bps).toBe(1800);
    await expect(rpc(u.staff!, "store_fee_terms", { p_store: org.S })).rejects.toThrow(/forbidden/);
    expect(await db.as(u.staff!, `select 1 from fee_terms`)).toHaveLength(0);
  });
});

describe("payment requests: VAT, delivery, due date, gate", () => {
  it("real requests are blocked until the tax rules are approved; preview shows fee, VAT and offset", async () => {
    await rpc(svc, "approve_matured_commissions");
    await sale("S", "v-1", 118_000, ago(20)); // base 100 000 → fee at 1% individual = 1 000
    await rpc(svc, "approve_matured_commissions");
    await backdate(`update commission_ledger set approved_at = $1 where state = 'approved'`, [`${month(1)}T12:00:00Z`]);
    await expect(rpc(u.admin!, "generate_invoices", { p_period_start: month(1) })).rejects.toThrow(/invoicing_not_approved/);
    const pv = await rpc(u.admin!, "preview_invoices", { p_period_start: month(1) });
    const row = pv.find((x: any) => x.store === "Store S");
    expect(row.vat_bps).toBe(1800);
    expect(Number(row.vat_minor)).toBe(Math.round(Number(row.fees_minor) * 0.18));
    expect(await q(`select 1 from invoices`)).toHaveLength(0);
    await expect(rpc(u.s!, "preview_invoices", { p_period_start: month(1) })).rejects.toThrow(/forbidden/);
  });
  it("after approval: VAT captured at issue, no due date until delivery is recorded", async () => {
    await q(`update app_settings set value = 'true' where key = 'invoicing_tax_approved'`);
    await rpc(u.admin!, "generate_invoices", { p_period_start: month(1) });
    const i = (await q(`select * from invoices where store_org_id = $1`, [org.S]))[0];
    expect(Number(i.vat_bps)).toBe(1800);
    expect(Number(i.total_minor)).toBe(Number(i.fees_minor) + Number(i.vat_minor) - Number(i.credit_minor));
    expect(i.delivered_at).toBeNull();
    expect(i.due_at).toBeNull();
  });
  it("recording verified delivery sets the due date to delivery + 14 days; only once; never in the future", async () => {
    const id = (await q<{ id: string }>(`select id from invoices where store_org_id = $1`, [org.S]))[0]!.id;
    await expect(rpc(u.s!, "mark_invoice_delivered", { p_invoice: id, p_method: "email", p_reference: "x" })).rejects.toThrow(/forbidden/);
    await expect(rpc(u.admin!, "mark_invoice_delivered", { p_invoice: id, p_method: "email", p_reference: "x", p_delivered_at: inDays(2) })).rejects.toThrow(/invalid_dates/);
    const due = await rpc(u.admin!, "mark_invoice_delivered", { p_invoice: id, p_method: "email", p_reference: "sent to owner" });
    const i = (await q(`select delivered_at, due_at, delivery_method from invoices where id = $1`, [id]))[0];
    expect(Math.round((new Date(i.due_at).getTime() - new Date(i.delivered_at).getTime()) / 86_400_000)).toBe(14);
    expect(new Date(due).toISOString()).toBe(new Date(i.due_at).toISOString());
    await expect(rpc(u.admin!, "mark_invoice_delivered", { p_invoice: id, p_method: "email", p_reference: "again" })).rejects.toThrow(/invoice_not_deliverable/);
  });
  it("FOUNDING PARTNERS still uses the fee actually collected without VAT", async () => {
    const r = (await q(`select coalesce(sum(ii.amount_minor), 0)::int as items, i.fees_minor::int as fees from invoices i join invoice_items ii on ii.invoice_id = i.id where i.store_org_id = $1 group by i.fees_minor`, [org.S]))[0];
    expect(r.items).toBe(r.fees); // items (reward base) = fee before VAT
  });
});

describe("creator payment due date", () => {
  it("due = approval + 14 days; overdue when passed and unpaid; never shown as paid", async () => {
    const b = (await rpc(u.s!, "payout_balances", { p_org: org.S })).find((x: any) => x.other_org_id === org.C);
    expect(Number(b.approved_unpaid_minor)).toBeGreaterThan(0);
    expect(b.overdue).toBe(true); // approvals were back-dated to last month
    expect(Number(b.paid_minor)).toBe(0);
    await rpc(u.s!, "record_creator_payout", { p_store: org.S, p_creator: org.C, p_method: "bit", p_reference: "T" });
    const b2 = (await rpc(u.s!, "payout_balances", { p_org: org.S })).find((x: any) => x.other_org_id === org.C);
    expect(b2.overdue).toBe(false);
    expect(b2.due_at).toBeNull();
  });
});

describe("legal documents & acceptance", () => {
  it("nothing is required while no document is published", async () => {
    expect(await rpc(u.x!, "legal_pending", { p_context: "signup" })).toEqual([]);
  });
  it("drafts are invisible; published versions are public and immutable", async () => {
    await rpc(u.admin!, "save_legal_document", { p_key: "terms", p_locale: "he", p_version: 1, p_title: "תנאי שימוש", p_body: "טיוטה לבדיקה בלבד",
      p_audience: "all", p_sort: 1, p_requires_reacceptance: false, p_effective_from: null, p_publish: false });
    expect(await db.as(anon, `select 1 from legal_documents`)).toHaveLength(0);
    expect(await rpc(u.x!, "legal_pending", { p_context: "signup" })).toEqual([]);
    await rpc(u.admin!, "save_legal_document", { p_key: "terms", p_locale: "he", p_version: 1, p_title: "תנאי שימוש", p_body: "נוסח לבדיקה בלבד",
      p_audience: "all", p_sort: 1, p_requires_reacceptance: false, p_effective_from: null, p_publish: true });
    expect(await db.as(anon, `select doc_key from legal_documents`)).toEqual([{ doc_key: "terms" }]);
    await expect(q(`update legal_documents set body = 'changed' where doc_key = 'terms'`)).rejects.toThrow(/append_only/);
    await expect(rpc(u.s!, "save_legal_document", { p_key: "x", p_locale: "he", p_version: 1, p_title: "xx", p_body: "xxxxxxxxxxxx",
      p_audience: "all", p_sort: 1, p_requires_reacceptance: false, p_effective_from: null, p_publish: true })).rejects.toThrow(/forbidden/);
  });
  it("signing up (creating an activity) requires documented acceptance", async () => {
    await expect(rpc(u.x!, "create_organization", { p_type: "creator", p_name: "No Accept" })).rejects.toThrow(/legal_acceptance_required/);
    expect(await rpc(u.x!, "accept_legal", { p_doc_keys: ["terms"], p_type: "signup" })).toBe(1);
    expect(await rpc(u.x!, "create_organization", { p_type: "creator", p_name: "Accepted" })).toBeTruthy();
    const a = (await rpc(u.x!, "my_legal_acceptances"))[0];
    expect(a).toMatchObject({ doc_key: "terms", version: 1, type: "signup" });
  });
  it("connecting a store requires accepting the commercial terms", async () => {
    await rpc(u.admin!, "save_legal_document", { p_key: "store-terms", p_locale: "he", p_version: 1, p_title: "תנאים מסחריים לחנויות", p_body: "נוסח לבדיקה בלבד",
      p_audience: "store", p_sort: 2, p_requires_reacceptance: false, p_effective_from: null, p_publish: true });
    await rpc(u.x!, "accept_legal", { p_doc_keys: ["terms"], p_type: "signup" });
    const st = await rpc(u.x!, "create_organization", { p_type: "store", p_name: "X Store" });
    await expect(rpc(u.x!, "create_store_connection", { p_org: st, p_site_url: "xs.co.il" })).rejects.toThrow(/legal_acceptance_required/);
    await rpc(u.x!, "accept_legal", { p_doc_keys: ["store-terms"], p_type: "store_connection", p_org: st });
    expect((await rpc(u.x!, "create_store_connection", { p_org: st, p_site_url: "xs.co.il" })).connection_id).toBeTruthy();
  });
  it("existing users see pending documents once; minor versions don't ask again; material changes do", async () => {
    const pend = await rpc(u.s!, "legal_pending", { p_context: "any" });
    expect(pend.map((d: any) => d.doc_key).sort()).toEqual(["store-terms", "terms"]);
    await rpc(u.s!, "accept_legal", { p_doc_keys: ["terms", "store-terms"], p_type: "existing_user" });
    expect(await rpc(u.s!, "legal_pending", { p_context: "any" })).toEqual([]);
    await rpc(u.admin!, "save_legal_document", { p_key: "terms", p_locale: "he", p_version: 2, p_title: "תנאי שימוש", p_body: "תיקון ניסוח קטן",
      p_audience: "all", p_sort: 1, p_requires_reacceptance: false, p_effective_from: null, p_publish: true });
    expect(await rpc(u.s!, "legal_pending", { p_context: "any" })).toEqual([]);
    await rpc(u.admin!, "save_legal_document", { p_key: "terms", p_locale: "he", p_version: 3, p_title: "תנאי שימוש", p_body: "שינוי מהותי",
      p_audience: "all", p_sort: 1, p_requires_reacceptance: true, p_effective_from: null, p_publish: true });
    const again = await rpc(u.s!, "legal_pending", { p_context: "any" });
    expect(again).toEqual([expect.objectContaining({ doc_key: "terms", version: 3, reacceptance: true })]);
    await expect(q(`delete from legal_acceptances`)).rejects.toThrow(/append_only|forbid/);
  });
});
