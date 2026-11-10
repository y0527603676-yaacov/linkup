import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { Browser } from "playwright";
import { createDb, createUser, type Db, type Who } from "../db/harness";
import { normalizeConnectionId, verifySignature } from "../../../../supabase/functions/woo/hmac";
import { wpAuthorizeUrl, wpSetup, type WpCreds } from "../../src/lib/wp-connect";

/**
 * End-to-end on a REAL WordPress (6.5.5) running locally in isolation (see README.md):
 * LINKUP consent → WordPress's own approval page (Application Passwords) → automatic install + activation + configuration
 * of the LINKUP Connector → temporary access revoked → a visitor arrives through a creator link (30-day cookie) →
 * buys 7 days later → the plugin reports the order with a signed request → LINKUP's database attributes it to the creator →
 * the store disconnects in LINKUP → the plugin stops by itself → the store removes the plugin → its settings are deleted.
 * Only stand-ins: the WordPress.org directory entry (serves the same zip locally), WooCommerce (minimal order store with
 * the real hooks), and LINKUP's "woo" endpoint (emulated below with the same signature check and database functions).
 */
// Playwright is pre-installed globally in this environment (not an app dependency).
const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");
const SITE = "http://127.0.0.1:8090";
const RETURN = "http://127.0.0.1:8091/app/connect/wp-return";
const APP_ID = "6f1c0d5e-3b7a-4c2e-9a41-0b9d2c7e5f11";
const ADMIN = { user: "storeadmin", pass: "Adm1n-Test-Only!" };
const EDITOR = { user: "editor1", pass: "Ed1tor-Test-Only!" };
const DAY = 86_400;

let db: Db; let browser: Browser; let endpoint: Server; let returnPage: Server;
let lastReturn = "";   // LINKUP's return page (stand-in): WordPress sends the owner back here after approval
const svc: Who = { role: "service_role" };
const u: Record<string, Who> = {};
let storeOrg = "", creatorOrg = "", code = "", conn = "";
const endpointCalls: { action: string; status: number; body: any }[] = [];

const call = async <T = any>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const keys = Object.keys(args);
  const row = await db.one<{ r: T }>(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
    keys.map((k) => (args[k] !== null && typeof args[k] === "object" && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k])));
  return row.r;
};
const wpState = async (user = "storeadmin") =>
  (await fetch(`${SITE}/wp-json/linkup-test/v1/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user }) })).json();
const testState = async (body: Record<string, unknown>) =>
  (await fetch(`${SITE}/wp-json/linkup-test/v1/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

/** LINKUP's plugin endpoint (supabase/functions/woo/index.ts) – same checks, same database functions, same responses. */
function startEndpoint() {
  const PERMANENT = new Set(["invalid_event", "unknown_connection", "connection_disconnected"]);
  return createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const send = (status: number, body: unknown, action = "?") => {
      endpointCalls.push({ action, status, body }); res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body));
    };
    const id = normalizeConnectionId(String(req.headers["x-linkup-connection"] ?? ""));
    if (!id) return send(401, { error: "unauthorized" });
    const sec = await db.as<{ secret: string }>({ role: "owner" }, `select secret from store_connection_secrets where connection_id = $1`, [id]);
    const ok = sec[0] && await verifySignature(raw, String(req.headers["x-linkup-signature"] ?? "").toLowerCase(),
      Number(req.headers["x-linkup-timestamp"]), sec[0].secret, Math.floor(Date.now() / 1000));
    if (!ok) return send(401, { error: "unauthorized" });
    const body = JSON.parse(raw);
    try {
      const result = body.action === "sync" ? await call(svc, "plugin_sync", { p_connection: id, p_plugin_version: String(body.plugin_version ?? "") })
        : body.action === "event" ? await call(svc, "ingest_order_event", { p_connection: id, p_event: body.event })
        : body.action === "products" ? await call(svc, "plugin_sync_products", { p_connection: id, p_products: JSON.stringify(body.products ?? []), p_full_started_at: body.full_started_at ?? null })
        : undefined;
      if (result === undefined) return send(400, { error: "unknown_action" }, body.action);
      send(200, { ok: true, result }, body.action);
    } catch (e: any) {
      const m = String(e?.message ?? ""); const c = PERMANENT.has(m) ? m : "temporary_error";
      send(c === "temporary_error" ? 503 : 422, { error: c }, body.action);
    }
  }).listen(8092, "127.0.0.1");
}

