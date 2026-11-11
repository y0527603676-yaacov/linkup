import { describe, expect, it } from "vitest";
import { wpSetup } from "../../src/lib/wp-connect";

/** Fake WordPress REST for the plugin-version and route checks (the full flow runs against real WordPress in tests/e2e-wp). */
function fakeWp(opts: { version: string; connectRoute: boolean }) {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url); const m = init?.method ?? "GET"; calls.push(`${m} ${u.pathname}`);
    const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/wp-json/wp/v2/users/me") return j(200, { capabilities: { activate_plugins: true, manage_woocommerce: true, install_plugins: true } });
    if (u.pathname === "/wp-json/wp/v2/plugins/woocommerce/woocommerce") return j(200, { status: "active" });
    if (u.pathname === "/wp-json/wp/v2/plugins/linkup-connector/linkup-connector") return j(200, { status: "active", version: opts.version });
    if (u.pathname === "/wp-json/linkup/v1/connect") return opts.connectRoute ? j(200, { connected: true }) : j(404, { code: "rest_no_route" });
    if (u.pathname.endsWith("/introspect")) return j(200, { uuid: "u1" });
    if (u.pathname.endsWith("/application-passwords/u1") && m === "DELETE") return j(200, { deleted: true });
    return j(404, { code: "rest_no_route" });
  }) as typeof fetch;
  return { f, calls };
}
const creds = { site: "https://shop.example.com", user: "owner", password: "xxxx" };

describe("LINKUP Connector already installed", () => {
  it("an up-to-date plugin is activated/configured without reinstalling", async () => {
    const w = fakeWp({ version: "0.4.1", connectRoute: true });
    const r = await wpSetup(creds, w.f, async () => "lk_key");
    expect(r).toMatchObject({ ok: true, installed: false, activated: true, configured: true, revoked: true });
    expect(w.calls).not.toContain("POST /wp-json/wp/v2/plugins");
  });
  it("an old plugin version is reported as 'plugin_outdated' (no key sent), access still revoked", async () => {
    const w = fakeWp({ version: "0.3.1", connectRoute: false });
    let asked = false;
    const r = await wpSetup(creds, w.f, async () => { asked = true; return "lk_key"; });
    expect(r).toMatchObject({ ok: false, code: "plugin_outdated", revoked: true });
    expect(asked).toBe(false);
  });
  it("a plugin without the setup route (no version reported) is also 'plugin_outdated'", async () => {
    const w = fakeWp({ version: "", connectRoute: false });
    const r = await wpSetup(creds, w.f, async () => "lk_key");
    expect(r).toMatchObject({ ok: false, code: "plugin_outdated", revoked: true });
  });
});
