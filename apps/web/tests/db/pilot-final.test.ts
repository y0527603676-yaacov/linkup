import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";

/** Final pilot items: rate-notice delivery records, admin-planned wind-down (blocked until the legal rule is set),
 *  settlements blocked until the accounting decisions are made. */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const u: Record<string, Who> = {};
const org: Record<string, string> = {};
let conn = "";
let code = "";
let term = "";

const rpc = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  const row = await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
  return row.r;
};
const q = <T = any>(sql: string, p: unknown[] = []) => db.as<T>(owner, sql, p);
const backdate = (sql: string, p: unknown[] = []) =>
  db.transaction(async (tx) => { await tx.exec(`set local session_replication_role = replica`); await tx.query(sql, p); });
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
let seq = 0;
const sale = (id: string) => rpc(svc, "ingest_order_event", { p_connection: conn, p_event: JSON.stringify({ event_id: `pf-${++seq}`, occurred_at: new Date().toISOString(),
  order: { id, status: "completed", currency: "ILS", total: 11_800, tax: 1_800, shipping: 0, shipping_tax: 0, coupons: [code], created_at: new Date().toISOString(), refunds: [] } }) });

beforeAll(async () => {
  db = await createDb();
  for (const k of ["s", "c", "admin"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@pf.test`) };
  await q(`insert into platform_admins(user_id) values ($1)`, [(u.admin as any).userId]);
  org.S = await rpc(u.s!, "create_organization", { p_type: "store", p_name: "Store S" });
  org.C = await rpc(u.c!, "create_organization", { p_type: "creator", p_name: "Creator C" });
  conn = (await rpc(u.s!, "create_store_connection", { p_org: org.S, p_site_url: "s.co.il" })).connection_id;
  await rpc(svc, "plugin_sync", { p_connection: conn, p_plugin_version: "0.3.1" });
  const opp = await rpc(u.s!, "save_standing_opportunity", { p_store: org.S, p_title: "Store S offer", p_description: null,
    p_commission_bps: 1000, p_coupon_pct: 10, p_auto_approve: true, p_status: "live" });
  code = (await rpc(u.c!, "join_opportunity", { p_opportunity: opp, p_creator: org.C })).code;
  // past the founders period, standard 3% in force
  await backdate(`update fee_terms set effective_until = now() - interval '60 days' where store_org_id = $1 and kind = 'founders'`, [org.S]);
  await backdate(`update fee_terms set effective_from = now() - interval '60 days' where store_org_id = $1 and kind = 'standard'`, [org.S]);
}, 60_000);

describe("rate-increase notice delivery", () => {
  it("each proposal records its creation; sending and delivery are recorded with channel, recipient and reference", async () => {
    await rpc(u.admin!, "schedule_standard_rate_change", { p_new_bps: 350, p_effective_from: inDays(31), p_note: "increase" });
    term = (await q(`select id from fee_terms where store_org_id = $1 and source = 'rate_change'`, [org.S]))[0].id;
    expect(await q(`select event, channel from fee_change_notices where term_id = $1`, [term])).toEqual([{ event: "created", channel: "in_app" }]);
    await expect(rpc(u.s!, "record_fee_notice", { p_term: term, p_event: "sent", p_channel: "email", p_recipient: "s@pf.test", p_reference: "x" })).rejects.toThrow(/forbidden/);
    await rpc(u.admin!, "record_fee_notice", { p_term: term, p_event: "sent", p_channel: "email", p_recipient: "s@pf.test", p_reference: "msg-1" });
    await expect(rpc(u.admin!, "record_fee_notice", { p_term: term, p_event: "delivered", p_channel: "email", p_recipient: "s@pf.test", p_reference: " " })).rejects.toThrow(/note_required/);
    await expect(rpc(u.admin!, "record_fee_notice", { p_term: term, p_event: "delivered", p_channel: "email", p_recipient: "s@pf.test", p_reference: "x", p_occurred_at: inDays(1) })).rejects.toThrow(/invalid_dates/);
    await expect(q(`delete from fee_change_notices`)).rejects.toThrow(/append_only/);
  });
  it("without proven delivery the store cannot accept and nothing applies or pauses", async () => {
    await expect(rpc(u.s!, "respond_fee_change", { p_term: term, p_accept: true })).rejects.toThrow(/notice_not_delivered/);
    expect((await q(`select public.fee_term_start($1) s`, [term]))[0].s).toBeNull();
    await backdate(`update fee_terms set effective_from = now() - interval '1 day' where id = $1`, [term]);
    expect(await q(`select public.store_new_activity_blocked($1) b`, [org.S])).toEqual([{ b: false }]);
    await sale("n-1");
    expect((await q(`select a.platform_fee_bps f from attributions a join orders o on o.id = a.order_id where o.external_order_id = 'n-1'`))[0].f).toBe(300);
  });
  it("the 30 days run from proven delivery: a late delivery moves the earliest start; acceptance applies only from then", async () => {
    await rpc(u.admin!, "record_fee_notice", { p_term: term, p_event: "delivered", p_channel: "email", p_recipient: "s@pf.test", p_reference: "delivery receipt #77" });
    const start = new Date((await q(`select public.fee_term_start($1) s`, [term]))[0].s).getTime();
    expect(Math.round((start - Date.now()) / 86_400_000)).toBe(30);     // stated date passed; delivery today → +30 days
    const t = await rpc(u.s!, "store_fee_terms", { p_store: org.S });
    expect(t.terms.find((x: any) => x.id === term).starts_at).toBeTruthy();
    await rpc(u.s!, "respond_fee_change", { p_term: term, p_accept: true });
    const active = (await q(`select fee_bps, effective_from from fee_terms where store_org_id = $1 and source = 'rate_change' and status = 'active'`, [org.S]))[0];
    expect(active.fee_bps).toBe(350);
    expect(Math.round((new Date(active.effective_from).getTime() - Date.now()) / 86_400_000)).toBe(30);
    expect((await q(`select public.fee_bps_at($1, now()) f`, [org.S]))[0].f).toBe(300);              // not yet
    expect((await q(`select public.fee_bps_at($1, now() + interval '31 days') f`, [org.S]))[0].f).toBe(350);
  });
});

describe("orderly wind-down after a refusal", () => {
  it("is refused while the legal notice rule is undecided; never automatic; keeps all history", async () => {
    await rpc(u.admin!, "schedule_standard_rate_change", { p_new_bps: 450, p_effective_from: inDays(60), p_note: "second increase" });
    const t2 = (await q(`select id from fee_terms where store_org_id = $1 and fee_bps = 450`, [org.S]))[0].id;
    await expect(rpc(u.admin!, "plan_collaboration_wind_down", { p_term: t2, p_end_at: inDays(90), p_note: "after refusal" })).rejects.toThrow(/wind_down_not_allowed/);
    await rpc(u.s!, "respond_fee_change", { p_term: t2, p_accept: false });
    await expect(rpc(u.admin!, "plan_collaboration_wind_down", { p_term: t2, p_end_at: inDays(90), p_note: "after refusal" })).rejects.toThrow(/wind_down_rule_undecided/);
    // Once counsel sets the rule (test value only), planning works and gives advance notice to store and creators.
    await q(`insert into app_settings(key, value) values ('wind_down_notice_days', '30')`);
    await expect(rpc(u.admin!, "plan_collaboration_wind_down", { p_term: t2, p_end_at: inDays(10), p_note: "too soon" })).rejects.toThrow(/notice_too_short/);
    const plan = await rpc(u.admin!, "plan_collaboration_wind_down", { p_term: t2, p_end_at: inDays(45), p_note: "orderly end after refusal" });
    expect(await q(`select org_id from notifications where kind = 'wind_down_planned' order by org_id`)).toHaveLength(2);
    expect(await q(`select status from agreements where store_org_id = $1`, [org.S])).toEqual([{ status: "active" }]);   // nothing ends by itself
    await expect(rpc(u.admin!, "complete_collaboration_wind_down", { p_plan: plan })).rejects.toThrow(/wind_down_not_due/);
    await backdate(`update collaboration_wind_downs set end_at = now() - interval '1 minute' where id = $1`, [plan]);
    const before = await q(`select count(*)::int n, sum(amount_minor)::int s from commission_ledger`);
    expect(await rpc(u.admin!, "complete_collaboration_wind_down", { p_plan: plan })).toBe(1);
    expect(await q(`select status from agreements where store_org_id = $1`, [org.S])).toEqual([{ status: "ended" }]);
    expect(await q(`select count(*)::int n, sum(amount_minor)::int s from commission_ledger`)).toEqual(before);   // accrued commissions untouched
    expect(await q(`select active from partner_codes where code = $1`, [code])).toEqual([{ active: true }]);       // no coupon touched
    await sale("after-end");
    expect(await q(`select 1 from attributions a join orders o on o.id = a.order_id where o.external_order_id = 'after-end'`)).toHaveLength(0);
    await expect(q(`delete from collaboration_wind_downs`)).rejects.toThrow(/append_only/);
  });
});

describe("settlements awaiting accounting decisions", () => {
  it("offsets and cash reward transfers stay blocked by default; rewards remain in the wallet", async () => {
    expect(await q(`select value from app_settings where key = 'reward_settlement_approved'`)).toEqual([{ value: false }]);
    await rpc(u.s!, "save_tax_profile", { p_org: org.S, p_legal_name: "Store S Ltd", p_classification: "company", p_tax_id: "512222222", p_address: "Haifa", p_country: "IL" });
    await rpc(u.admin!, "verify_tax_profile", { p_org: org.S, p_zero_rate: false });
    expect((await q(`select public.reward_vat_bps($1) r`, [org.S]))[0].r).toBeNull();
    await backdate(`insert into referral_rewards(referral_id, referrer_org_id, ledger_id, attribution_id, share_bps, amount_minor, currency, idempotency_key)
                    select gen_random_uuid(), $1, id, attribution_id, 4000, 20000, 'ILS', 'pf:w' from commission_ledger where party_role = 'platform' limit 1`, [org.S]);
    await expect(rpc(u.admin!, "record_reward_transfer", { p_org: org.S, p_currency: "ILS", p_reference: "B", p_doc_type: "tax_invoice",
      p_doc_number: "1", p_doc_date: null })).rejects.toThrow(/accounting_decision_pending/);
    // Payment request: VAT on the fee as usual, but no offset taken.
    await q(`update app_settings set value = 'true' where key = 'invoicing_tax_approved'`);
    await backdate(`update commission_ledger set state = 'approved', approved_at = date_trunc('month', now()) - interval '10 days' where party_role = 'platform'`);
    const d = new Date(); const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
    await rpc(u.admin!, "generate_invoices", { p_period_start: prev });
    const i = (await q(`select credit_minor::int c, reward_offset_minor::int r from invoices where store_org_id = $1`, [org.S]))[0];
    expect(i).toEqual({ c: 0, r: 0 });
    expect(Number((await q(`select public.wallet_balance_minor($1, 'ILS') b`, [org.S]))[0].b)).toBe(20_000);
  });
});
