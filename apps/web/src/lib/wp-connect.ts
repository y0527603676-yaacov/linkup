/**
 * One-approval setup of a WordPress/WooCommerce store.
 * Input: the temporary WordPress application password the store owner just approved on their own site.
 * Steps: check the approving user may manage plugins and WooCommerce → install (WordPress.org directory) or activate
 * the LINKUP Connector plugin → save the store's LINKUP key through the plugin → delete the temporary password.
 * The password is used only inside this call, is never stored or logged, and is revoked even if a step fails.
 */
export type WpCreds = { site: string; user: string; password: string };
export type WpStep = "access" | "woocommerce" | "plugin" | "configure" | "revoke";
export type WpResult = {
  ok: boolean; code: string; step: WpStep | null; installed: boolean; activated: boolean; configured: boolean; revoked: boolean;
  pluginVersion?: string;
};

export const PLUGIN_SLUG = "linkup-connector";
/** Until the plugin is listed on WordPress.org, WordPress cannot install it remotely: the owner uploads the zip once
 *  (WordPress's own upload page), and the one approval then activates and connects it. Flip after the listing is live. */
export const PLUGIN_LISTED = process.env.LINKUP_PLUGIN_LISTED === "1";
export const PLUGIN_FILE = "linkup-connector/linkup-connector";
/** Oldest LINKUP Connector version that has the remote setup routes. */
export const MIN_PLUGIN_VERSION = "0.4.0";
const older = (a: string, b: string) => {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0), pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0); }
  return false;
};
const WC_FILE = "woocommerce/woocommerce";

class WpError extends Error { constructor(public code: string, public step: WpStep, public status = 0) { super(code); } }

function client(c: WpCreds, f: typeof fetch) {
  const auth = `Basic ${btoa(`${c.user}:${c.password}`)}`;
  const site = c.site.replace(/\/+$/, "");
  let style: "pretty" | "query" | null = null;
  const url = (route: string, q = "") =>
    style === "query" ? `${site}/?rest_route=${encodeURIComponent(route)}${q ? `&${q}` : ""}` : `${site}/wp-json${route}${q ? `?${q}` : ""}`;
  const call = async (step: WpStep, method: string, route: string, body?: unknown, q = "") => {
    let res: Response;
    try {
      res = await f(url(route, q), { method, headers: { authorization: auth, "content-type": "application/json", accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(45_000) });
    } catch { throw new WpError("site_unreachable", step); }
    // Sites without pretty permalinks answer /wp-json with 404: retry once with ?rest_route=
    if (res.status === 404 && style === null && route === "/wp/v2/users/me") { style = "query"; return call(step, method, route, body, q); }
    if (style === null) style = "pretty";
    const text = await res.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, json };
  };
  return { call };
}

export async function wpSetup(c: WpCreds, f: typeof fetch, getKey: () => Promise<string>, consentMode: "notice" | "require" = "notice"): Promise<WpResult> {
  const r: WpResult = { ok: false, code: "unknown", step: null, installed: false, activated: false, configured: false, revoked: false };
  const wp = client(c, f);
  try {
    // 1. Who approved? Needs to manage plugins and WooCommerce (store owner / administrator).
    const me = await wp.call("access", "GET", "/wp/v2/users/me", undefined, "context=edit");
    if (me.status === 401 || me.status === 403) throw new WpError("access_denied", "access", me.status);
    if (me.status !== 200 || !me.json) throw new WpError("rest_unavailable", "access", me.status);
    const caps = (me.json.capabilities ?? {}) as Record<string, boolean>;
    if (!caps.activate_plugins || !caps.manage_woocommerce) throw new WpError("not_store_admin", "access");

    // 2. WooCommerce must be active.
    const wc = await wp.call("woocommerce", "GET", `/wp/v2/plugins/${WC_FILE}`);
    if (wc.status !== 200 || wc.json?.status !== "active") throw new WpError("woocommerce_inactive", "woocommerce", wc.status);

    // 3. LINKUP Connector: activate if present, otherwise install from the WordPress.org directory.
    const got = await wp.call("plugin", "GET", `/wp/v2/plugins/${PLUGIN_FILE}`);
    if (got.status === 200) {
      if (got.json?.status !== "active") {
        const act = await wp.call("plugin", "POST", `/wp/v2/plugins/${PLUGIN_FILE}`, { status: "active" });
        if (act.status !== 200 || act.json?.status !== "active") throw new WpError(String(act.json?.code ?? "activation_failed"), "plugin", act.status);
      }
      r.activated = true; r.pluginVersion = got.json?.version;
      if (r.pluginVersion && older(String(r.pluginVersion), MIN_PLUGIN_VERSION)) throw new WpError("plugin_outdated", "plugin");
    } else {
      if (!caps.install_plugins) throw new WpError("cannot_install_plugins", "plugin");
      const ins = await wp.call("plugin", "POST", "/wp/v2/plugins", { slug: PLUGIN_SLUG, status: "active" });
      if (ins.status === 201 || ins.status === 200) { r.installed = true; r.activated = ins.json?.status === "active"; r.pluginVersion = ins.json?.version; }
      else {
        const code = String(ins.json?.code ?? "");
        // Not listed in the directory (yet), or the host blocks installs (e.g. DISALLOW_FILE_MODS).
        throw new WpError(code === "plugins_api_failed" || ins.status === 404 ? "not_in_directory" : code === "rest_cannot_install_plugin" ? "installs_blocked" : code || "install_failed", "plugin", ins.status);
      }
      if (!r.activated) throw new WpError("activation_failed", "plugin");
    }

    // 4. Save the store's LINKUP key through the plugin (store managers only; the key is never echoed back).
    const key = await getKey();
    const cfg = await wp.call("configure", "POST", "/linkup/v1/connect", { key, consent_mode: consentMode });
    if (cfg.status === 404 && cfg.json?.code === "rest_no_route") throw new WpError("plugin_outdated", "configure", 404);
    if (cfg.status !== 200 || !cfg.json?.connected) throw new WpError(String(cfg.json?.code ?? "configure_failed"), "configure", cfg.status);
    r.configured = true;
    r.ok = true; r.code = "connected";
  } catch (e) {
    r.code = e instanceof WpError ? e.code.slice(0, 60) : "unknown";
    r.step = e instanceof WpError ? e.step : null;
  } finally {
    // 5. Always delete the temporary application password.
    try {
      const self = await wp.call("revoke", "GET", "/wp/v2/users/me/application-passwords/introspect");
      const uuid = self.json?.uuid;
      if (uuid) {
        const del = await wp.call("revoke", "DELETE", `/wp/v2/users/me/application-passwords/${uuid}`);
        r.revoked = del.status === 200 && del.json?.deleted === true;
      }
    } catch { /* reported as not revoked */ }
  }
  return r;
}

/** WordPress's own approval page for an application password (Application Passwords, WordPress 5.6+). */
export function wpAuthorizeUrl(site: string, appId: string, successUrl: string, rejectUrl: string, now = new Date()) {
  const u = new URL(`${site.replace(/\/+$/, "")}/wp-admin/authorize-application.php`);
  // WordPress requires a unique name per application password; a dated name also tells the owner what it was for.
  u.searchParams.set("app_name", `LINKUP setup ${now.toISOString().slice(0, 19).replace("T", " ")}`);
  u.searchParams.set("app_id", appId);
  u.searchParams.set("success_url", successUrl);
  u.searchParams.set("reject_url", rejectUrl);
  return u.toString();
}
