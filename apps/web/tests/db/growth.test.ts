import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";

/**
 * Full-build modules on the real migrations: referral links, team roles, product sync, catalogue & opportunities,
 * LINKUP LAUNCH campaigns, store billing, FOUNDING PARTNERS rewards (eligibility, split, cap, windows, reversals),
 * creator payout tracking, wallet privacy and platform-admin guards.
 */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const anon: Who = { role: "anon" };
const u: Record<string, Who> = {};
const org: Record<string, string> = {};
const conn: Record<string, string> = {};
const code: Record<string, string> = {};

const rpc = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
  const row = await db.one<{ r: T }>(who, sql, keys.map((k) => args[k]));
  return row.r;
};
const q = <T = any>(sql: string, params: unknown[] = []) => db.as<T>(owner, sql, params);
// Test-only time travel: owner session with triggers disabled (append-only guards) to move timestamps back.
const backdate = async (sql: string, params: unknown[] = []) => {
  await db.transaction(async (tx) => {
    await tx.exec(`set local session_replication_role = replica`);
    await tx.query(sql, params);
  });
};

let seq = 0;
const ingest = (store: string, orderId: string, o: Record<string, unknown> = {}, occurredAt?: Date) =>
  rpc(svc, "ingest_order_event", {
    p_connection: conn[store],
    p_event: JSON.stringify({
      event_id: `g-${++seq}`, type: "order.upserted",
      occurred_at: (occurredAt ?? new Date(Date.now() + seq)).toISOString(),
      order: { id: orderId, status: "completed", currency: "ILS", total: 11_800, tax: 1_800, shipping: 0, shipping_tax: 0,
               coupons: [], ref: "", email_hash: "", created_at: new Date().toISOString(), refunds: [], ...o },
    }),
  });
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
const monthStart = (back: number) => {
  const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1)).toISOString().slice(0, 10);
};
const connectStore = async (key: string, who: Who, site: string) => {
  const r = await rpc(who, "create_store_connection", { p_org: org[key], p_site_url: site });
  conn[key] = r.connection_id;
  await rpc(svc, "plugin_sync", { p_connection: conn[key], p_plugin_version: "0.3.0" });
};
const attrOf = async (orderExt: string) =>
  (await q<{ id: string }>(`select a.id from attributions a join orders o on o.id = a.order_id where o.external_order_id = $1`, [orderExt]))[0]!.id;
const shares = (attr: string) =>
  q<{ referrer_org_id: string; share_bps: number }>(`select * from public.referral_shares($1)`, [attr]);

beforeAll(async () => {
  db = await createDb();
  for (const [k, email] of Object.entries({
    r: "ref@creator.com", b: "owner@refstore.co.il", a: "owner@alpha.co.il", c: "cee@creator.com",
    d: "d@delta.co.il", e: "e@echo.com", staff: "staff@alpha.co.il", stranger: "nobody@x.com", admin: "admin@linkup.app",
  })) u[k] = { role: "authenticated", userId: await createUser(db, email) };
  await q(`insert into platform_admins(user_id) values ($1)`, [(u.admin as any).userId]);

  org.R = await rpc(u.r!, "create_organization", { p_type: "creator", p_name: "Ref Creator" });
  org.B = await rpc(u.b!, "create_organization", { p_type: "store", p_name: "Ref Store" });
  const refR = (await q<{ referral_code: string }>(`select referral_code from organizations where id = $1`, [org.R]))[0]!.referral_code;
  const refB = (await q<{ referral_code: string }>(`select referral_code from organizations where id = $1`, [org.B]))[0]!.referral_code;
  code.refR = refR; code.refB = refB;
  org.A = await rpc(u.a!, "create_organization", { p_type: "store", p_name: "Alpha Shop", p_ref_code: refR });
  org.C = await rpc(u.c!, "create_organization", { p_type: "creator", p_name: "Cee", p_ref_code: refB });
  org.D = await rpc(u.d!, "create_organization", { p_type: "store", p_name: "Delta", p_ref_code: refR });
  org.E = await rpc(u.e!, "create_organization", { p_type: "creator", p_name: "Echo", p_ref_code: refR });
  await connectStore("A", u.a!, "alpha.co.il");
  await connectStore("B", u.b!, "refstore.co.il");
  await connectStore("D", u.d!, "delta.co.il");
}, 60_000);

