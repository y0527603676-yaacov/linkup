import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";

/** Legal package v1.0 (Appendix A): drafts, publication, documented acceptance, rate-increase wind-down,
 *  payment-request disputes, itemised base, manual withholding, contact form. */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const anon: Who = { role: "anon" };
const u: Record<string, Who> = {};
const org: Record<string, string> = {};
const conn: Record<string, string> = {};
let code = "";
let inv = "";

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
const sale = (id: string, occurred = new Date().toISOString(), total = 11_800) =>
  rpc(svc, "ingest_order_event", { p_connection: conn.S, p_event: JSON.stringify({ event_id: `lp-${++seq}`, occurred_at: occurred,
    order: { id, status: "completed", currency: "ILS", total, tax: 1_800, shipping: 0, shipping_tax: 0, coupons: [code], created_at: new Date().toISOString(), refunds: [] } }) });
const feeOf = async (id: string) => (await q<{ f: number }>(`select a.platform_fee_bps f from attributions a join orders o on o.id = a.order_id where o.external_order_id = $1`, [id]))[0]?.f;

beforeAll(async () => {
  db = await createDb();
  for (const k of ["s", "c", "c2", "admin", "staff", "x", "en"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@lp.test`) };
  await q(`insert into platform_admins(user_id) values ($1)`, [(u.admin as any).userId]);
  // Existing activity created before any document is published (no acceptance needed yet).
  org.S = await rpc(u.s!, "create_organization", { p_type: "store", p_name: "Store S" });
  org.C = await rpc(u.c!, "create_organization", { p_type: "creator", p_name: "Creator C" });
  conn.S = (await rpc(u.s!, "create_store_connection", { p_org: org.S, p_site_url: "s.co.il" })).connection_id;
  await rpc(svc, "plugin_sync", { p_connection: conn.S, p_plugin_version: "0.3.1" });
  const opp = await rpc(u.s!, "save_standing_opportunity", { p_store: org.S, p_title: "Store S offer", p_description: null,
    p_commission_bps: 1000, p_coupon_pct: 10, p_auto_approve: true, p_status: "live" });
  code = (await rpc(u.c!, "join_opportunity", { p_opportunity: opp, p_creator: org.C })).code;
  const t = (await rpc(u.s!, "invite_team_member", { p_org: org.S, p_email: "staff@lp.test", p_role: "member" })).token;
  await rpc(u.staff!, "accept_team_invite", { p_token: t });
  await q(`update app_settings set value = 'true' where key = 'reward_settlement_approved'`); // as if the accountant had approved settlement
}, 60_000);

describe("legal documents v1.0", () => {
  it("the seed loads all 8 documents in both languages as drafts only, verbatim from the source", async () => {
    const seed = readFileSync(join(__dirname, "../../../../supabase/seed/legal_documents_v1_draft.sql"), "utf8");
    await db.exec(seed);
    const rows = await q(`select doc_key, locale, status, audience from legal_documents order by sort_order, locale`);
    expect(rows).toHaveLength(16);
    expect(new Set(rows.map((r: any) => r.status))).toEqual(new Set(["draft"]));
    expect([...new Set(rows.map((r: any) => r.doc_key))]).toEqual(["terms", "store-terms", "creator-terms", "privacy", "commissions", "founding-partners", "cookies", "interface-notices"]);
    const src = readFileSync(join(__dirname, "../../../../docs/legal/LINKUP_legal_package_2026-11-10.md"), "utf8");
    const body = (await q(`select body from legal_documents where doc_key = 'store-terms' and locale = 'he'`))[0].body as string;
    expect(src.includes(body)).toBe(true);
    expect(body).toContain("אין ריבית או קנס שלא הוסכמו כדין");
    expect(await db.as(anon, `select 1 from legal_documents`)).toHaveLength(0);           // drafts are not public
    expect(await rpc(u.x!, "legal_pending", { p_context: "signup" })).toEqual([]);        // nothing required yet
    await expect(rpc(u.s!, "legal_admin_documents")).rejects.toThrow(/forbidden/);
    expect((await rpc(u.admin!, "legal_admin_documents")).length).toBe(16);
  });
  it("publication is an admin step that publishes the stored text unchanged; published text is immutable", async () => {
    await expect(rpc(u.s!, "publish_legal_version", { p_key: "terms", p_version: 1 })).rejects.toThrow(/forbidden/);
    for (const k of ["terms", "store-terms", "creator-terms", "privacy", "commissions", "founding-partners", "cookies", "interface-notices"])
      expect(await rpc(u.admin!, "publish_legal_version", { p_key: k, p_version: 1, p_effective_from: null })).toBe(2);
    expect(await db.as(anon, `select 1 from legal_documents where status = 'published'`)).toHaveLength(16);
    await expect(q(`update legal_documents set body = 'changed text here' where doc_key = 'terms' and locale = 'he'`)).rejects.toThrow(/append_only/);
    await expect(q(`delete from legal_documents where doc_key = 'terms'`)).rejects.toThrow(/append_only/);
  });
  it("creator sign-up requires general terms, privacy notice and creator terms; acceptance is fully documented", async () => {
    const pending = [...await rpc(u.c2!, "legal_pending", { p_context: "signup" }), ...await rpc(u.c2!, "legal_pending", { p_context: "creator" })];
    expect(pending.map((p: any) => p.doc_key).sort()).toEqual(["creator-terms", "privacy", "terms"]);
    await expect(rpc(u.c2!, "create_organization", { p_type: "creator", p_name: "New Creator" })).rejects.toThrow(/legal_acceptance_required/);
    await rpc(u.c2!, "accept_legal", { p_doc_keys: ["terms", "privacy"], p_type: "signup", p_org: null, p_locale: "en" });
    await expect(rpc(u.c2!, "create_organization", { p_type: "creator", p_name: "New Creator" })).rejects.toThrow(/legal_acceptance_required/);
    await rpc(u.c2!, "accept_legal", { p_doc_keys: ["creator-terms"], p_type: "signup", p_org: null, p_locale: "en" });
    expect(await rpc(u.c2!, "create_organization", { p_type: "creator", p_name: "New Creator" })).toBeTruthy();
    const acc = await q(`select a.doc_key, a.action, a.locale, a.role, a.version, a.audit_event_id is not null as audited, d.locale as doc_locale
                           from legal_acceptances a join legal_documents d on d.id = a.document_id where a.user_id = $1 order by a.doc_key`, [(u.c2 as any).userId]);
    expect(acc).toEqual([
      { doc_key: "creator-terms", action: "accept", locale: "en", role: "user", version: 1, audited: true, doc_locale: "en" },
      { doc_key: "privacy", action: "acknowledge", locale: "en", role: "user", version: 1, audited: true, doc_locale: "en" },  // a notice, not consent
      { doc_key: "terms", action: "accept", locale: "en", role: "user", version: 1, audited: true, doc_locale: "en" },
    ]);
    await expect(q(`delete from legal_acceptances`)).rejects.toThrow(/append_only/);
  });
  it("connecting a store requires the commercial terms and commissions policy, recorded with the store and role", async () => {
    await rpc(u.s!, "accept_legal", { p_doc_keys: ["terms", "privacy"], p_type: "existing_user", p_org: null, p_locale: "he" });
    await expect(rpc(u.s!, "create_store_connection", { p_org: org.S, p_site_url: "s.co.il" })).rejects.toThrow(/legal_acceptance_required/);
    await rpc(u.s!, "accept_legal", { p_doc_keys: ["store-terms", "commissions"], p_type: "store_connection", p_org: org.S, p_locale: "he" });
    expect((await rpc(u.s!, "create_store_connection", { p_org: org.S, p_site_url: "s.co.il" })).connection_id).toBeTruthy();
    expect(await q(`select doc_key, role from legal_acceptances where org_id = $1 order by doc_key`, [org.S]))
      .toEqual([{ doc_key: "commissions", role: "store:owner" }, { doc_key: "store-terms", role: "store:owner" }]);
    conn.S = (await q(`select id from store_connections where org_id = $1 and status <> 'revoked' order by created_at desc limit 1`, [org.S]))[0].id;
    await rpc(svc, "plugin_sync", { p_connection: conn.S, p_plugin_version: "0.3.1" });
  });
});

describe("rate increase without acceptance → orderly wind-down", () => {
  it("before the effective date nothing changes; after it, new activity with the store stops, existing deals keep the old rate", async () => {
    await rpc(u.admin!, "schedule_standard_rate_change", { p_new_bps: 400, p_effective_from: inDays(31), p_note: "test increase" });
    expect(await q(`select public.store_new_activity_blocked($1) b`, [org.S])).toEqual([{ b: false }]);
    // Founders period over and the proposal date reached, with no answer from the store.
    await backdate(`update fee_terms set effective_until = now() - interval '20 days' where store_org_id = $1 and kind = 'founders'`, [org.S]);
    await backdate(`update fee_terms set effective_from = now() - interval '20 days' where store_org_id = $1 and kind = 'standard' and source <> 'rate_change'`, [org.S]);
    await backdate(`update fee_terms set effective_from = now() - interval '1 day' where store_org_id = $1 and source = 'rate_change'`, [org.S]);
    // Without proven delivery of the notice, nothing pauses.
    expect(await q(`select public.store_new_activity_blocked($1) b`, [org.S])).toEqual([{ b: false }]);
    const tid = (await q(`select id from fee_terms where store_org_id = $1 and source = 'rate_change'`, [org.S]))[0].id;
    await backdate(`insert into fee_change_notices(term_id, store_org_id, event, channel, recipient, reference, occurred_at)
                    values ($1, $2, 'delivered', 'email', 's@lp.test', 'delivered', now() - interval '40 days')`, [tid, org.S]);
    expect(await q(`select public.store_new_activity_blocked($1) b`, [org.S])).toEqual([{ b: true }]);
    await expect(rpc(u.s!, "create_campaign", { p_store: org.S, p_title: "New launch", p_description: null, p_commission_bps: 1500,
      p_starts_at: new Date().toISOString(), p_ends_at: inDays(10), p_product_ids: [] })).rejects.toThrow(/store_rate_not_accepted/);
    await expect(rpc(u.s!, "create_proposal", { p_from_org: org.S, p_commission_bps: 1000, p_invitee_name: "X", p_invitee_contact: null,
      p_coupon_discount_pct: 10, p_attribution_days: null, p_target_site_url: null, p_source_proposal: null })).rejects.toThrow(/store_rate_not_accepted/);
    const c3 = await rpc(u.en!, "accept_legal", { p_doc_keys: ["terms", "privacy", "creator-terms"], p_type: "signup", p_org: null, p_locale: "en" });
    expect(c3).toBe(3);
    org.C3 = await rpc(u.en!, "create_organization", { p_type: "creator", p_name: "Late Creator" });
    const opp = (await q(`select id from opportunities where store_org_id = $1 and kind = 'standing'`, [org.S]))[0].id;
    await expect(rpc(u.en!, "join_opportunity", { p_opportunity: opp, p_creator: org.C3 })).rejects.toThrow(/store_rate_not_accepted/);
    // Existing collaboration, link and coupon keep working at the rate the store accepted.
    await sale("wd-1");
    expect(await feeOf("wd-1")).toBe(300);
    expect(await q(`select active from partner_codes where code = $1`, [code])).toEqual([{ active: true }]);
  });
  it("accepting late applies the new rate from acceptance only (never retroactively) and lifts the pause", async () => {
    const term = (await q(`select id from fee_terms where store_org_id = $1 and source = 'rate_change' and status = 'proposed'`, [org.S]))[0].id;
    await rpc(u.s!, "respond_fee_change", { p_term: term, p_accept: true });
    expect(await q(`select status from fee_terms where id = $1`, [term])).toEqual([{ status: "withdrawn" }]);
    const yesterday = new Date(Date.now() - 3_600_000).toISOString();
    expect((await q(`select public.fee_bps_at($1, $2) f`, [org.S, yesterday]))[0].f).toBe(300);   // before acceptance: old rate
    expect((await q(`select public.fee_bps_at($1, now() + interval '1 minute') f`, [org.S]))[0].f).toBe(400);
    expect(await q(`select public.store_new_activity_blocked($1) b`, [org.S])).toEqual([{ b: false }]);
    expect(await feeOf("wd-1")).toBe(300);   // historical sale unchanged
  });
});

describe("payment requests: itemised base, disputes", () => {
  it("lists the base per rate; a store admin can dispute part of an open request; the rest stays due", async () => {
    await q(`update app_settings set value = 'true' where key = 'invoicing_tax_approved'`);
    await rpc(svc, "approve_matured_commissions");
    await sale("inv-1", ago(20));
    await rpc(svc, "approve_matured_commissions");
    await backdate(`update commission_ledger set approved_at = $1 where state = 'approved'`, [`${month(1)}T12:00:00Z`]);
    await rpc(u.admin!, "generate_invoices", { p_period_start: month(1) });
    inv = (await q(`select id from invoices where store_org_id = $1`, [org.S]))[0].id;
    const lines = await rpc(u.s!, "invoice_lines", { p_invoice: inv });
    expect(lines.map((l: any) => [l.rate_bps, Number(l.base_minor), Number(l.fee_minor)])).toEqual([[400, 10_000, 400]]);   // sold after the accepted change
    await expect(rpc(u.staff!, "invoice_lines", { p_invoice: inv })).rejects.toThrow(/forbidden/);
    await expect(rpc(u.staff!, "open_invoice_dispute", { p_invoice: inv, p_disputed_minor: 100, p_reason: "wrong order" })).rejects.toThrow(/forbidden/);
    await expect(rpc(u.s!, "open_invoice_dispute", { p_invoice: inv, p_disputed_minor: 99_999, p_reason: "too much" })).rejects.toThrow(/invalid_amount/);
    const d = await rpc(u.s!, "open_invoice_dispute", { p_invoice: inv, p_disputed_minor: 100, p_reason: "order was cancelled", p_evidence: "order #inv-1" });
    await expect(rpc(u.s!, "open_invoice_dispute", { p_invoice: inv, p_disputed_minor: 50, p_reason: "again" })).rejects.toThrow(/dispute_open/);
    await expect(rpc(u.s!, "resolve_invoice_dispute", { p_dispute: d, p_resolution: "x" })).rejects.toThrow(/forbidden/);
    await rpc(u.admin!, "resolve_invoice_dispute", { p_dispute: d, p_resolution: "Checked: correction in next period" });
    await expect(q(`update invoice_disputes set resolution = 'edited' where id = $1`, [d])).rejects.toThrow(/append_only/);
    expect(await db.as(u.s!, `select resolution from invoice_disputes where id = $1`, [d])).toEqual([{ resolution: "Checked: correction in next period" }]);
    expect(await db.as(u.x!, `select 1 from invoice_disputes`)).toHaveLength(0);
    const a = (await rpc(u.admin!, "admin_invoices")).invoices.find((x: any) => x.id === inv);
    expect(a.disputes).toHaveLength(1);
    expect(a.lines).toHaveLength(1);
  });
});

describe("reward transfer withholding (manual, never assumed)", () => {
  it("records the withholding entered from a certificate and returns the net transferred", async () => {
    await backdate(`insert into referral_rewards(referral_id, referrer_org_id, ledger_id, attribution_id, share_bps, amount_minor, currency, idempotency_key)
                    select gen_random_uuid(), $1, id, attribution_id, 4000, 20000, 'ILS', 'lp:w' from commission_ledger where party_role = 'platform' limit 1`, [org.C]);
    await rpc(u.c!, "save_tax_profile", { p_org: org.C, p_legal_name: "Creator C Ltd", p_classification: "company", p_tax_id: "511111111",
      p_address: "Safed", p_country: "IL" });
    await rpc(u.admin!, "verify_tax_profile", { p_org: org.C, p_zero_rate: false });
    const tr = (wh: number) => rpc(u.admin!, "record_reward_transfer", { p_org: org.C, p_currency: "ILS", p_reference: "BANK", p_doc_type: "tax_invoice",
      p_doc_number: "C-1", p_doc_date: null, p_withholding_minor: wh });
    await expect(tr(30_000)).rejects.toThrow(/invalid_amount/);
    expect(await tr(1_000)).toBe(20_000 + 3_600 - 1_000);
    expect(await q(`select withholding_minor::int w from accounting_documents where org_id = $1`, [org.C])).toEqual([{ w: 1_000 }]);
  });
});

describe("contact form", () => {
  it("anyone can send a message; it is private to platform admins; flooding is limited", async () => {
    expect(await rpc(anon, "submit_contact_message", { p_name: "Dana", p_email: "dana@x.co", p_topic: "privacy", p_message: "Please correct my email" })).toBeTruthy();
    await expect(rpc(anon, "submit_contact_message", { p_name: "D", p_email: "bad", p_topic: "general", p_message: "hello there" })).rejects.toThrow(/invalid_input/);
    await expect(db.as(anon, `select 1 from contact_messages`)).rejects.toThrow(/permission denied/);
    await expect(db.as(u.s!, `select 1 from contact_messages`)).rejects.toThrow(/permission denied/);
    for (let i = 0; i < 4; i++) await rpc(anon, "submit_contact_message", { p_name: "Dana", p_email: "dana@x.co", p_topic: "general", p_message: `msg ${i} text` });
    await expect(rpc(anon, "submit_contact_message", { p_name: "Dana", p_email: "DANA@x.co", p_topic: "general", p_message: "one more" })).rejects.toThrow(/too_many/);
    await expect(rpc(u.s!, "admin_contact_messages")).rejects.toThrow(/forbidden/);
    const list = await rpc(u.admin!, "admin_contact_messages");
    expect(list).toHaveLength(5);
    await rpc(u.admin!, "mark_contact_handled", { p_id: list[0].id });
  });
});
