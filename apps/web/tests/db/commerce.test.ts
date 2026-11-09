import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createDb, createUser, type Db, type Who } from "./harness";

/**
 * End-to-end commercial path at the database level, using the real migrations:
 * accounts → store connection → proposal → acceptance → coupon/link → orders → ledger,
 * plus tenant isolation and append-only financial history.
 */
let db: Db;
let store: Who, creator: Who, otherStore: Who, stranger: Who;
let storeOrg: string, creatorOrg: string, otherStoreOrg: string;
let connectionId: string;
let code: string;
const svc: Who = { role: "service_role" };
const anon: Who = { role: "anon" };

const rpc = async <T = any>(who: Who, fn: string, args: Record<string, unknown>): Promise<T> => {
  const keys = Object.keys(args);
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
  const row = await db.one<{ r: T }>(who, sql, keys.map((k) => args[k]));
  return row.r;
};

let seq = 0;
const event = (orderId: string, o: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  event_id: `e-${++seq}`,
  type: "order.upserted",
  occurred_at: new Date(Date.now() + seq * 1000).toISOString(),
  order: {
    id: orderId, status: "processing", currency: "ILS",
    total: 50_000, tax: 7_169, shipping: 3_000, shipping_tax: 0,
    coupons: [], ref: "", email_hash: "", created_at: new Date().toISOString(), refunds: [],
    ...o,
  },
  ...extra,
});
const ingest = (ev: unknown) => rpc(svc, "ingest_order_event", { p_connection: connectionId, p_event: JSON.stringify(ev) });
const ledgerTotals = async (orderExt: string) =>
  db.as<{ party_role: string; total: string }>({ role: "owner" },
    `select l.party_role, sum(l.amount_minor)::text as total from commission_ledger l
       join attributions a on a.id = l.attribution_id join orders o on o.id = a.order_id
      where o.external_order_id = $1 group by l.party_role`, [orderExt])
    .then((rows) => Object.fromEntries(rows.map((r) => [r.party_role, Number(r.total)])));

beforeAll(async () => {
  db = await createDb();
  store = { role: "authenticated", userId: await createUser(db, "owner@shop.co.il") };
  creator = { role: "authenticated", userId: await createUser(db, "Dana@Creator.com") };
  otherStore = { role: "authenticated", userId: await createUser(db, "x@other.co.il") };
  stranger = { role: "authenticated", userId: await createUser(db, "nobody@x.com") };
  storeOrg = await rpc(store, "create_organization", { p_type: "store", p_name: "Shop Yafe" });
  otherStoreOrg = await rpc(otherStore, "create_organization", { p_type: "store", p_name: "Other Shop" });
}, 60_000);

describe("accounts & store connection", () => {
  it("issues a connection key only to store admins", async () => {
    await expect(rpc(stranger, "create_store_connection", { p_org: storeOrg, p_site_url: "shop.co.il" })).rejects.toThrow(/forbidden/);
    const r = await rpc(store, "create_store_connection", { p_org: storeOrg, p_site_url: "shop.co.il/" });
    expect(r.connection_key).toMatch(/^lk_[0-9a-f]{32}_[0-9a-f]{64}$/);
    expect(r.site_url).toBe("https://shop.co.il");
    connectionId = r.connection_id;
  });

  it("secrets are never readable by clients", async () => {
    await expect(db.as(store, "select * from store_connection_secrets")).rejects.toThrow(/permission denied/);
    await expect(db.as(anon, "select * from organizations")).rejects.toThrow(/permission denied/);
  });

  it("clients cannot write tables directly", async () => {
    await expect(db.as(store, `update organizations set platform_fee_bps = 0 where id = $1`, [storeOrg])).rejects.toThrow(/permission denied/);
    await expect(db.as(store, `insert into commission_ledger(attribution_id) values (gen_random_uuid())`)).rejects.toThrow(/permission denied/);
  });

  it("service-only functions are not callable by users", async () => {
    await expect(rpc(store, "plugin_sync", { p_connection: connectionId })).rejects.toThrow(/permission denied/);
    await expect(rpc(store, "ingest_order_event", { p_connection: connectionId, p_event: "{}" })).rejects.toThrow(/permission denied/);
  });
});

