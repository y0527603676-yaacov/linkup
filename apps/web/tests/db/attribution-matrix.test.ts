import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";
import { mapOrder } from "../../../../supabase/functions/woo-api/core";

/**
 * Attribution matrix (the owner's acceptance list), on the real ingest function:
 * immediate / 1 day / 7 days / 29 days / 31 days, coupon vs link, two creators, plugin vs API (no plugin),
 * returning visitor without coupon, cancellation and refund after attribution, the same order from two channels.
 * Plugin path = the plugin's first-party cookie "CODE|time" on the order. API path = WooCommerce's own order data only.
 */
let db: Db;
const svc: Who = { role: "service_role" };
const u: Record<string, Who> = {};
const org: Record<string, string> = {};
let conn = "", codeA = "", codeB = "";
let seq = 0;
const DAY = 86_400;
const nowS = () => Math.floor(Date.now() / 1000);

const call = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  const row = await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
    keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k])));
  return row.r;
};
const ev = (id: string, o: Record<string, unknown> = {}, at = new Date()) => ({
  event_id: `m-${id}-${++seq}`, type: "order.upserted", occurred_at: at.toISOString(),
  order: { id, status: "processing", currency: "ILS", total: 11_800, tax: 1_800, shipping: 0, shipping_tax: 0, coupons: [], ref: "", email_hash: "",
    created_at: at.toISOString(), refunds: [], ...o },
});
const ingest = (e: unknown) => call(svc, "ingest_order_event", { p_connection: conn, p_event: e });
const who = async (id: string) => (await db.as<{ c: string | null; m: string | null }>({ role: "owner" },
  `select (select name from organizations where id = a.creator_org_id) c, a.method m from orders o left join attributions a on a.order_id = o.id where o.external_order_id = $1`, [id]))[0];
const creatorTotal = async (id: string) => Number((await db.one<{ s: string }>({ role: "owner" },
  `select coalesce(sum(l.amount_minor), 0)::text s from commission_ledger l join attributions a on a.id = l.attribution_id join orders o on o.id = a.order_id
    where o.external_order_id = $1 and l.party_role = 'creator'`, [id])).s);