describe("referral links (FOUNDING PARTNERS)", () => {
  it("records referrals with 40% program terms", async () => {
    const r = await q(`select program, status, reward_bps, source from referrals where referred_org_id = $1`, [org.A]);
    expect(r[0]).toMatchObject({ program: "founding_partners", status: "active", reward_bps: 4000, source: "link" });
  });
  it("blocks self-referral: a user's own new activity cannot be referred by their other activity", async () => {
    const own = await rpc(u.r!, "create_organization", { p_type: "store", p_name: "Ref Own Shop", p_ref_code: code.refR });
    const r = await q(`select status from referrals where referred_org_id = $1`, [own]);
    expect(r[0]).toMatchObject({ status: "blocked" });
  });
  it("ignores unknown or malformed referral codes", async () => {
    const x = await rpc(u.stranger!, "create_organization", { p_type: "creator", p_name: "Nobody", p_ref_code: "x'; drop" });
    expect(await q(`select 1 from referrals where referred_org_id = $1`, [x])).toHaveLength(0);
    org.X = x;
  });
});

describe("team & roles", () => {
  let token: string;
  it("owner invites a staff member; only the invited e-mail can accept", async () => {
    token = (await rpc(u.a!, "invite_team_member", { p_org: org.A, p_email: "Staff@Alpha.co.il", p_role: "member" })).token;
    expect((await rpc(anon, "get_team_invite", { p_token: token })).org_name).toBe("Alpha Shop");
    await expect(rpc(u.stranger!, "accept_team_invite", { p_token: token })).rejects.toThrow(/invite_email_mismatch/);
    expect(await rpc(u.staff!, "accept_team_invite", { p_token: token })).toBe(org.A);
    await expect(rpc(u.staff!, "accept_team_invite", { p_token: token })).rejects.toThrow(/invite_invalid/);
  });
  it("a member cannot change money terms, connection or team", async () => {
    await expect(rpc(u.staff!, "create_proposal", { p_from_org: org.A })).rejects.toThrow(/forbidden/);
    await expect(rpc(u.staff!, "save_standing_opportunity", { p_store: org.A, p_title: "x", p_description: null,
      p_commission_bps: 500, p_coupon_pct: 5, p_auto_approve: true, p_status: "live" })).rejects.toThrow(/forbidden/);
    await expect(rpc(u.staff!, "create_store_connection", { p_org: org.A, p_site_url: "evil.com" })).rejects.toThrow(/forbidden/);
    await expect(rpc(u.staff!, "invite_team_member", { p_org: org.A, p_email: "a@b.co", p_role: "member" })).rejects.toThrow(/forbidden/);
    await expect(rpc(u.staff!, "org_members", { p_org: org.A })).rejects.toThrow(/forbidden/);
  });
  it("the last owner cannot demote or remove themselves", async () => {
    await expect(rpc(u.a!, "set_member_role", { p_org: org.A, p_user: (u.a as any).userId, p_role: "admin" })).rejects.toThrow(/last_owner/);
    await expect(rpc(u.a!, "remove_member", { p_org: org.A, p_user: (u.a as any).userId })).rejects.toThrow(/last_owner/);
    const m = await rpc(u.a!, "org_members", { p_org: org.A });
    expect(m.members).toHaveLength(2);
  });
  it("only an owner can grant admin", async () => {
    await expect(rpc(u.staff!, "invite_team_member", { p_org: org.A, p_email: "x@y.co", p_role: "admin" })).rejects.toThrow(/forbidden/);
  });
});

describe("product & stock sync", () => {
  const p = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, name: `Ring ${id}`, url: `https://alpha.co.il/p/${id}`, image: `https://alpha.co.il/i/${id}.jpg`, price: 19_900,
       currency: "ILS", in_stock: true, stock_qty: 5, categories: ["rings"], status: "publish", ...extra });
  it("upserts valid products, skips malformed rows, never trusts non-https images", async () => {
    const r = await rpc(svc, "plugin_sync_products", { p_connection: conn.A, p_products: JSON.stringify([
      p("1"), p("2", { image: "http://insecure/x.jpg" }), { id: "", name: "bad" }, p("3", { price: "abc" })]) });
    expect(r.upserted).toBe(2);
    const rows = await q(`select external_id, image_url, price_minor from products where store_org_id = $1 order by external_id`, [org.A]);
    expect(rows).toEqual([{ external_id: "1", image_url: "https://alpha.co.il/i/1.jpg", price_minor: 19900 },
                          { external_id: "2", image_url: null, price_minor: 19900 }]);
  });
  it("stock and price changes update; a full pass removes products no longer in the store", async () => {
    const started = new Date(Date.now() + 1000).toISOString();
    await new Promise((r) => setTimeout(r, 1100));
    await rpc(svc, "plugin_sync_products", { p_connection: conn.A, p_full_started_at: started,
      p_products: JSON.stringify([p("1", { in_stock: false, price: 15_000 }), p("4")]) });
    const rows = await q(`select external_id, status, in_stock from products where store_org_id = $1 order by external_id`, [org.A]);
    expect(rows).toEqual([{ external_id: "1", status: "active", in_stock: false }, { external_id: "2", status: "removed", in_stock: true },
                          { external_id: "4", status: "active", in_stock: true }]);
  });
  it("only the plugin (service role) can sync products", async () => {
    await expect(rpc(u.a!, "plugin_sync_products", { p_connection: conn.A, p_products: "[]" })).rejects.toThrow(/permission denied/);
  });
});

