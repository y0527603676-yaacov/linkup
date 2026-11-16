import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";
import { buildMessage, type Pending } from "../../../../supabase/functions/push/core";

/** Sale alerts by Web Push: per-user device subscriptions, both sides of each sale, no retroactive pushes, scheduler-only sender. */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const u: Record<string, Who> = {};
const org: Record<string, string> = {};
let conn = "", code = "", seq = 0;

const call = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  const row = await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
    keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k])));
  return row.r;
};
const sale = (id: string) => call(svc, "ingest_order_event", { p_connection: conn, p_event: {
  event_id: `p-${id}-${++seq}`, type: "order.upserted", occurred_at: new Date().toISOString(),
  order: { id, status: "processing", currency: "ILS", total: 11_800, tax: 1_800, shipping: 0, shipping_tax: 0, coupons: [code.toLowerCase()],
    ref: "", email_hash: "", created_at: new Date().toISOString(), refunds: [] } } });
const sub = (who: Who, ep: string) => call(who, "push_subscribe", { p_endpoint: ep, p_p256dh: "BKey", p_auth: "auth", p_user_agent: "test" });
const arr = (a: string[]) => `{${a.map((x) => `"${x}"`).join(",")}}`;
const pending = async () => (await call<Pending[] | null>(svc, "push_pending", { p_limit: 50 })) ?? [];

beforeAll(async () => {
  db = await createDb();
  for (const k of ["s", "c", "x"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@push.test`) };
  org.S = await call(u.s!, "create_organization", { p_type: "store", p_name: "Shop" });
  conn = (await call(u.s!, "create_store_connection", { p_org: org.S, p_site_url: "https://shop.example.com" })).connection_id;
  await call(svc, "plugin_sync", { p_connection: conn, p_plugin_version: "test" });
  org.C = await call(u.c!, "create_organization", { p_type: "creator", p_name: "Creator" });
  const p = await call(u.s!, "create_proposal", { p_from_org: org.S, p_commission_bps: 1000, p_invitee_name: "C", p_invitee_contact: null,
    p_coupon_discount_pct: 10, p_attribution_days: 30, p_target_site_url: null, p_source_proposal: null });
  code = (await call(u.c!, "accept_proposal", { p_token: p.token, p_org: org.C })).code;
  await db.transaction(async (tx) => {
    await tx.exec(`set local session_replication_role = replica`);
    await tx.query(`update agreement_versions set effective_from = now() - interval '60 days'`);
  });
});

describe("subscriptions", () => {
  it("requires sign-in and a valid https endpoint", async () => {
    await expect(sub({ role: "anon" }, "https://push.example/a")).rejects.toThrow();
    await expect(sub(u.s!, "http://push.example/a")).rejects.toThrow(/invalid_input/);
  });
  it("each user sees only their own devices", async () => {
    await sub(u.x!, "https://push.example/x");
    const mine = await db.as<{ n: number }>(u.s!, `select count(*)::int n from push_subscriptions`);
    expect(mine[0]!.n).toBe(0);
    expect((await call<{ devices: number }>(u.x!, "push_status")).devices).toBe(1);
  });
  it("the sender's functions are closed to users", async () => {
    await expect(call(u.s!, "push_pending", { p_limit: 5 })).rejects.toThrow();
    await expect(call(u.s!, "push_vapid_private")).rejects.toThrow();
    await expect(call({ role: "anon" }, "push_check_cron", { p_token: "x" })).rejects.toThrow();
  });
});

describe("a sale", () => {
  it("history is never pushed: no sender call while nobody has a device", async () => {
    const before = (await db.one<{ n: number }>(owner, `select count(*)::int n from net.calls where url like '%/push'`)).n;
    await sale("NO-DEVICE");
    expect((await db.one<{ n: number }>(owner, `select count(*)::int n from net.calls where url like '%/push'`)).n).toBe(before);
  });
  it("with devices on both sides: wakes the sender and lists both alerts with amounts", async () => {
    await call(svc, "push_done", { p_notification_ids: arr((await pending()).map((n) => n.id)), p_ok: arr([]), p_gone: arr([]) });
    await sub(u.s!, "https://push.example/store");
    await sub(u.c!, "https://push.example/creator");
    const before = (await db.one<{ n: number }>(owner, `select count(*)::int n from net.calls where url like '%/push'`)).n;
    await sale("WITH-DEVICES");
    const calls = await db.as<{ h: Record<string, string> }>(owner, `select headers h from net.calls where url like '%/push' order by id`);
    expect(calls.length).toBeGreaterThan(before);
    expect(calls.at(-1)!.h["x-linkup-cron"]).toBeTruthy();
    const p = await pending();
    const store = p.find((n) => n.org_type === "store")!, creator = p.find((n) => n.org_type === "creator")!;
    expect(store.devices.map((d) => d.endpoint)).toEqual(["https://push.example/store"]);
    expect(creator.devices.map((d) => d.endpoint)).toEqual(["https://push.example/creator"]);
    expect(store.order_minor).toBeGreaterThan(0);
    expect(creator.commission_minor).toBeGreaterThan(0);
    expect(buildMessage(store).title).toContain("Creator");
    expect(buildMessage(creator).body).toContain("₪");
    expect(await pending()).toEqual([]); // claimed: a second sender run in parallel gets nothing
    await call(svc, "push_done", { p_notification_ids: arr(p.map((n) => n.id)), p_ok: arr(["https://push.example/store"]), p_gone: arr(["https://push.example/creator"]) });
    await db.as(owner, `update notifications set push_claimed_at = now() - interval '3 minutes' where pushed_at is not null`);
    expect(await pending()).toEqual([]); // delivered ones never come back
    const left = await db.as<{ e: string }>(owner, `select endpoint e from push_subscriptions order by 1`);
    expect(left.map((r) => r.e)).not.toContain("https://push.example/creator");
  });
  it("the scheduler token is checked", async () => {
    const tok = (await db.one<{ t: string }>(owner, `select decrypted_secret t from vault.decrypted_secrets where name = 'push_cron_token'`)).t;
    expect(await call(svc, "push_check_cron", { p_token: tok })).toBe(true);
    expect(await call(svc, "push_check_cron", { p_token: "nope" })).toBe(false);
  });
});

describe("messages", () => {
  const base: Pending = { id: "1", kind: "sale", org_id: "o", org_type: "store", locale: "he", payload: { partner: "דנה", store: "חנות", order_id: "x" },
    currency: "ILS", order_minor: 25_000, commission_minor: 2_500, devices: [] };
  it("store: partner and order amount", () => {
    const m = buildMessage(base);
    expect(m.title).toContain("דנה");
    expect(m.body).toMatch(/250/);
    expect(m.url).toBe("/app/notifications?org=o");
  });
  it("partner: store and commission", () => {
    const m = buildMessage({ ...base, org_type: "creator", kind: "first_sale" });
    expect(m.title).toContain("הראשונה");
    expect(m.body).toContain("חנות");
    expect(m.body).toMatch(/25/);
  });
  it("English", () => expect(buildMessage({ ...base, locale: "en" }).title).toContain("New sale through"));
});