beforeAll(async () => {
  db = await createDb();
  for (const k of ["s", "a", "b"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@matrix.test`) };
  org.S = await call(u.s!, "create_organization", { p_type: "store", p_name: "Shop" });
  org.A = await call(u.a!, "create_organization", { p_type: "creator", p_name: "Creator A" });
  org.B = await call(u.b!, "create_organization", { p_type: "creator", p_name: "Creator B" });
  conn = (await call(u.s!, "create_store_connection", { p_org: org.S, p_site_url: "https://shop.example.com" })).connection_id;
  await call(svc, "plugin_sync", { p_connection: conn, p_plugin_version: "test" });
  for (const [k, o] of [["A", org.A], ["B", org.B]] as const) {
    const p = await call(u.s!, "create_proposal", { p_from_org: org.S, p_commission_bps: 1000, p_invitee_name: k, p_invitee_contact: null,
      p_coupon_discount_pct: 10, p_attribution_days: 30, p_target_site_url: null, p_source_proposal: null });
    const r = await call(o === org.A ? u.a! : u.b!, "accept_proposal", { p_token: p.token, p_org: o });
    if (k === "A") codeA = r.code; else codeB = r.code;
  }
  // agreements must be effective before the earliest simulated click (29–31 days ago)
  await db.transaction(async (tx) => {
    await tx.exec(`set local session_replication_role = replica`);
    await tx.query(`update agreement_versions set effective_from = now() - interval '60 days'`);
  });
});

describe("link with the plugin (first-party cookie on the store, 30-day window)", () => {
  for (const [label, days, expected] of [["immediately", 0, "Creator A"], ["after 1 day", 1, "Creator A"], ["after 7 days", 7, "Creator A"],
    ["after 29 days", 29, "Creator A"], ["after 31 days (outside the window)", 31, null]] as const) {
    it(`click then purchase ${label}`, async () => {
      const id = `L${days}`;
      await ingest(ev(id, { ref: `${codeA}|${nowS() - days * DAY}` }));
      expect((await who(id))?.c ?? null).toBe(expected);
    });
  }
  it("a later click by creator B replaces A's cookie in the browser (last click) — the order carries B", async () => {
    await ingest(ev("LB", { ref: `${codeB}|${nowS() - 2 * DAY}` }));
    expect((await who("LB"))?.c).toBe("Creator B");
  });
});

describe("coupon (works with or without the plugin)", () => {
  it("a personal coupon attributes even 40 days after the click (no time window on a coupon)", async () => {
    await ingest(ev("C40", { coupons: [codeA.toLowerCase()] }));
    expect(await who("C40")).toMatchObject({ c: "Creator A", m: "coupon" });
  });
  it("collision: link from A, coupon from B → the coupon wins", async () => {
    await ingest(ev("AB", { ref: `${codeA}|${nowS() - DAY}`, coupons: [codeB.toLowerCase()] }));
    expect(await who("AB")).toMatchObject({ c: "Creator B", m: "coupon" });
  });
  it("two LINKUP coupons → the first one applied wins, one creator only", async () => {
    await ingest(ev("CC", { coupons: [codeB.toLowerCase(), codeA.toLowerCase()] }));
    expect(await who("CC")).toMatchObject({ c: "Creator B" });
  });
});

describe("API connection without the plugin (WooCommerce data only)", () => {
  const order = (id: number, meta: { key: string; value: string }[], coupon?: string) => ({
    id, status: "processing", currency: "ILS", total: "118.00", cart_tax: "18.00", shipping_total: "0", shipping_tax: "0",
    coupon_lines: coupon ? [{ code: coupon }] : [], refunds: [], billing: { email: "buyer@x.test" }, meta_data: meta,
    date_created_gmt: new Date().toISOString().slice(0, 19), date_modified_gmt: new Date().toISOString().slice(0, 19),
  });
  it("same-visit purchase from the link: attributed through WooCommerce Order Attribution", async () => {
    const start = new Date(Date.now() - 10 * 60_000).toISOString().slice(0, 19).replace("T", " ");
    await ingest(await mapOrder(order(9001, [{ key: "_wc_order_attribution_utm_source", value: "linkup" },
      { key: "_wc_order_attribution_utm_campaign", value: codeA }, { key: "_wc_order_attribution_session_start_time", value: start }])));
    expect(await who("9001")).toMatchObject({ c: "Creator A", m: "link" });
  });
  it("LIMITATION: the visitor returns days later directly to the store without the coupon → not attributed", async () => {
    // WooCommerce's built-in attribution cookies last one session; the new visit is recorded as direct/typein.
    await ingest(await mapOrder(order(9002, [{ key: "_wc_order_attribution_source_type", value: "typein" }])));
    expect((await who("9002"))?.c ?? null).toBeNull();
  });
  it("the same returning visitor who uses the creator's coupon → attributed", async () => {
    await ingest(await mapOrder(order(9003, [{ key: "_wc_order_attribution_source_type", value: "typein" }], codeA.toLowerCase())));
    expect(await who("9003")).toMatchObject({ c: "Creator A", m: "coupon" });
  });
});

describe("changes after attribution, counted once", () => {
  it("cancellation after attribution reverses the commission; history kept", async () => {
    await ingest(ev("X1", { coupons: [codeA] }));
    expect(await creatorTotal("X1")).toBeGreaterThan(0);
    await ingest(ev("X1", { coupons: [codeA], status: "cancelled" }, new Date(Date.now() + 60_000)));
    expect(await creatorTotal("X1")).toBe(0);
  });
  it("refund reduces proportionally", async () => {
    await ingest(ev("X2", { coupons: [codeA] }));
    const full = await creatorTotal("X2");
    await ingest(ev("X2", { coupons: [codeA], refunds: [{ id: "r1", amount: 5_900 }] }, new Date(Date.now() + 60_000)));
    expect(await creatorTotal("X2")).toBe(Math.round(full / 2));
  });
  it("the same order from the plugin and from the API (identical event id) is counted once", async () => {
    const o = { id: 9100, status: "processing", currency: "ILS", total: "118.00", cart_tax: "18.00", shipping_total: "0", shipping_tax: "0",
      coupon_lines: [{ code: codeA.toLowerCase() }], refunds: [], billing: { email: "b@x.test" }, meta_data: [],
      date_created_gmt: "2026-11-10T10:00:00", date_modified_gmt: "2026-11-10T10:05:00" };
    const e = await mapOrder(o);
    await ingest(e);
    const again = await ingest({ ...e });
    expect(again.status).toBe("duplicate");
    const [n] = await db.as<{ n: number }>({ role: "owner" }, `select count(*)::int n from commission_ledger l join attributions a on a.id = l.attribution_id
      join orders o on o.id = a.order_id where o.external_order_id = '9100' and l.party_role = 'creator'`);
    expect(n.n).toBe(1);
  });
});