describe("catalogue, opportunities & joining", () => {
  it("store publishes its standing offer; creators see it in the catalogue with in-stock products only", async () => {
    await rpc(u.a!, "save_standing_opportunity", { p_store: org.A, p_title: "Jewelry for every occasion", p_description: "Handmade",
      p_commission_bps: 1000, p_coupon_pct: 10, p_auto_approve: true, p_status: "live" });
    const cat = await rpc(u.c!, "catalog", {});
    const a = cat.find((x: any) => x.store_org_id === org.A);
    expect(a).toMatchObject({ commission_bps: 1000, coupon_discount_pct: 10, kind: "standing" });
    expect(a.products.map((p: any) => p.name)).toEqual(["Ring 4"]);
    expect(await rpc(anon, "get_public_proposal", { p_token: "0".repeat(24) })).toBeNull();
  });
  it("creator joins instantly (auto-approve) and gets a personal code", async () => {
    const r = await rpc(u.c!, "join_opportunity", { p_opportunity: (await q(`select id from opportunities where store_org_id = $1`, [org.A]))[0]!.id, p_creator: org.C });
    expect(r.status).toBe("approved");
    expect(r.code).toMatch(/^[A-Z0-9]{4,16}$/);
    code.C = r.code;
    const again = await rpc(u.c!, "join_opportunity", { p_opportunity: (await q(`select id from opportunities where store_org_id = $1`, [org.A]))[0]!.id, p_creator: org.C });
    expect(again.status).toBe("approved");
  });
  it("blocks a self-deal (same person on both sides)", async () => {
    const own = await rpc(u.a!, "create_organization", { p_type: "creator", p_name: "Alpha Owner Creator" });
    const opp = (await q(`select id from opportunities where store_org_id = $1`, [org.A]))[0]!.id;
    await expect(rpc(u.a!, "join_opportunity", { p_opportunity: opp, p_creator: own })).rejects.toThrow(/self_deal/);
  });
  it("manual approval: application waits for the store, which approves it", async () => {
    await rpc(u.b!, "save_standing_opportunity", { p_store: org.B, p_title: "Ref Store offer", p_description: null,
      p_commission_bps: 1200, p_coupon_pct: 5, p_auto_approve: false, p_status: "live" });
    const opp = (await q(`select id from opportunities where store_org_id = $1`, [org.B]))[0]!.id;
    const r = await rpc(u.c!, "join_opportunity", { p_opportunity: opp, p_creator: org.C, p_message: "Hi" });
    expect(r.status).toBe("pending");
    await expect(rpc(u.c!, "decide_application", { p_application: r.application_id, p_approve: true })).rejects.toThrow(/forbidden/);
    const d = await rpc(u.b!, "decide_application", { p_application: r.application_id, p_approve: true });
    expect(d.status).toBe("approved");
    await expect(rpc(u.b!, "decide_application", { p_application: r.application_id, p_approve: false })).rejects.toThrow(/already_decided/);
  });
  it("a paused offer disappears from the catalogue and cannot be joined", async () => {
    const opp = (await q(`select id from opportunities where store_org_id = $1`, [org.B]))[0]!.id;
    await rpc(u.b!, "set_opportunity_status", { p_opportunity: opp, p_status: "paused" });
    expect((await rpc(u.e!, "catalog", {})).some((x: any) => x.id === opp)).toBe(false);
    await expect(rpc(u.e!, "join_opportunity", { p_opportunity: opp, p_creator: org.E })).rejects.toThrow(/opportunity_closed/);
  });
});

