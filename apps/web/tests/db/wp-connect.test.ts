import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db, type Who } from "./harness";

/** "Connect with one approval": consent gate, consent record, one-time state, availability gate, disconnect. */
let db: Db;
const u: Record<string, Who> = {};
let org = "", other = "";
const ITEMS = ["install_component", "store_access", "visitor_notice"];
const TEXT = "What you approve: 1. install 2. temporary access 3. visitor notice — cookie mode notice";

const call = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  const row = await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
    keys.map((k) => (args[k] !== null && typeof args[k] === "object" && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k])));
  return row.r;
};
const start = (who: Who, o: string, site = "https://shop.example.com", items = ITEMS, text = TEXT) =>
  call<{ state: string; site_url: string }>(who, "start_wp_connect", { p_org: o, p_site_url: site, p_items: items, p_consent_text: text });

beforeAll(async () => {
  db = await createDb();
  for (const k of ["s", "x", "p"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@wpc.test`) };
  org = await call(u.s!, "create_organization", { p_type: "store", p_name: "Shop" });
  other = await call(u.x!, "create_organization", { p_type: "store", p_name: "Other" });
});

describe("availability", () => {
  it("closed by default for real stores (no setting change needed to keep it closed)", async () => {
    expect(await call(u.s!, "wp_connect_available", { p_org: org })).toBe(false);
    await expect(start(u.s!, org)).rejects.toThrow(/not_available/);
  });
  it("open for test accounts", async () => {
    await db.as({ role: "owner" }, `update organizations set is_test = true where id = $1`, [org]);
    expect(await call(u.s!, "wp_connect_available", { p_org: org })).toBe(true);
  });
});

describe("consent", () => {
  it("every item must be ticked, with the wording recorded", async () => {
    await expect(start(u.s!, org, undefined, ITEMS.slice(0, 2))).rejects.toThrow(/consent_required/);
    await expect(start(u.s!, org, undefined, ITEMS, "ok")).rejects.toThrow(/consent_required/);
  });
  it("only the store's own admin can start it", async () => {
    await expect(start(u.x!, org)).rejects.toThrow(/forbidden/);
  });
  it("HTTPS only (loopback only for test accounts)", async () => {
    await expect(start(u.s!, org, "http://shop.example.com")).rejects.toThrow(/https_required/);
    await db.as({ role: "owner" }, `update organizations set is_test = true where id = $1`, [other]);
    expect((await start(u.x!, other, "http://127.0.0.1:8090")).site_url).toBe("http://127.0.0.1:8090");
  });
  it("records the consent permanently; visible to the store's admins only", async () => {
    const r = await start(u.s!, org);
    expect(r.site_url).toBe("https://shop.example.com");
    const mine = await db.as<any>(u.s!, `select items, consent_text, consent_version from store_install_consents where org_id = $1`, [org]);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ items: ITEMS, consent_text: TEXT, consent_version: "2026-11-11" });
    expect(await db.as(u.x!, `select 1 from store_install_consents where org_id = $1`, [org])).toHaveLength(0);
    await expect(db.as(u.s!, `delete from store_install_consents where org_id = $1`, [org])).rejects.toThrow();
    const audit = await db.as<any>({ role: "owner" }, `select 1 from audit_events where org_id = $1 and action = 'store_connection.install_consented'`, [org]);
    expect(audit).toHaveLength(1);
  });
});

describe("one-time state", () => {
  it("only the person who started it can check/finish it, and only once", async () => {
    const { state } = await start(u.s!, org);
    await expect(call(u.x!, "wp_connect_check", { p_state: state })).rejects.toThrow(/not_found/);
    expect(await call(u.s!, "wp_connect_check", { p_state: state })).toMatchObject({ org_id: org, completed: false, expired: false });
    await call(u.s!, "wp_connect_finish", { p_state: state, p_outcome: "connected", p_details: { revoked: true } });
    await expect(call(u.s!, "wp_connect_finish", { p_state: state, p_outcome: "connected", p_details: {} })).rejects.toThrow(/invalid_state/);
    expect((await call(u.s!, "wp_connect_check", { p_state: state })).completed).toBe(true);
  });
  it("is rate-limited", async () => {
    for (let i = 0; i < 20; i++) {
      try { await start(u.s!, org); } catch (e: any) { expect(String(e.message)).toMatch(/too_many/); return; }
    }
    throw new Error("no rate limit");
  });
});

describe("disconnect", () => {
  it("store admin disconnects; plugin events are refused afterwards; history kept", async () => {
    const conn = (await call(u.s!, "create_store_connection", { p_org: org, p_site_url: "https://shop.example.com" })).connection_id;
    await call({ role: "service_role" }, "plugin_sync", { p_connection: conn, p_plugin_version: "0.4.1" });
    await expect(call(u.x!, "disconnect_store", { p_org: org })).rejects.toThrow(/forbidden/);
    expect(await call(u.s!, "disconnect_store", { p_org: org })).toBeGreaterThan(0);
    await expect(call({ role: "service_role" }, "plugin_sync", { p_connection: conn, p_plugin_version: "0.4.1" })).rejects.toThrow(/connection_disconnected/);
    expect(await db.as({ role: "owner" }, `select 1 from store_install_consents where org_id = $1`, [org])).not.toHaveLength(0);
  });
});

describe("one-store pilot", () => {
  let pilot = "", admin: Who;
  const settingsFingerprint = () => db.one<{ s: string }>({ role: "owner" },
    `select string_agg(key || '=' || value::text, ',' order by key) s from app_settings where key <> 'wp_connect_pilot_org'`);
  beforeAll(async () => {
    u.ps = { role: "authenticated", userId: await createUser(db, "pilot@wpc.test") };
    pilot = await call(u.ps!, "create_organization", { p_type: "store", p_name: "Pilot store" });
    admin = { role: "authenticated", userId: await createUser(db, "admin@wpc.test") };
    await db.as({ role: "owner" }, `insert into platform_admins(user_id) values ($1)`, [(admin as any).userId]);
  });
  it("nothing is open by default: no pilot store, the real store cannot start", async () => {
    expect(await call(u.ps!, "wp_connect_available", { p_org: pilot })).toBe(false);
    await expect(start(u.ps!, pilot)).rejects.toThrow(/not_available/);
  });
  it("only a platform admin can choose it; test accounts and non-stores are refused", async () => {
    await expect(call(u.ps!, "admin_set_wp_pilot_store", { p_org: pilot })).rejects.toThrow(/forbidden/);
    await expect(call(admin, "admin_set_wp_pilot_store", { p_org: org })).rejects.toThrow(/not_a_store/);   // org is a test account
  });
  it("allows exactly that one store; other real stores stay closed; nothing else changes", async () => {
    const before = await settingsFingerprint();
    u.o2 = { role: "authenticated", userId: await createUser(db, "other2@wpc.test") };
    const other2 = await call(u.o2!, "create_organization", { p_type: "store", p_name: "Other real" });
    await call(admin, "admin_set_wp_pilot_store", { p_org: pilot });
    expect(await call(u.ps!, "wp_connect_available", { p_org: pilot })).toBe(true);
    expect(await call(u.o2!, "wp_connect_available", { p_org: other2 })).toBe(false);
    expect((await start(u.ps!, pilot)).site_url).toBe("https://shop.example.com");
    await expect(start(u.ps!, pilot, "http://127.0.0.1:8090")).rejects.toThrow(/https_required|invalid_url/);   // a real store: HTTPS only
    expect((await settingsFingerprint()).s).toBe(before.s);   // sign-up, billing, rates, open flags untouched
    const audit = await db.as<any>({ role: "owner" }, `select 1 from audit_events where action = 'setting.wp_pilot_store'`);
    expect(audit.length).toBeGreaterThan(0);
  });
  it("choosing another store replaces it (one at a time); clearing closes it", async () => {
    await call(admin, "admin_set_wp_pilot_store", { p_org: null });
    expect(await call(u.ps!, "wp_connect_available", { p_org: pilot })).toBe(false);
  });
});