/** The store owner signs in to their WordPress and clicks "Yes, I approve" on WordPress's own page. */
async function approveInWordPress(who: { user: string; pass: string }, state: string): Promise<WpCreds> {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  try {
    await page.goto(`${SITE}/wp-login.php`);
    await page.fill("#user_login", who.user); await page.fill("#user_pass", who.pass); await page.click("#wp-submit");
    await page.waitForURL(/wp-admin/);
    lastReturn = "";
    await page.goto(wpAuthorizeUrl(SITE, APP_ID, `${RETURN}?state=${state}`, `${RETURN}?state=${state}&rejected=1`));
    expect(await page.textContent("body")).toContain("LINKUP");      // WordPress shows who is asking
    await page.click("#approve");
    await expect.poll(() => lastReturn, { timeout: 15_000 }).not.toBe("");
    const q = new URL(lastReturn, RETURN).searchParams;
    expect(q.get("state")).toBe(state);
    return { site: q.get("site_url")!, user: q.get("user_login")!, password: q.get("password")! };
  } finally { await ctx.close(); }
}

const CONSENT_TEXT = "I approve installing the LINKUP Connector on my store, temporary access to set it up, and I will tell visitors about the linkup_ref cookie.";
const ITEMS = ["install_component", "store_access", "visitor_notice"];
const startConnect = (items = ITEMS) =>
  call<{ state: string; site_url: string }>(u.s!, "start_wp_connect", { p_org: storeOrg, p_site_url: SITE, p_items: items, p_consent_text: CONSENT_TEXT, p_user_agent: "e2e" });
const newKey = async () => {
  const r = await call<{ connection_key: string; connection_id: string }>(u.s!, "create_store_connection", { p_org: storeOrg, p_site_url: "https://wp-e2e.example.test" })  // the loopback test address is not a public URL;
  conn = r.connection_id; return r.connection_key;
};

beforeAll(async () => {
  const up = await fetch(SITE).then(async (r) => { await r.arrayBuffer(); return r; }).catch(() => null);
  if (!up) throw new Error(`The isolated WordPress test site is not running at ${SITE} (see tests/e2e-wp/README.md)`);
  db = await createDb();
  endpoint = startEndpoint();
  returnPage = createServer((req, res) => { lastReturn = req.url ?? ""; res.end("ok"); }).listen(8091, "127.0.0.1");
  browser = await chromium.launch();
  for (const k of ["s", "c"]) u[k] = { role: "authenticated", userId: await createUser(db, `${k}@wp-e2e.test`) };
  storeOrg = await call(u.s!, "create_organization", { p_type: "store", p_name: "WP test store" });
  creatorOrg = await call(u.c!, "create_organization", { p_type: "creator", p_name: "Creator WP" });
  await db.as({ role: "owner" }, `update organizations set is_test = true where id in ($1, $2)`, [storeOrg, creatorOrg]);
  const p = await call(u.s!, "create_proposal", { p_from_org: storeOrg, p_commission_bps: 1000, p_invitee_name: "C", p_invitee_contact: null,
    p_coupon_discount_pct: 10, p_attribution_days: 30, p_target_site_url: null, p_source_proposal: null });
  code = (await call(u.c!, "accept_proposal", { p_token: p.token, p_org: creatorOrg })).code;
  await db.transaction(async (tx) => {   // the agreement must already be in force on the simulated click day (7 days ago)
    await tx.exec(`set local session_replication_role = replica`);
    await tx.query(`update agreement_versions set effective_from = now() - interval '30 days'`);
  });
  // clean slate on the WordPress side: plugin not present, directory entry available
  await testState({ directory: true });
}, 120_000);

afterAll(async () => { await browser?.close(); endpoint?.close(); returnPage?.close(); });

describe("consent is required and recorded before anything happens", () => {
  it("refuses without every consent item", async () => {
    await expect(startConnect(["install_component", "store_access"])).rejects.toThrow(/consent_required/);
  });
  it("refuses plain http for a real (non-test) store", async () => {
    await db.as({ role: "owner" }, `update organizations set is_test = false where id = $1`, [storeOrg]);
    await expect(startConnect()).rejects.toThrow(/https_required|not_available/);
    await db.as({ role: "owner" }, `update organizations set is_test = true where id = $1`, [storeOrg]);
  });
});