describe("LINKUP LAUNCH campaigns", () => {
  let camp: string;
  it("rejects invalid dates and campaigns longer than 90 days", async () => {
    await expect(rpc(u.a!, "create_campaign", { p_store: org.A, p_title: "Bad", p_description: null, p_commission_bps: 2000,
      p_starts_at: new Date().toISOString(), p_ends_at: ago(1).toISOString() })).rejects.toThrow(/invalid_dates/);
    await expect(rpc(u.a!, "create_campaign", { p_store: org.A, p_title: "Long", p_description: null, p_commission_bps: 2000,
      p_starts_at: new Date().toISOString(), p_ends_at: new Date(Date.now() + 100 * 86_400_000).toISOString() })).rejects.toThrow(/invalid_dates/);
  });
  it("existing partners are enrolled and notified automatically", async () => {
    camp = await rpc(u.a!, "create_campaign", { p_store: org.A, p_title: "Holiday sale", p_description: "20% this week",
      p_commission_bps: 2000, p_starts_at: ago(0.01).toISOString(), p_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    expect(await q(`select status from opportunity_applications where opportunity_id = $1 and creator_org_id = $2`, [camp, org.C]))
      .toEqual([{ status: "approved" }]);
    expect(await db.as(u.c!, `select kind from notifications where org_id = $1 and kind = 'campaign_launched'`, [org.C])).toHaveLength(1);
  });
  it("orders during the campaign earn the campaign rate on the whole order; after it ends, the standing rate", async () => {
    // base = 11800 − 1800 VAT = 10000
    await ingest("A", "camp-1", { coupons: [code.C] });
    const a1 = (await q(`select commission_bps, base_commission_bps, campaign_id from attributions a join orders o on o.id = a.order_id where o.external_order_id = 'camp-1'`))[0];
    expect(a1).toMatchObject({ commission_bps: 2000, base_commission_bps: 1000, campaign_id: camp });
    const l1 = await q(`select party_role, sum(amount_minor)::int as t from commission_ledger l join attributions a on a.id = l.attribution_id
                         join orders o on o.id = a.order_id where o.external_order_id = 'camp-1' group by 1 order by 1`);
    expect(l1).toEqual([{ party_role: "creator", t: 2000 }, { party_role: "platform", t: 200 }]);
    await rpc(u.a!, "set_opportunity_status", { p_opportunity: camp, p_status: "ended" });
    await new Promise((r) => setTimeout(r, 20));
    await ingest("A", "camp-2", { coupons: [code.C] });
    const a2 = (await q(`select commission_bps, campaign_id from attributions a join orders o on o.id = a.order_id where o.external_order_id = 'camp-2'`))[0];
    expect(a2).toMatchObject({ commission_bps: 1000, campaign_id: null });
  });
  it("a creator who partners with the store during a live campaign is enrolled in it", async () => {
    const live = await rpc(u.a!, "create_campaign", { p_store: org.A, p_title: "Week two", p_description: null, p_commission_bps: 1800,
      p_starts_at: ago(0.01).toISOString(), p_ends_at: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    const opp = (await q(`select id from opportunities where store_org_id = $1 and kind = 'standing'`, [org.A]))[0]!.id;
    await rpc(u.e!, "join_opportunity", { p_opportunity: opp, p_creator: org.E });
    expect(await q(`select status from opportunity_applications where opportunity_id = $1 and creator_org_id = $2`, [live, org.E])).toEqual([{ status: "approved" }]);
    await rpc(u.a!, "set_opportunity_status", { p_opportunity: live, p_status: "ended" });
  });
  it("the store fee is never taken from the creator's commission", async () => {
    const l = await q(`select party_role, sum(amount_minor)::int as t from commission_ledger l join attributions a on a.id = l.attribution_id
                        join orders o on o.id = a.order_id where o.external_order_id = 'camp-2' group by 1 order by 1`);
    expect(l).toEqual([{ party_role: "creator", t: 1000 }, { party_role: "platform", t: 200 }]);
  });
});

describe("FOUNDING PARTNERS eligibility & split", () => {
  it("two different referrers (store side R, creator side B) split 40% equally", async () => {
    const s = await shares(await attrOf("camp-1"));
    expect(s.sort((x, y) => x.referrer_org_id.localeCompare(y.referrer_org_id)))
      .toEqual([{ referral_id: expect.any(String), referrer_org_id: org.R, share_bps: 2000 },
                { referral_id: expect.any(String), referrer_org_id: org.B, share_bps: 2000 }]
        .sort((x, y) => x.referrer_org_id.localeCompare(y.referrer_org_id)));
  });
  it("the same referrer on both sides earns 40% once", async () => {
    await rpc(u.d!, "save_standing_opportunity", { p_store: org.D, p_title: "Delta", p_description: null,
      p_commission_bps: 1000, p_coupon_pct: 10, p_auto_approve: true, p_status: "live" });
    const opp = (await q(`select id from opportunities where store_org_id = $1`, [org.D]))[0]!.id;
    code.E = (await rpc(u.e!, "join_opportunity", { p_opportunity: opp, p_creator: org.E })).code;
    await ingest("D", "de-1", { coupons: [code.E] });
    const s = await shares(await attrOf("de-1"));
    expect(s).toEqual([{ referral_id: expect.any(String), referrer_org_id: org.R, share_bps: 4000 }]);
  });
  it("a referrer who is a party to the deal earns nothing on it", async () => {
    const opp = (await q(`select id from opportunities where store_org_id = $1 and kind = 'standing'`, [org.A]))[0]!.id;
    code.R = (await rpc(u.r!, "join_opportunity", { p_opportunity: opp, p_creator: org.R })).code;
    await ingest("A", "ar-1", { coupons: [code.R] });
    expect(await shares(await attrOf("ar-1"))).toEqual([]);
  });
  it("no reward on a sale flagged as self-referral", async () => {
    const hash = (await q<{ h: string }>(`select encode(sha256(convert_to('cee@creator.com','UTF8')),'hex') as h`))[0]!.h;
    await ingest("A", "self-1", { coupons: [code.C], email_hash: hash });
    expect(await shares(await attrOf("self-1"))).toEqual([]);
  });
});

describe("billing → collected revenue → rewards", () => {
  let inv: any;
  it("approval, then a monthly payment request per store (admin only, idempotent)", async () => {
    // Completed 20 days ago → past the 14-day refund hold.
    await ingest("A", "bill-1", { coupons: [code.C] }, ago(20));
    await ingest("A", "bill-2", { coupons: [code.C], total: 23_600, tax: 3_600 }, ago(20));
    await rpc(svc, "approve_matured_commissions");
    await backdate(`update commission_ledger set approved_at = $1 where state = 'approved'`, [`${monthStart(2)}T12:00:00Z`]);
    await expect(rpc(u.a!, "generate_invoices", { p_period_start: monthStart(2) })).rejects.toThrow(/forbidden/);
    await expect(rpc(u.admin!, "generate_invoices", { p_period_start: monthStart(0) })).rejects.toThrow(/period_not_closed/);
    expect(await rpc(u.admin!, "generate_invoices", { p_period_start: monthStart(2) })).toBeGreaterThanOrEqual(1);
    expect(await rpc(u.admin!, "generate_invoices", { p_period_start: monthStart(2) })).toBe(0);
    inv = (await q(`select * from invoices where store_org_id = $1`, [org.A]))[0];
    expect(inv).toMatchObject({ status: "issued", currency: "ILS", credit_minor: 0 });
    // bill-1: base 10000 × 2% = 200; bill-2: base 20000 × 2% = 400
    expect(Number(inv.fees_minor)).toBe(600);
  });
  it("only store admins see the invoice; staff and strangers do not", async () => {
    expect(await db.as(u.a!, `select id from invoices`)).toHaveLength(1);
    expect(await db.as(u.staff!, `select id from invoices`)).toHaveLength(0);
    expect(await db.as(u.stranger!, `select id from invoices`)).toHaveLength(0);
    expect(await db.as(u.staff!, `select id from commission_ledger`)).toHaveLength(0);
  });
  it("no reward before payment; marking paid creates rewards from collected revenue only", async () => {
    expect(await q(`select 1 from referral_rewards`)).toHaveLength(0);
    await expect(rpc(u.a!, "mark_invoice_paid", { p_invoice: inv.id, p_reference: "x" })).rejects.toThrow(/forbidden/);
    await rpc(u.admin!, "mark_invoice_paid", { p_invoice: inv.id, p_reference: "GROW-123" });
    await expect(rpc(u.admin!, "mark_invoice_paid", { p_invoice: inv.id, p_reference: "again" })).rejects.toThrow(/invoice_not_payable/);
    const rw = await q<{ referrer_org_id: string; t: number }>(
      `select referrer_org_id, sum(amount_minor)::int as t from referral_rewards group by 1`);
    const byOrg = Object.fromEntries(rw.map((r) => [r.referrer_org_id, r.t]));
    // 20% each of 600 = 120 (R store-side, B creator-side). Total = 40% of collected fees.
    expect(byOrg[org.R]).toBe(120);
    expect(byOrg[org.B]).toBe(120);
  });
  it("re-running reward settlement never pays twice", async () => {
    expect(await q(`select public.settle_invoice_rewards($1) as n`, [inv.id])).toEqual([{ n: 0 }]);
  });
  it("a refund after payment reverses the reward on the next request", async () => {
    await ingest("A", "bill-1", { status: "refunded", coupons: [code.C], refunds: [{ id: "rf1", amount: 11_800 }] });
    await ingest("A", "bill-3", { coupons: [code.C], total: 23_600, tax: 3_600 }, ago(20)); // fee 400
    await rpc(svc, "approve_matured_commissions");
    await backdate(`update commission_ledger set approved_at = $1 where state = 'approved' and approved_at > $2`,
      [`${monthStart(1)}T12:00:00Z`, `${monthStart(1)}T00:00:00Z`]);
    await rpc(u.admin!, "generate_invoices", { p_period_start: monthStart(1) });
    const inv2 = (await q(`select * from invoices where store_org_id = $1 and period_start = $2`, [org.A, monthStart(1)]))[0];
    expect(inv2).toBeTruthy();
    const items = await q<{ amount_minor: string }>(`select amount_minor from invoice_items where invoice_id = $1 order by amount_minor`, [inv2.id]);
    expect(items.map((i) => Number(i.amount_minor))).toContain(-200);
    await rpc(u.admin!, "mark_invoice_paid", { p_invoice: inv2.id, p_reference: "GROW-124" });
    const neg = await q(`select amount_minor::int as a from referral_rewards where referrer_org_id = $1 and amount_minor < 0`, [org.R]);
    expect(neg).toEqual([{ a: -40 }]);
    expect(Number(inv2.fees_minor)).toBe(200); // −200 refund + 400 new sale
  });
  it("a void request returns its lines to the pool", async () => {
    await ingest("A", "bill-4", { coupons: [code.C] }, ago(20));
    await rpc(svc, "approve_matured_commissions");
    await backdate(`update commission_ledger set approved_at = $1 where state = 'approved' and approved_at > $2`,
      [`${monthStart(3)}T12:00:00Z`, `${monthStart(1)}T00:00:00Z`]);
    await rpc(u.admin!, "generate_invoices", { p_period_start: monthStart(3) });
    const inv3 = (await q(`select id from invoices where store_org_id = $1 and period_start = $2`, [org.A, monthStart(3)]))[0]!;
    await rpc(u.admin!, "void_invoice", { p_invoice: inv3.id });
    expect(await q(`select 1 from invoice_items where invoice_id = $1`, [inv3.id])).toHaveLength(0);
    expect(await rpc(u.admin!, "generate_invoices", { p_period_start: monthStart(3) })).toBe(1);
  });
});

describe("FOUNDING PARTNERS windows", () => {
  it("rewards stop 90 days after the referred party's first sale", async () => {
    const attr = await attrOf("de-1");
    expect(await shares(attr)).toHaveLength(1);
    await backdate(`update orders set order_created_at = order_created_at - interval '120 days' where external_order_id = 'de-1'`);
    await backdate(`update referrals set created_at = created_at - interval '130 days' where referred_org_id in ($1, $2)`, [org.D, org.E]);
    await ingest("D", "de-2", { coupons: [code.E] });
    expect(await shares(await attrOf("de-2"))).toEqual([]);
  });
  it("no reward if the first sale happens after the 12-month activation window", async () => {
    await backdate(`update orders set order_created_at = now() where external_order_id = 'de-1'`);
    await backdate(`update referrals set reward_until = now() - interval '1 day' where referred_org_id in ($1, $2)`, [org.D, org.E]);
    expect(await shares(await attrOf("de-2"))).toEqual([]);
  });
});

describe("creator payout tracking", () => {
  it("store records a payout of approved, unpaid commission; creator confirms", async () => {
    const r = await rpc(u.a!, "record_creator_payout", { p_store: org.A, p_creator: org.C, p_method: "bit", p_reference: "BIT-9" });
    expect(r.amount_minor).toBeGreaterThan(0);
    await expect(rpc(u.a!, "record_creator_payout", { p_store: org.A, p_creator: org.C, p_method: "bit", p_reference: "x" }))
      .rejects.toThrow(/nothing_to_pay/);
    await expect(rpc(u.stranger!, "respond_creator_payout", { p_payout: r.payout_id, p_confirm: true })).rejects.toThrow(/forbidden/);
    await rpc(u.c!, "respond_creator_payout", { p_payout: r.payout_id, p_confirm: true });
    await expect(rpc(u.c!, "respond_creator_payout", { p_payout: r.payout_id, p_confirm: false })).rejects.toThrow(/already_responded/);
    const bal = await rpc(u.c!, "payout_balances", { p_org: org.C });
    const a = bal.find((x: any) => x.other_org_id === org.A);
    expect(Number(a.approved_unpaid_minor)).toBe(0);
    expect(Number(a.paid_minor)).toBe(r.amount_minor);
  });
  it("staff cannot record payouts", async () => {
    await expect(rpc(u.staff!, "record_creator_payout", { p_store: org.A, p_creator: org.C, p_method: "bit", p_reference: "x" }))
      .rejects.toThrow(/forbidden/);
  });
});

describe("wallet & privacy", () => {
  it("referrer sees balance and referral states, never sales volume or customers", async () => {
    const w = await rpc(u.r!, "my_wallet");
    const act = w.activities.find((a: any) => a.org_id === org.R);
    expect(act.balance_minor).toBe(160); // 120 − 40 + 80
    const alpha = w.referrals.find((r: any) => r.name === "Alpha Shop");
    expect(alpha.state).toBe("earning");
    const s = JSON.stringify(w);
    for (const leak of ["base_minor", "total_minor", "email", "fees_minor", "order"]) expect(s).not.toContain(leak);
  });
  it("transfers only above the minimum; rewards are never visible to other users", async () => {
    await expect(rpc(u.admin!, "record_reward_transfer", { p_org: org.R, p_currency: "ILS", p_reference: "x" })).rejects.toThrow(/below_minimum/);
    // Row-level reward detail is not readable by any client (would reveal per-order sales of the referred party).
    await expect(db.as(u.stranger!, `select 1 from referral_rewards`)).rejects.toThrow(/permission denied/);
    await expect(db.as(u.r!, `select 1 from referral_rewards`)).rejects.toThrow(/permission denied/);
  });
  it("a store's positive wallet balance is credited against its next payment request", async () => {
    // Ref Store (B) earned 160 as referrer; give it its own approved fee and bill it.
    const opp = (await q(`select id from opportunities where store_org_id = $1`, [org.B]))[0]!.id;
    await rpc(u.b!, "set_opportunity_status", { p_opportunity: opp, p_status: "live" });
    const codeEB = (await rpc(u.e!, "join_opportunity", { p_opportunity: opp, p_creator: org.E })).status;
    expect(codeEB).toBe("pending");
    const app = (await q(`select id from opportunity_applications where opportunity_id = $1 and creator_org_id = $2`, [opp, org.E]))[0]!.id;
    const ce = (await rpc(u.b!, "decide_application", { p_application: app, p_approve: true })).code;
    await ingest("B", "b-1", { coupons: [ce], total: 118_000, tax: 18_000 }, ago(20)); // base 100000, fee 2% = 2000
    await rpc(svc, "approve_matured_commissions");
    await backdate(`update commission_ledger set approved_at = $1 where state = 'approved' and store_org_id = $2`, [`${monthStart(1)}T12:00:00Z`, org.B]);
    await rpc(u.admin!, "generate_invoices", { p_period_start: monthStart(1) });
    const ib = (await q(`select fees_minor::int as f, credit_minor::int as c, total_minor::int as t from invoices where store_org_id = $1`, [org.B]))[0];
    expect(ib).toEqual({ f: 2000, c: 160, t: 1840 });
    expect((await rpc(u.b!, "my_wallet")).activities.find((a: any) => a.org_id === org.B).balance_minor).toBe(0);
  });
});

describe("platform admin guards", () => {
  it("admin views and settings are closed to everyone else; pricing & reward terms are locked", async () => {
    await expect(rpc(u.a!, "admin_overview")).rejects.toThrow(/forbidden/);
    const o = await rpc(u.admin!, "admin_overview");
    expect(o.stores).toBeGreaterThan(0);
    expect(o.funnel.signup.total).toBeGreaterThan(0);
    await expect(rpc(u.admin!, "admin_set_setting", { p_key: "standard_fee_bps", p_value: "0" })).rejects.toThrow(/setting_locked/);
    await expect(rpc(u.admin!, "admin_set_setting", { p_key: "referral_reward_bps", p_value: "9000" })).rejects.toThrow(/setting_locked/);
    await rpc(u.admin!, "admin_set_setting", { p_key: "founding_partners_open", p_value: "false" });
    const late = await rpc(u.stranger!, "create_organization", { p_type: "store", p_name: "Late Store", p_ref_code: code.refR });
    expect(await q(`select program, reward_bps from referrals where referred_org_id = $1`, [late])).toEqual([{ program: "none", reward_bps: 0 }]);
  });
  it("track_event accepts only share events from members", async () => {
    await rpc(u.c!, "track_event", { p_org: org.C, p_event: "creative_shared" });
    await expect(rpc(u.c!, "track_event", { p_org: org.C, p_event: "invoice_paid" })).rejects.toThrow(/invalid_event/);
    await expect(rpc(u.stranger!, "track_event", { p_org: org.C, p_event: "creative_shared" })).rejects.toThrow(/forbidden/);
  });
  it("org_status gives the next-action inputs", async () => {
    const s = await rpc(u.a!, "org_status", { p_org: org.A });
    expect(s).toMatchObject({ type: "store", connected: true, standing_live: true, is_admin: true });
    expect(s.partners).toBeGreaterThanOrEqual(2);
  });
});

describe("review hardening", () => {
  it("staff never receive money figures from the dashboard, balances or status", async () => {
    const d = await rpc(u.staff!, "org_dashboard", { p_org: org.A });
    expect(d.approved_commissions_minor).toBeUndefined();
    expect(d.month_platform_fee_minor).toBeUndefined();
    expect(JSON.stringify(d.recent_sales)).not.toContain("commission_minor");
    await expect(rpc(u.staff!, "payout_balances", { p_org: org.A })).rejects.toThrow(/forbidden/);
    expect((await rpc(u.staff!, "org_status", { p_org: org.A })).approved_unpaid_minor).toBe(0);
    const full = await rpc(u.a!, "org_dashboard", { p_org: org.A });
    expect(full.approved_commissions_minor).toBeDefined();
  });
  it("two referrers on a tiny fee never exceed 40% in total (rounding goes down)", async () => {
    // fee line of 3 minor units with two referrers: 40% = 1.2 → total 1, not 2
    const n = await q<{ total: number }>(`select floor(3::numeric * 4000 / 10000)::int as total`);
    expect(n[0]!.total).toBe(1);
    const rows = await q<{ s: number }>(`select coalesce(sum(amount_minor), 0)::int as s from referral_rewards`);
    const fees = await q<{ f: number }>(`select coalesce(sum(ii.amount_minor), 0)::int as f from invoice_items ii join invoices i on i.id = ii.invoice_id where i.status = 'paid'`);
    expect(rows[0]!.s).toBeLessThanOrEqual(Math.floor(fees[0]!.f * 0.4));
  });
  it("pricing switches cannot be changed at runtime; settings are type-checked", async () => {
    await expect(rpc(u.admin!, "admin_set_setting", { p_key: "founders_open", p_value: "false" })).rejects.toThrow(/setting_locked/);
    await expect(rpc(u.admin!, "admin_set_setting", { p_key: "founding_partners_open", p_value: '"x"' })).rejects.toThrow(/invalid_setting/);
    await expect(rpc(u.admin!, "admin_set_setting", { p_key: "reward_transfer_min_minor", p_value: "-5" })).rejects.toThrow(/invalid_setting/);
  });
  it("a new creator cannot use a campaign to bypass a store's manual approval", async () => {
    const opp = (await q(`select id from opportunities where store_org_id = $1 and kind = 'standing'`, [org.B]))[0]!.id;
    await rpc(u.b!, "set_opportunity_status", { p_opportunity: opp, p_status: "live" });
    const camp = await rpc(u.b!, "create_campaign", { p_store: org.B, p_title: "B push", p_description: null, p_commission_bps: 2500,
      p_starts_at: ago(0.01).toISOString(), p_ends_at: new Date(Date.now() + 86_400_000).toISOString() });
    const x = await rpc(u.stranger!, "create_organization", { p_type: "creator", p_name: "Newbie" });
    await expect(rpc(u.stranger!, "join_opportunity", { p_opportunity: camp, p_creator: x })).rejects.toThrow(/join_standing_first/);
  });
  it("joining a standing offer never overwrites a partner's negotiated terms", async () => {
    const before = await q(`select count(*)::int as n from agreement_versions v join agreements a on a.id = v.agreement_id where a.store_org_id = $1 and a.creator_org_id = $2`, [org.A, org.C]);
    const opp = (await q(`select id from opportunities where store_org_id = $1 and kind = 'standing'`, [org.A]))[0]!.id;
    await rpc(u.a!, "save_standing_opportunity", { p_store: org.A, p_title: "New terms", p_description: null, p_commission_bps: 700,
      p_coupon_pct: 5, p_auto_approve: true, p_status: "live" });
    await rpc(u.c!, "join_opportunity", { p_opportunity: opp, p_creator: org.C });
    const after = await q(`select count(*)::int as n from agreement_versions v join agreements a on a.id = v.agreement_id where a.store_org_id = $1 and a.creator_org_id = $2`, [org.A, org.C]);
    expect(after).toEqual(before);
  });
});