describe("proposal → partnership", () => {
  let token: string;
  it("store creates proposal; anon sees terms before registration, without contact details", async () => {
    const p = await rpc(store, "create_proposal", { p_from_org: storeOrg, p_commission_bps: 1000, p_invitee_name: "Dana", p_invitee_contact: "050-0000000" });
    token = p.token;
    const pub = await rpc(anon, "get_public_proposal", { p_token: token });
    expect(pub.from_name).toBe("Shop Yafe");
    expect(pub.commission_bps).toBe(1000);
    expect(pub.status).toBe("opened");
    expect(JSON.stringify(pub)).not.toContain("050-0000000");
  });

  it("a store cannot accept a store→creator proposal; creator accepts and gets a code", async () => {
    await expect(rpc(otherStore, "accept_proposal", { p_token: token, p_org: otherStoreOrg })).rejects.toThrow(/wrong_org_type/);
    creatorOrg = await rpc(creator, "create_organization", { p_type: "creator", p_name: "Dana Cohen" });
    await expect(rpc(stranger, "accept_proposal", { p_token: token, p_org: creatorOrg })).rejects.toThrow(/forbidden/);
    const r = await rpc(creator, "accept_proposal", { p_token: token, p_org: creatorOrg });
    code = r.code;
    expect(code).toMatch(/^DANACOHE[0-9A-F]{4}$/);
    await expect(rpc(creator, "accept_proposal", { p_token: token, p_org: creatorOrg })).rejects.toThrow(/proposal_closed/);
  });

  it("records the referral (creator joined via the store's proposal)", async () => {
    const r = await db.one<{ n: string }>({ role: "owner" }, `select count(*)::text n from referrals where referrer_org_id = $1 and referred_org_id = $2`, [storeOrg, creatorOrg]);
    expect(r.n).toBe("1");
  });

  it("plugin sync returns the coupon to create and marks the store connected", async () => {
    const s = await rpc(svc, "plugin_sync", { p_connection: connectionId, p_plugin_version: "0.2.0" });
    expect(s.coupons).toEqual([{ code, discount_pct: 10, active: true }]);
    const link = await rpc(anon, "resolve_partner_link", { p_code: code.toLowerCase() });
    expect(link.url).toBe("https://shop.co.il");
  });
});

describe("sales & commissions", () => {
  it("coupon order → creator 10% and founders platform fee 2% on net base (excl. VAT & shipping)", async () => {
    const r = await ingest(event("1001", { coupons: [code.toLowerCase()] }));
    expect(r.attributed).toBe(true);
    // base = 50000 - 7169 - 3000 = 39831 → creator 3983, platform 2% = 797
    expect(await ledgerTotals("1001")).toEqual({ creator: 3983, platform: 797 });
  });

  it("duplicate event does not double the commission", async () => {
    const ev = event("1002", { coupons: [code] });
    await ingest(ev);
    expect((await ingest(ev)).status).toBe("duplicate");
    expect(await ledgerTotals("1002")).toEqual({ creator: 3983, platform: 797 });
  });

  it("partial refund reduces proportionally; full refund reverses to zero; history is kept", async () => {
    await ingest(event("1003", { coupons: [code] }));
    await ingest(event("1003", { coupons: [code], refunds: [{ id: "r1", amount: 25_000 }] }));
    expect(await ledgerTotals("1003")).toEqual({ creator: 1992, platform: 398 });
    await ingest(event("1003", { coupons: [code], status: "refunded", refunds: [{ id: "r1", amount: 25_000 }, { id: "r2", amount: 25_000 }] }));
    expect(await ledgerTotals("1003")).toEqual({ creator: 0, platform: 0 });
    const n = await db.one<{ n: string }>({ role: "owner" }, `select count(*)::text n from commission_ledger l join attributions a on a.id=l.attribution_id join orders o on o.id=a.order_id where o.external_order_id='1003'`);
    expect(Number(n.n)).toBe(6); // accrual + 2 reversals per party
  });

  it("an out-of-order (older) event does not overwrite newer state", async () => {
    await ingest(event("1004", { coupons: [code] }));
    const newer = event("1004", { coupons: [code], status: "cancelled" });
    const older = { ...event("1004", { coupons: [code], status: "processing" }), occurred_at: new Date(Date.now() - 3_600_000).toISOString() };
    await ingest(newer);
    await ingest(older);
    expect(await ledgerTotals("1004")).toEqual({ creator: 0, platform: 0 });
  });

  it("cancelled or unpaid orders create no commission", async () => {
    const r = await ingest(event("1005", { coupons: [code], status: "cancelled" }));
    expect(r.attributed).toBe(false);
    const r2 = await ingest(event("1006", { coupons: [code], status: "pending" }));
    expect(r2.attributed).toBe(false);
  });

  it("referral link inside the window attributes; outside the window does not", async () => {
    const inside = Math.floor(Date.now() / 1000) - 5 * 86_400;
    const outside = Math.floor(Date.now() / 1000) - 60 * 86_400;
    expect((await ingest(event("1007", { ref: `${code}|${inside}` }))).attributed).toBe(true);
    expect((await ingest(event("1008", { ref: `${code}|${outside}` }))).attributed).toBe(false);
  });

  it("flags self-referral when the buyer is the creator", async () => {
    const hash = createHash("sha256").update("dana@creator.com").digest("hex");
    await ingest(event("1009", { coupons: [code], email_hash: hash }));
    const a = await db.one<{ s: boolean }>({ role: "owner" }, `select a.self_referral_suspected s from attributions a join orders o on o.id=a.order_id where o.external_order_id='1009'`);
    expect(a.s).toBe(true);
  });

  it("another store's coupon code does not attribute (cross-store)", async () => {
    const other = await rpc(otherStore, "create_store_connection", { p_org: otherStoreOrg, p_site_url: "other.co.il" });
    const r = await rpc(svc, "ingest_order_event", { p_connection: other.connection_id, p_event: JSON.stringify(event("2001", { coupons: [code] })) });
    expect(r.attributed).toBe(false);
  });

  it("rejects malformed money values", async () => {
    await expect(ingest(event("1010", { total: "abc" }))).rejects.toThrow(/invalid_event/);
    await expect(ingest(event("1011", { total: -5 }))).rejects.toThrow(/invalid_event/);
  });
});

