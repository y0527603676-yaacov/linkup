import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";

/**
 * Activity limits (migration 20261111101600): only owned activities count, empty activities stop counting after the
 * grace period, a high ceiling plus a daily rate limit stop abuse, and repeated/parallel submits never duplicate.
 */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const anon: Who = { role: "anon" };
const u: Record<string, Who> = {};

const rpc = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
  const row = await db.one<{ r: T }>(who, sql, keys.map((k) => args[k]));
  return row.r;
};
const q = <T = any>(sql: string, params: unknown[] = []) => db.as<T>(owner, sql, params);
const create = (who: Who, type: string, name: string) => rpc<string>(who, "create_organization", { p_type: type, p_name: name });
const uid = (who: Who) => (who as { userId: string }).userId;
/** Move a user's activities back in time (as if created earlier). */
const age = (who: Who, days: number) =>
  q(`update organizations set created_at = now() - make_interval(days => $2)
      where id in (select org_id from memberships where user_id = $1)`, [uid(who), days]);
const setting = (key: string, v: number) => q(`update app_settings set value = $2::jsonb where key = $1`, [key, String(v)]);

beforeAll(async () => {
  db = await createDb();
  for (const k of ["one", "multi", "both", "ten", "team", "grace", "rate", "dup", "par", "testu", "other"])
    u[k] = { role: "authenticated", userId: await createUser(db, `${k}@example.com`) };
}, 120_000);