describe("one approval → installed, activated, configured, access revoked", () => {
  let state = "";
  it("records the owner's consent (version, items, exact text) and issues a one-time state", async () => {
    state = (await startConnect()).state;
    const rec = await db.as<any>({ role: "owner" }, `select items, consent_text, consent_version, site_url from store_install_consents where org_id = $1`, [storeOrg]);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ items: ITEMS, consent_text: CONSENT_TEXT, consent_version: "2026-11-11" });
    expect((await call(u.s!, "wp_connect_check", { p_state: state })).expired).toBe(false);
  });

  it("the owner approves on WordPress; LINKUP installs + activates + configures and deletes the temporary password", async () => {
    const before = await wpState();
    expect(before.plugin_installed).toBe(false);
    const creds = await approveInWordPress(ADMIN, state);
    expect(creds.user).toBe("storeadmin");
    expect((await wpState()).app_passwords).toBe(1);

    const r = await wpSetup(creds, fetch, newKey, "notice");
    expect(r).toMatchObject({ ok: true, code: "connected", installed: true, activated: true, configured: true, revoked: true });
    await call(u.s!, "wp_connect_finish", { p_state: state, p_outcome: r.code, p_details: JSON.stringify(r) });

    const after = await wpState();
    expect(after).toMatchObject({ plugin_installed: true, plugin_active: true, key_saved: true, consent_mode: "notice", app_passwords: 0 });
    // the creator's personal coupon was created in the store, marked as LINKUP-managed
    expect(after.coupons).toContainEqual(expect.objectContaining({ code, amount: 10, status: "publish", meta: { _linkup_managed: "1" } }));
    // the plugin's first signed sync reached LINKUP and was accepted
    expect(endpointCalls.find((c) => c.action === "sync")?.status).toBe(200);
    const sc = await db.as<any>({ role: "owner" }, `select status, plugin_version from store_connections where id = $1`, [conn]);
    expect(sc[0]).toMatchObject({ status: "connected", plugin_version: "0.4.1" });
  }, 90_000);

  it("the temporary password no longer works", async () => {
    // (it was deleted inside wpSetup; any further use is refused by WordPress)
    expect((await wpState()).app_passwords).toBe(0);
  });

  it("the state cannot be reused", async () => {
    await expect(call(u.s!, "wp_connect_finish", { p_state: state, p_outcome: "x", p_details: "{}" })).rejects.toThrow(/invalid_state/);
  });
});

describe("visitor through a creator link → purchase 7 days later → attributed", () => {
  let cookie = "";
  it("the link sets a first-party 30-day cookie on the store's own domain", async () => {
    const res = await fetch(`${SITE}/?lku=${code}`, { redirect: "manual" }); await res.arrayBuffer();
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(new RegExp(`linkup_ref=${code}%7C\\d+`));
    expect(sc).toMatch(/HttpOnly/i); expect(sc).toMatch(/SameSite=Lax/i);
    const maxAge = Number(/Max-Age=(\d+)/i.exec(sc)?.[1]);
    expect(Math.abs(maxAge - 30 * DAY)).toBeLessThan(120);
    cookie = decodeURIComponent(/linkup_ref=([^;]+)/.exec(sc)![1]!);
  });

  it("the same browser returns 7 days later (cookie still valid) and buys without a coupon", async () => {
    const [c, ts] = cookie.split("|");
    const keptCookie = `${c}|${Number(ts) - 7 * DAY}`;      // what the browser holds after 7 days
    const r = await (await fetch(`${SITE}/wp-json/linkup-test/v1/checkout`, { method: "POST",
      headers: { "content-type": "application/json", cookie: `linkup_ref=${encodeURIComponent(keptCookie)}` }, body: "{}" })).json();
    expect(r.meta_ref).toBe(keptCookie);
    await expect.poll(() => endpointCalls.filter((x) => x.action === "event" && x.status === 200).length, { timeout: 10_000 }).toBe(1);
    const a = await db.as<any>({ role: "owner" },
      `select (select name from organizations where id = a.creator_org_id) creator, a.method from orders o join attributions a on a.order_id = o.id
        where o.external_order_id = $1 and o.connection_id = $2`, [String(r.order_id), conn]);
    expect(a[0]).toMatchObject({ creator: "Creator WP", method: "link" });
  });
});