describe("financial history & isolation", () => {
  it("ledger rows cannot be edited or deleted, even by the database owner", async () => {
    await expect(db.as({ role: "owner" }, `update commission_ledger set amount_minor = 1`)).rejects.toThrow(/append_only/);
    await expect(db.as({ role: "owner" }, `delete from commission_ledger`)).rejects.toThrow(/append_only/);
    await expect(db.as({ role: "owner" }, `delete from agreement_versions`)).rejects.toThrow(/append_only/);
  });

  it("approval moves matured commissions pending → approved only after the refund window", async () => {
    await ingest(event("1012", { coupons: [code], status: "completed" }));
    expect(await rpc(svc, "approve_matured_commissions", {})).toBe(0);
    await db.exec(`update orders set completed_at = now() - interval '15 days' where external_order_id = '1012'`);
    expect(await rpc(svc, "approve_matured_commissions", {})).toBe(2);
  });

  it("other store sees none of this store's orders, ledger, partners or proposals", async () => {
    for (const t of ["orders", "commission_ledger", "attributions", "agreements", "proposals", "partner_codes", "order_events", "refunds"]) {
      const rows = await db.as(otherStore, `select * from ${t} where ${t === "order_events" ? "connection_id" : t === "refunds" ? "order_id in (select id from orders)" : t === "partner_codes" ? "true" : t === "proposals" ? "from_org_id" : "store_org_id"}${t === "order_events" ? " = $1" : t === "refunds" || t === "partner_codes" ? "" : " = $1"}`, t === "refunds" || t === "partner_codes" ? [] : [t === "order_events" ? connectionId : storeOrg]);
      expect(rows, t).toHaveLength(0);
    }
    await expect(rpc(otherStore, "org_dashboard", { p_org: storeOrg })).rejects.toThrow(/forbidden/);
  });

  it("creator sees own commissions but not the store's platform fee or raw orders", async () => {
    const ledger = await db.as<{ party_role: string }>(creator, `select party_role from commission_ledger`);
    expect(new Set(ledger.map((l) => l.party_role))).toEqual(new Set(["creator"]));
    expect(await db.as(creator, `select * from orders`)).toHaveLength(0);
    const dash = await rpc(creator, "org_dashboard", { p_org: creatorOrg });
    expect(dash.active_stores).toBe(1);
    expect(dash.partnerships[0].code).toBe(code);
  });

  it("store dashboard sums match the ledger", async () => {
    const d = await rpc(store, "org_dashboard", { p_org: storeOrg });
    const pending = await db.one<{ s: string }>({ role: "owner" }, `select coalesce(sum(amount_minor),0)::text s from commission_ledger where store_org_id=$1 and party_role<>'platform' and state='pending'`, [storeOrg]);
    expect(d.pending_commissions_minor).toBe(Number(pending.s));
    expect(d.active_partners).toBe(1);
    expect(d.fee_bps).toBe(200);
  });
});