describe("activity limits", () => {
  it("defaults: ceiling 50, 10 new per day, 7-day grace for activities never set up", async () => {
    const rows = await q<{ key: string; value: number }>(`select key, value from app_settings where key in
      ('max_activities_per_user','max_new_activities_per_day','unset_activity_grace_days') order by key`);
    expect(rows.map((r) => [r.key, Number(r.value)])).toEqual([
      ["max_activities_per_user", 50], ["max_new_activities_per_day", 10], ["unset_activity_grace_days", 7]]);
  });

  it("a user with one store", async () => {
    const id = await create(u.one!, "store", "Only Shop");
    expect(id).toBeTruthy();
    const qt = await rpc(u.one!, "my_activity_quota");
    expect(qt.used).toBe(1);
    expect(qt.unset.map((x: any) => x.id)).toEqual([id]);
  });

  it("a user with several stores", async () => {
    const ids = [await create(u.multi!, "store", "Shop A"), await create(u.multi!, "store", "Shop B"), await create(u.multi!, "store", "Shop C")];
    expect(new Set(ids).size).toBe(3);
  });

  it("a user who is both a creator and a store owner", async () => {
    const s = await create(u.both!, "store", "My Store");
    const c = await create(u.both!, "creator", "My Creator Page");
    expect(s).not.toBe(c);
    expect((await q(`select type from organizations where id in ($1,$2) order by type`, [s, c])).map((r: any) => r.type)).toEqual(["creator", "store"]);
  });

  it("the old cap is gone: 10 existing activities (incl. pending and empty ones) and an 11th can be added", async () => {
    for (let i = 0; i < 10; i++) {
      const id = await create(u.ten!, i % 2 ? "creator" : "store", `Act ${i}`);
      if (i === 0) await rpc(u.ten!, "create_store_connection", { p_org: id, p_site_url: "https://pending.example" }); // pending connection
      if (i === 9) await age(u.ten!, 2); // spread over days so the daily limit is not what we test here
    }
    expect(await create(u.ten!, "store", "Eleventh")).toBeTruthy();
  });

  it("memberships in other people's teams never use the user's quota", async () => {
    for (let i = 0; i < 5; i++) {
      const o = await create(u.other!, "store", `Team ${i}`);
      await q(`insert into memberships(user_id, org_id, role) values ($1, $2, 'admin')`, [uid(u.team!), o]);
    }
    await age(u.other!, 2);
    await setting("max_activities_per_user", 2);
    try {
      expect(await create(u.team!, "store", "Mine 1")).toBeTruthy();
      expect(await create(u.team!, "store", "Mine 2")).toBeTruthy();
      await expect(create(u.team!, "store", "Mine 3")).rejects.toThrow(/too_many_orgs/);
    } finally { await setting("max_activities_per_user", 50); }
  });

  it("failed or pending attempts stop counting after the grace period; set-up activities always count", async () => {
    await setting("max_activities_per_user", 3);
    try {
      const a = await create(u.grace!, "store", "Pending One");
      await rpc(u.grace!, "create_store_connection", { p_org: a, p_site_url: "https://never-finished.example" });
      const b = await create(u.grace!, "store", "Connected One");
      const r = await rpc(u.grace!, "create_store_connection", { p_org: b, p_site_url: "https://real.example" });
      await rpc(svc, "plugin_sync", { p_connection: r.connection_id, p_plugin_version: "0.4.1" });
      await create(u.grace!, "creator", "Empty Creator");
      await age(u.grace!, 1);
      await expect(create(u.grace!, "store", "Fourth")).rejects.toThrow(/too_many_orgs/);   // all three still in grace

      await age(u.grace!, 8);
      const qt = await rpc(u.grace!, "my_activity_quota");
      expect(qt.used).toBe(1);                                   // only the connected store
      expect(qt.unset.map((x: any) => x.name).sort()).toEqual(["Empty Creator", "Pending One"]);
      expect(await create(u.grace!, "store", "Fourth")).toBeTruthy();
      // nothing was deleted or changed
      expect((await q(`select count(*)::int n from memberships where user_id = $1`, [uid(u.grace!)]))[0].n).toBe(4);
      expect((await q(`select status from store_connections where org_id = $1`, [a]))[0].status).toBe("pending");
    } finally { await setting("max_activities_per_user", 50); }
  });

  it("anti-abuse: at most 10 new activities in 24 hours, with its own message", async () => {
    for (let i = 0; i < 10; i++) await create(u.rate!, "store", `Burst ${i}`);
    await expect(create(u.rate!, "store", "Burst 10")).rejects.toThrow(/activity_rate_limited/);
    const qt = await rpc(u.rate!, "my_activity_quota");
    expect([qt.today, qt.per_day]).toEqual([10, 10]);
    await age(u.rate!, 2);
    expect(await create(u.rate!, "store", "Next day")).toBeTruthy();
  });

  it("submitting the same activity twice returns the first one instead of a duplicate", async () => {
    const a = await create(u.dup!, "store", "Double Click");
    const b = await create(u.dup!, "store", "  double click ");
    expect(b).toBe(a);
    const c = await create(u.dup!, "creator", "Double Click");      // other type = a different activity
    expect(c).not.toBe(a);
    await q(`update organizations set created_at = now() - interval '11 minutes' where id = $1`, [a]);
    expect(await create(u.dup!, "store", "Double Click")).not.toBe(a); // deliberate second store later is allowed
  });

  it("parallel submits create one activity", async () => {
    const ids = await Promise.all([1, 2, 3, 4].map(() => create(u.par!, "store", "Parallel Shop")));
    expect(new Set(ids).size).toBe(1);
    expect((await q(`select count(*)::int n from memberships where user_id = $1`, [uid(u.par!)]))[0].n).toBe(1);
  });

  it("test activities are counted separately from real ones", async () => {
    await setting("max_activities_per_user", 2);
    try {
      await create(u.testu!, "store", "Real 1"); await create(u.testu!, "store", "Real 2");
      await expect(create(u.testu!, "store", "Real 3")).rejects.toThrow(/too_many_orgs/);
      await q(`insert into signup_allowlist(email) values ('testu@example.com')`);
      const t = await create(u.testu!, "store", "Test 1");
      expect((await q(`select is_test from organizations where id = $1`, [t]))[0].is_test).toBe(true);
      expect((await rpc(u.testu!, "my_activity_quota")).used).toBe(1);
    } finally { await setting("max_activities_per_user", 50); }
  });

  it("no access without sign-in; internals are not callable", async () => {
    await expect(create(anon, "store", "Anon Shop")).rejects.toThrow();
    await expect(rpc(anon, "my_activity_quota")).rejects.toThrow();
    await expect(rpc(u.one!, "activity_established", { p_org: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow(/permission denied/);
    await expect(rpc(u.one!, "create_organization_core", { p_type: "store", p_name: "Direct" })).rejects.toThrow(/permission denied/);
  });
});