describe("visitor consent", () => {
  it("store chose 'only after consent' and the site has no consent banner integration → no cookie is set; coupons still work", async () => {
    await testState({ consent_mode: "require" });
    const res = await fetch(`${SITE}/?lku=${code}`, { redirect: "manual" }); await res.arrayBuffer();
    expect(res.headers.get("set-cookie") ?? "").not.toMatch(/linkup_ref=/);
    await testState({ consent_mode: "notice" });
  });
});

describe("refusals still revoke the temporary access", () => {
  it("an editor (cannot manage plugins/WooCommerce) is refused; nothing changes; the password is deleted", async () => {
    const st = (await startConnect()).state;
    const creds = await approveInWordPress(EDITOR, st);
    const r = await wpSetup(creds, fetch, async () => { throw new Error("must not be called"); });
    expect(r).toMatchObject({ ok: false, code: "not_store_admin", step: "access", revoked: true, installed: false });
    expect((await wpState("editor1")).app_passwords).toBe(0);
  }, 60_000);
});

describe("disconnect and removal", () => {
  it("disconnect in LINKUP: the plugin stops by itself on its next sync; history is kept", async () => {
    expect(await call(u.s!, "disconnect_store", { p_org: storeOrg })).toBeGreaterThan(0);
    const s = await testState({ run_sync: true });
    expect(endpointCalls.at(-1)).toMatchObject({ action: "sync", status: 422, body: { error: "connection_disconnected" } });
    expect(s.key_saved).toBe(false);
    // the creator's coupon is paused (draft), not deleted – no untracked discount stays active
    expect(s.coupons).toContainEqual(expect.objectContaining({ code, status: "draft" }));
    // a new order after disconnect is not sent anywhere
    const n = endpointCalls.length;
    await fetch(`${SITE}/wp-json/linkup-test/v1/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.arrayBuffer());
    expect(endpointCalls.length).toBe(n);
    const kept = await db.as<any>({ role: "owner" }, `select count(*)::int n from orders where connection_id = $1`, [conn]);
    expect(kept[0].n).toBe(1);
    const consents = await db.as<any>({ role: "owner" }, `select count(*)::int n from store_install_consents where org_id = $1`, [storeOrg]);
    expect(consents[0].n).toBeGreaterThanOrEqual(2);
  });

  it("the owner removes the plugin from WordPress: its settings are deleted (uninstall.php)", async () => {
    const st = (await startConnect()).state;
    const c = await approveInWordPress(ADMIN, st);
    const auth = { authorization: `Basic ${btoa(`${c.user}:${c.password}`)}`, "content-type": "application/json" };
    const base = `${SITE}/wp-json/wp/v2/plugins/linkup-connector/linkup-connector`;
    const deact = await fetch(base, { method: "POST", headers: auth, body: JSON.stringify({ status: "inactive" }) }); await deact.arrayBuffer(); expect(deact.status).toBe(200);
    const del = await fetch(base, { method: "DELETE", headers: auth }); await del.arrayBuffer(); expect(del.status).toBe(200);
    const s = await wpState();
    expect(s).toMatchObject({ plugin_installed: false, options_left: [] });
    expect(s.coupons.every((x: any) => x.status !== "publish")).toBe(true);   // nothing LINKUP created stays active
    // clean up the password used for this removal step
    const me = await (await fetch(`${SITE}/wp-json/wp/v2/users/me/application-passwords/introspect`, { headers: auth })).json();
    await fetch(`${SITE}/wp-json/wp/v2/users/me/application-passwords/${me.uuid}`, { method: "DELETE", headers: auth }).then((r) => r.arrayBuffer());
  }, 60_000);
});

describe("before WordPress.org listing", () => {
  it("not in the directory → clear 'not_in_directory', nothing installed, access revoked", async () => {
    await testState({ directory: false });
    const st = (await startConnect()).state;
    const creds = await approveInWordPress(ADMIN, st);
    const r = await wpSetup(creds, fetch, async () => "unused");
    expect(r).toMatchObject({ ok: false, code: "not_in_directory", step: "plugin", installed: false, revoked: true });
    expect(await wpState()).toMatchObject({ plugin_installed: false, app_passwords: 0 });
    await testState({ directory: true });
  }, 60_000);
});
