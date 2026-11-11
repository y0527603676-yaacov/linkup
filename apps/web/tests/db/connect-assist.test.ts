import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";

/** Connect measurement + help requests (migration 20261111101800). */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const u: Record<string, Who> = {};
const org: Record<string, string> = {};
const rpc = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  return (await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]))).r;
};
const q = <T = any>(sql: string, p: unknown[] = []) => db.as<T>(owner, sql, p);
const connect = async (who: Who, o: string, site: string) => {
  const k = await rpc(who, "create_store_connection", { p_org: o, p_site_url: site });
  await rpc(svc, "plugin_sync", { p_connection: k.connection_id, p_plugin_version: "0.4.1" });
};
const help = (who: Who, o: string, extra: Record<string, unknown> = {}) => rpc(who, "request_connect_help", {
  p_org: o, p_channel: "phone", p_phone: "050-1234567", p_preferred_time: "ערב", p_note: "", p_site: "https://x.co.il/shop", p_platform: "unknown", p_consent_remote: false, ...extra });

beforeAll(async () => {
  db = await createDb();
  for (const k of ["self", "guided", "assisted", "failing", "admin", "stranger", "member"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@shop.co.il`) };
  for (const k of ["self", "guided", "assisted", "failing"]) org[k] = await rpc(u[k]!, "create_organization", { p_type: "store", p_name: `Shop ${k}` });
  await q(`insert into memberships(user_id, org_id, role) values ($1, $2, 'member')`, [(u.member as any).userId, org.self]);
  await q(`insert into platform_admins(user_id) values ($1)`, [(u.admin as any).userId]);
}, 120_000);

describe("logging the connect flow", () => {
  it("store admins log steps; host only; repeated views logged once; members/strangers cannot", async () => {
    await rpc(u.self!, "log_connect_event", { p_org: org.self, p_event: "detected", p_site: "https://Shop-Self.co.il/path?x=1", p_platform: "woocommerce" });
    await rpc(u.self!, "log_connect_event", { p_org: org.self, p_event: "detected", p_site: "https://shop-self.co.il", p_platform: "woocommerce" });
    expect(await q(`select site_host, platform from connect_events where org_id = $1`, [org.self])).toEqual([{ site_host: "shop-self.co.il", platform: "woocommerce" }]);
    await expect(rpc(u.member!, "log_connect_event", { p_org: org.self, p_event: "detected" })).rejects.toThrow(/forbidden/);
    await expect(rpc(u.stranger!, "log_connect_event", { p_org: org.self, p_event: "detected" })).rejects.toThrow(/forbidden/);
    await expect(rpc(u.self!, "log_connect_event", { p_org: org.self, p_event: "connected" })).rejects.toThrow(/invalid_input/);   // only the system logs "connected"
    await expect(db.as(u.self!, `select * from public.connect_events`)).rejects.toThrow(/permission denied/);
  });
  it("'connected' is logged automatically, once, when the connection really connects", async () => {
    await connect(u.self!, org.self!, "shop-self.co.il");
    await q(`update store_connections set status = 'pending' where org_id = $1`, [org.self]);
    await q(`update store_connections set status = 'connected' where org_id = $1`, [org.self]);
    expect((await q(`select count(*)::int n from connect_events where org_id = $1 and event = 'connected'`, [org.self]))[0].n).toBe(1);
  });
});

describe("help requests", () => {
  it("phone / screen share / remote (remote only with consent); valid phone; one open request at a time", async () => {
    await expect(help(u.assisted!, org.assisted!, { p_channel: "remote" })).rejects.toThrow(/consent_required/);
    await expect(help(u.assisted!, org.assisted!, { p_phone: "abc" })).rejects.toThrow(/invalid_phone/);
    await expect(help(u.stranger!, org.assisted!)).rejects.toThrow(/forbidden/);
    const id = await help(u.assisted!, org.assisted!, { p_channel: "remote", p_consent_remote: true });
    await expect(help(u.assisted!, org.assisted!)).rejects.toThrow(/help_already_requested/);
    expect((await rpc(u.assisted!, "my_connect_help", { p_org: org.assisted }))).toMatchObject({ id, channel: "remote" });
    expect((await rpc(u.admin!, "admin_connect_help"))[0]).toMatchObject({ id, org: "Shop assisted", phone: "050-1234567", site_host: "x.co.il" });
    await expect(rpc(u.assisted!, "admin_connect_help")).rejects.toThrow(/forbidden/);
    await expect(db.as(u.assisted!, `select * from public.connect_help_requests`)).rejects.toThrow(/permission denied/);
  });
  it("only the platform admin closes as done; the phone number is removed when closed", async () => {
    const id = (await rpc(u.assisted!, "my_connect_help", { p_org: org.assisted })).id;
    await expect(rpc(u.assisted!, "close_connect_help", { p_id: id, p_status: "done" })).rejects.toThrow(/forbidden/);
    await rpc(u.admin!, "close_connect_help", { p_id: id, p_status: "done" });
    expect((await q(`select status, phone from connect_help_requests where id = $1`, [id]))[0]).toEqual({ status: "done", phone: "0000000" });
    expect(await rpc(u.assisted!, "my_connect_help", { p_org: org.assisted })).toBeNull();
    const id2 = await help(u.assisted!, org.assisted!);
    await rpc(u.assisted!, "close_connect_help", { p_id: id2, p_status: "cancelled" });
    await expect(rpc(u.assisted!, "close_connect_help", { p_id: id2, p_status: "cancelled" })).rejects.toThrow(/already_decided/);
  });
});

describe("funnel numbers (platform admin)", () => {
  it("self / guided / assisted / not connected, unsupported platforms and failure reasons", async () => {
    await rpc(u.guided!, "log_connect_event", { p_org: org.guided, p_event: "detected", p_site: "g.co.il", p_platform: "woocommerce" });
    await rpc(u.guided!, "log_connect_event", { p_org: org.guided, p_event: "guide_opened", p_site: "g.co.il", p_platform: "woocommerce" });
    await connect(u.guided!, org.guided!, "g.co.il");
    await rpc(u.assisted!, "log_connect_event", { p_org: org.assisted, p_event: "detected", p_site: "x.co.il", p_platform: "unknown" });
    await connect(u.assisted!, org.assisted!, "x.co.il");
    await rpc(u.failing!, "log_connect_event", { p_org: org.failing, p_event: "detected", p_site: "f.myshopify.com", p_platform: "shopify" });
    await rpc(u.failing!, "log_connect_event", { p_org: org.failing, p_event: "failed", p_site: "f.myshopify.com", p_platform: "shopify", p_reason: "unsupported_platform" });
    const s = await rpc(u.admin!, "connect_funnel_stats", { p_days: 30 });
    expect(s).toMatchObject({ stores_started: 4, connected: 3, connected_self: 1, connected_guided: 1, connected_assisted: 1, not_connected: 1,
      unsupported: { shopify: 1, unknown: 1 }, failure_reasons: [{ reason: "unsupported_platform", stores: 1 }], open_help_requests: 0 });
    await expect(rpc(u.self!, "connect_funnel_stats", { p_days: 30 })).rejects.toThrow(/forbidden/);
  });
});
