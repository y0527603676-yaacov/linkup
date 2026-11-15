import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";

/**
 * Attribution follows the collaboration's status at the time of the ORDER (not when LINKUP receives it).
 * A late-arriving order placed while the collaboration was active keeps its creator; an order placed after it
 * ended does not. Collaborations ended before the change log existed behave exactly as before.
 */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const u: Record<string, Who> = {};
const org: Record<string, string> = {};
const ag: Record<string, string> = {};
const code: Record<string, string> = {};
let conn = "";
let seq = 0;
const H = 3_600_000;

const call = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  const row = await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
    keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k])));
  return row.r;
};
const ev = (id: string, at: Date, o: Record<string, unknown> = {}) => ({
  event_id: `t-${id}-${++seq}`, type: "order.upserted", occurred_at: new Date().toISOString(),
  order: { id, status: "processing", currency: "ILS", total: 11_800, tax: 1_800, shipping: 0, shipping_tax: 0, coupons: [], ref: "", email_hash: "",
    created_at: at.toISOString(), refunds: [], ...o },
});
const ingest = (e: unknown) => call(svc, "ingest_order_event", { p_connection: conn, p_event: e });
const creatorOf = async (id: string) => (await db.as<{ c: string | null }>(owner,
  `select (select name from organizations where id = a.creator_org_id) c from orders o left join attributions a on a.order_id = o.id where o.external_order_id = $1`, [id]))[0]?.c ?? null;
const ago = (h: number) => new Date(Date.now() - h * H);
/** Moves the recorded time of the latest status change of an agreement (test only; the log is append-only). */
const backdateChange = async (agreement: string, hoursAgo: number) => db.transaction(async (tx) => {
  await tx.exec(`set local session_replication_role = replica`);
  await tx.query(`update agreement_status_changes set changed_at = now() - make_interval(hours => $2)
                   where id = (select max(id) from agreement_status_changes where agreement_id = $1)`, [agreement, hoursAgo]);
});

beforeAll(async () => {
  db = await createDb();
  for (const k of ["s", "a", "b", "c"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@ordertime.test`) };
  org.S = await call(u.s!, "create_organization", { p_type: "store", p_name: "Shop" });
  conn = (await call(u.s!, "create_store_connection", { p_org: org.S, p_site_url: "https://shop.example.com" })).connection_id;
  await call(svc, "plugin_sync", { p_connection: conn, p_plugin_version: "test" });
  for (const k of ["A", "B", "C"]) {
    const who = u[k.toLowerCase()]!;
    org[k] = await call(who, "create_organization", { p_type: "creator", p_name: `Creator ${k}` });
    const p = await call(u.s!, "create_proposal", { p_from_org: org.S, p_commission_bps: 1000, p_invitee_name: k, p_invitee_contact: null,
      p_coupon_discount_pct: 10, p_attribution_days: 30, p_target_site_url: null, p_source_proposal: null });
    code[k] = (await call(who, "accept_proposal", { p_token: p.token, p_org: org[k] })).code;
    ag[k] = (await db.one<{ id: string }>(owner, `select id from agreements where creator_org_id = $1`, [org[k]])).id;
  }
  await db.transaction(async (tx) => {
    await tx.exec(`set local session_replication_role = replica`);
    await tx.query(`update agreement_versions set effective_from = now() - interval '60 days'`);
  });
});

describe("agreement ended 2 hours ago", () => {
  beforeAll(async () => {
    await db.as(owner, `update agreements set status = 'ended' where id = $1`, [ag.A]);
    await backdateChange(ag.A!, 2);
  });
  it("records the status change", async () => {
    const r = await db.one<{ f: string; t: string }>(owner, `select from_status f, to_status t from agreement_status_changes where agreement_id = $1`, [ag.A]);
    expect(r).toEqual({ f: "active", t: "ended" });
  });
  it("coupon order placed 3 hours ago, received now → still attributed", async () => {
    await ingest(ev("LATE-C", ago(3), { coupons: [code.A!.toLowerCase()] }));
    expect(await creatorOf("LATE-C")).toBe("Creator A");
  });
  it("link order placed 3 hours ago, received now → still attributed", async () => {
    await ingest(ev("LATE-L", ago(3), { ref: `${code.A}|${Math.floor(ago(4).getTime() / 1000)}` }));
    expect(await creatorOf("LATE-L")).toBe("Creator A");
  });
  it("order placed 1 hour ago (after the end) → not attributed", async () => {
    await ingest(ev("AFTER", ago(1), { coupons: [code.A!.toLowerCase()] }));
    expect(await creatorOf("AFTER")).toBeNull();
  });
  it("an order dated in the future is judged by the current status", async () => {
    await ingest(ev("FUT", new Date(Date.now() + 2 * H), { coupons: [code.A!.toLowerCase()] }));
    expect(await creatorOf("FUT")).toBeNull();
  });
});

describe("paused, then active again", () => {
  beforeAll(async () => {
    await db.as(owner, `update agreements set status = 'paused' where id = $1`, [ag.B]);
    await backdateChange(ag.B!, 5);
    await db.as(owner, `update agreements set status = 'active' where id = $1`, [ag.B]);
    await backdateChange(ag.B!, 2);
  });
  it("order placed during the pause → not attributed", async () => {
    await ingest(ev("PAUSED", ago(3), { coupons: [code.B!.toLowerCase()] }));
    expect(await creatorOf("PAUSED")).toBeNull();
  });
  it("order placed before the pause → attributed", async () => {
    await ingest(ev("BEFORE-P", ago(6), { coupons: [code.B!.toLowerCase()] }));
    expect(await creatorOf("BEFORE-P")).toBe("Creator B");
  });
  it("order placed after reactivation → attributed", async () => {
    await ingest(ev("AFTER-P", ago(1), { coupons: [code.B!.toLowerCase()] }));
    expect(await creatorOf("AFTER-P")).toBe("Creator B");
  });
});

describe("agreement ended before the change log existed (no recorded change)", () => {
  it("keeps the previous behaviour: a late order is not attributed", async () => {
    await db.transaction(async (tx) => {
      await tx.exec(`set local session_replication_role = replica`);
      await tx.query(`update agreements set status = 'ended' where id = $1`, [ag.C]);
    });
    await ingest(ev("LEGACY", ago(48), { coupons: [code.C!.toLowerCase()] }));
    expect(await creatorOf("LEGACY")).toBeNull();
  });
});

describe("access", () => {
  it("the change log is not readable by users and cannot be edited", async () => {
    await expect(db.as(u.s!, `select * from agreement_status_changes`)).rejects.toThrow();
    await expect(db.as(owner, `delete from agreement_status_changes`)).rejects.toThrow();
  });
});