describe("viral loop: creator invites a new store", () => {
  it("creator → store proposal, new store accepts, referral recorded, same code reused for existing pair", async () => {
    const p = await rpc(creator, "create_proposal", { p_from_org: creatorOrg, p_commission_bps: 1200, p_invitee_name: "Noa Shop", p_target_site_url: "noa.co.il" });
    expect(p.direction).toBe("creator_to_store");
    const newStoreUser: Who = { role: "authenticated", userId: await createUser(db, "noa@noa.co.il") };
    const newStore = await rpc(newStoreUser, "create_organization", { p_type: "store", p_name: "Noa Shop" });
    await expect(rpc(newStoreUser, "accept_proposal", { p_token: p.token, p_org: creatorOrg })).rejects.toThrow(/forbidden/);
    const r = await rpc(newStoreUser, "accept_proposal", { p_token: p.token, p_org: newStore });
    expect(r.version).toBe(1);
    const ref = await db.one<{ n: string }>({ role: "owner" }, `select count(*)::text n from referrals where referrer_org_id=$1 and referred_org_id=$2`, [creatorOrg, newStore]);
    expect(ref.n).toBe("1");

    // Existing pair, new terms → version 2, prospective, same code.
    const p2 = await rpc(store, "create_proposal", { p_from_org: storeOrg, p_commission_bps: 1500 });
    const r2 = await rpc(creator, "accept_proposal", { p_token: p2.token, p_org: creatorOrg });
    expect(r2.version).toBe(2);
    expect(r2.code).toBe(code);
  });

  it("rate-limits proposal creation", async () => {
    await db.exec(`update app_settings set value='2' where key='max_proposals_per_day'`);
    await expect(rpc(store, "create_proposal", { p_from_org: storeOrg })).rejects.toThrow(/rate_limited/);
    await db.exec(`update app_settings set value='50' where key='max_proposals_per_day'`);
  });
});

describe("implied VAT (prices include VAT, store reports tax = 0)", () => {
  it("ILS order without tax lines: base = (total − shipping) / 1.18", async () => {
    await ingest(event("3001", { coupons: [code], tax: 0, shipping: 3_000, shipping_tax: 0 }));
    // (50000 − 3000) / 1.18 = 39830.5 → 39831; creator 10% → 3983
    const r = await db.one<{ base: string }>({ role: "owner" }, `select base_minor::text base from orders where external_order_id='3001'`);
    expect(Number(r.base)).toBe(39831);
  });

  it("VAT-exempt store override (0) keeps the full amount; foreign currency is not reduced", async () => {
    await db.exec(`update organizations set implied_vat_bps = 0 where id = '${storeOrg}'`);
    await ingest(event("3002", { coupons: [code], tax: 0, shipping: 0, shipping_tax: 0, total: 40_000 }));
    await db.exec(`update organizations set implied_vat_bps = null where id = '${storeOrg}'`);
    await ingest(event("3003", { coupons: [code], tax: 0, shipping: 0, shipping_tax: 0, total: 40_000, currency: "USD" }));
    const rows = await db.as<{ id: string; base: string }>({ role: "owner" },
      `select external_order_id id, base_minor::text base from orders where external_order_id in ('3002','3003') order by 1`);
    expect(rows.map((r) => Number(r.base))).toEqual([40_000, 40_000]);
  });

  it("explicit tax lines still take precedence", async () => {
    await ingest(event("3004", { coupons: [code] })); // tax 7169 given
    const r = await db.one<{ base: string }>({ role: "owner" }, `select base_minor::text base from orders where external_order_id='3004'`);
    expect(Number(r.base)).toBe(39_831);
  });
});
