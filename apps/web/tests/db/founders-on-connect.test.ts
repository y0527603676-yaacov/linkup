import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";

/** Founders clock at the first verified connection + one-time correction for stores that never connected (20261111101900). */
let db: Db;
const svc: Who = { role: "service_role" };
const owner: Who = { role: "owner" };
const rpc = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  return (await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]))).r;
};
const q = <T = any>(sql: string, p: unknown[] = []) => db.as<T>(owner, sql, p);
const correction = readFileSync(new URL("../../../../supabase/migrations/20261111101900_founders_on_connect.sql", import.meta.url), "utf8")
  .match(/do \$\$[\s\S]*?end \$\$;/)![0];
let u: Record<string, Who> = {}; const org: Record<string, string> = {};
const founders = async (o: string) => (await q(`select founders_until from organizations where id = $1`, [o]))[0].founders_until;

beforeAll(async () => {
  db = await createDb();
  for (const k of ["fresh", "never", "connected", "custom", "withorders"]) {
    u[k] = { role: "authenticated", userId: await createUser(db, `${k}@shop.co.il`) };
    org[k] = await rpc(u[k]!, "create_organization", { p_type: "store", p_name: `Store ${k}` });
  }
}, 120_000);

describe("founders period starts at the first verified connection", () => {
  it("issuing a key starts nothing; the first real connection starts the full period and locks the terms once", async () => {
    const k = await rpc(u.fresh!, "create_store_connection", { p_org: org.fresh, p_site_url: "fresh.co.il" });
    expect(await founders(org.fresh!)).toBeNull();
    expect((await q(`select count(*)::int n from fee_terms where store_org_id = $1`, [org.fresh]))[0].n).toBe(0);
    await rpc(svc, "plugin_sync", { p_connection: k.connection_id, p_plugin_version: "0.4.1" });
    const f = new Date(await founders(org.fresh!));
    expect(f.getTime()).toBeGreaterThan(Date.now() + 175 * 86400_000);
    expect((await q(`select kind, fee_bps from fee_terms where store_org_id = $1 and status = 'active' order by effective_from`, [org.fresh])))
      .toEqual([{ kind: "founders", fee_bps: 200 }, { kind: "standard", fee_bps: 300 }]);
    await q(`update store_connections set status = 'pending' where id = $1`, [k.connection_id]);
    await rpc(svc, "plugin_sync", { p_connection: k.connection_id, p_plugin_version: "0.4.1" });
    expect(new Date(await founders(org.fresh!)).getTime()).toBe(f.getTime());   // never restarted
  });
});

describe("one-time correction for stores that never connected", () => {
  it("resets only never-connected stores, keeps history, records the previous terms", async () => {
    // Old behaviour reproduced: a period and terms were set at key issuance.
    const old = new Date(Date.now() + 100 * 86400_000).toISOString();
    for (const k of ["never", "connected", "custom", "withorders"]) {
      await q(`update organizations set founders_until = $2 where id = $1`, [org[k], old]);
      await q(`select public.ensure_fee_terms($1)`, [org[k]]);
    }
    const ck = await rpc(u.connected!, "create_store_connection", { p_org: org.connected, p_site_url: "conn.co.il" });
    await q(`update store_connections set status = 'connected', last_sync_at = now() where id = $1`, [ck.connection_id]);
    await q(`update organizations set founders_until = $2 where id = $1`, [org.connected, old]);   // keep the old date for this check
    await q(`insert into fee_terms(store_org_id, kind, fee_bps, effective_from, source, note) values ($1, 'custom', 100, now(), 'individual_agreement', 'deal')`, [org.custom]);
    const wk = await rpc(u.withorders!, "create_store_connection", { p_org: org.withorders, p_site_url: "wo.co.il" });
    await q(`insert into orders(connection_id, store_org_id, external_order_id, currency, status, total_minor, base_minor, order_created_at, last_event_at)
             values ($1, $2, 'o1', 'ILS', 'completed', 1000, 847, now(), now())`, [wk.connection_id, org.withorders]);
    await rpc(u.never!, "create_store_connection", { p_org: org.never, p_site_url: "never.co.il" });   // key only, never connected
    const ledgerBefore = (await q(`select count(*)::int n from commission_ledger`))[0].n;

    await db.exec(correction);

    expect(await founders(org.never!)).toBeNull();
    expect((await q(`select status from fee_terms where store_org_id = $1`, [org.never])).map((r: any) => r.status)).toEqual(["withdrawn", "withdrawn"]);
    const c = (await q(`select kind, previous_founders_until, jsonb_array_length(previous_fee_terms) n from entitlement_corrections where org_id = $1`, [org.never]))[0];
    expect(c.kind).toBe("founders_reset_never_connected"); expect(c.n).toBe(2);
    expect(new Date(c.previous_founders_until).toISOString()).toBe(old);
    for (const k of ["connected", "custom", "withorders"]) {
      expect(new Date(await founders(org[k]!)).toISOString()).toBe(old);
      expect((await q(`select count(*)::int n from fee_terms where store_org_id = $1 and status = 'withdrawn'`, [org[k]]))[0].n).toBe(0);
    }
    expect((await q(`select count(*)::int n from commission_ledger`))[0].n).toBe(ledgerBefore);
    await expect(db.as(u.never!, `select * from public.entitlement_corrections`)).rejects.toThrow(/permission denied/);
    // History is still append-only.
    await expect(q(`delete from fee_terms where store_org_id = $1`, [org.never])).rejects.toThrow(/append_only/);
  });
  it("the corrected store gets the full period and fresh terms at its first real connection", async () => {
    const k = (await q(`select id from store_connections where org_id = $1`, [org.never]))[0].id;
    await rpc(svc, "plugin_sync", { p_connection: k, p_plugin_version: "0.4.1" });
    expect(new Date(await founders(org.never!)).getTime()).toBeGreaterThan(Date.now() + 175 * 86400_000);
    expect((await q(`select kind from fee_terms where store_org_id = $1 and status = 'active' order by effective_from`, [org.never])).map((r: any) => r.kind)).toEqual(["founders", "standard"]);
    expect((await q(`select count(*)::int n from fee_terms where store_org_id = $1`, [org.never]))[0].n).toBe(4);   // old (withdrawn) + new
  });
});
