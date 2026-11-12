/**
 * Which e-commerce platform runs a store's public website? Read-only and polite: at most a few GET requests
 * (home page, then the WordPress REST index when the site looks like WordPress), short timeouts, small body limit.
 * SSRF-safe: HTTPS only, default port only, no IP literals, every hostname (including each redirect hop) must resolve
 * only to public addresses, and the connection is pinned to the address that was checked (no DNS-rebinding).
 * Detection is a hint for choosing the connection path. It is never proof that the visitor owns the store.
 */
import { lookup } from "node:dns/promises";
import https from "node:https";
import http from "node:http";
import net from "node:net";

export type Platform = "woocommerce" | "wordpress" | "shopify" | "wix" | "magento" | "unknown";
export type DetectError = "invalid_url" | "not_public" | "unreachable" | "timeout" | "http_error" | "too_many_redirects";
export type Detection = {
  ok: boolean;
  platform: Platform;
  url: string;                 // normalized origin the user typed (https://host)
  finalUrl: string;            // origin after redirects
  redirected: boolean;         // ended on a different host than typed
  linkupPlugin: boolean;       // LINKUP Connector's REST namespace is active
  shopifyDomain?: string;      // xxx.myshopify.com when the storefront exposes it (needed for the Shopify app approval)
  wooRest: boolean;            // WooCommerce REST namespaces are present
  restBlocked: boolean;        // WordPress, but its REST API is not reachable publicly
  status?: number;
  error?: DetectError;
};

type Page = { status: number; headers: Record<string, string>; body: string; url: string };
export type Fetcher = (url: string) => Promise<Page>;

const MAX_BODY = 600_000;
const TIMEOUT_MS = 7_000;
const MAX_REDIRECTS = 4;
const UA = "LINKUP-StoreCheck/1.0 (+https://linkup-tawny.vercel.app)";

/* ---------- address safety ---------- */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;            // this-net, private, loopback, multicast/reserved
    if (a === 100 && b >= 64 && b <= 127) return false;                        // CGNAT
    if (a === 169 && b === 254) return false;                                  // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && ip.startsWith("192.0.0.")) || (b === 0 && ip.startsWith("192.0.2.")))) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;                     // benchmarking
    if (a === 198 && b === 51 && ip.startsWith("198.51.100.")) return false;
    if (a === 203 && ip.startsWith("203.0.113.")) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return false;
    if (x.startsWith("::ffff:")) return isPublicAddress(x.slice(7));            // IPv4-mapped
    if (/^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff") || x.startsWith("2001:db8") || x.startsWith("64:ff9b")) return false;
    return true;
  }
  return false;
}

/** Normalizes what a store owner typed ("myshop.co.il", "https://www.myshop.co.il/shop?x=1") to an https origin. */
export function normalizeSite(input: string): string | null {
  let s = (input ?? "").trim();
  if (!s || s.length > 300 || /\s/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== "443" && u.port !== "80") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (net.isIP(host.replace(/^\[|\]$/g, ""))) return null;                  // no IP literals
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|corp|test|invalid|example)$/.test(host)) return null;
  return `https://${host}`;
}

async function safeLookup(host: string): Promise<string> {
  const all = await lookup(host, { all: true, verbatim: true });
  if (!all.length || all.some((a) => !isPublicAddress(a.address))) throw Object.assign(new Error("not_public"), { code: "not_public" });
  return all[0]!.address;
}

/** One GET with the connection pinned to a checked public address. */
export const publicFetch: Fetcher = async (url) => {
  const u = new URL(url);
  if (u.protocol !== "https:") throw Object.assign(new Error("not_https"), { code: "invalid_url" });
  const ip = await safeLookup(u.hostname);
  return await new Promise<Page>((resolve, reject) => {
    const req = https.request({
      host: ip, servername: u.hostname, port: 443, method: "GET", path: `${u.pathname}${u.search}`,
      headers: { host: u.hostname, "user-agent": UA, accept: "text/html,application/json;q=0.9,*/*;q=0.5", "accept-encoding": "identity" },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (c: Buffer) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); else res.destroy(); });
      const done = () => resolve({ status: res.statusCode ?? 0, headers: flat(res.headers), body: Buffer.concat(chunks).toString("utf8"), url });
      res.on("end", done); res.on("close", done);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "timeout" })));
    req.on("error", reject);
    req.end();
  });
};

/** For isolated local tests only (plain http to loopback). Never used by the app. */
export const localTestFetch: Fetcher = async (url) => {
  const u = new URL(url);
  return await new Promise<Page>((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port || 80, path: `${u.pathname}${u.search}`, method: "GET", timeout: TIMEOUT_MS,
      headers: { "user-agent": UA, accept: "text/html,application/json" } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: flat(res.headers), body: Buffer.concat(chunks).toString("utf8").slice(0, MAX_BODY), url }));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "timeout" })));
    req.on("error", reject); req.end();
  });
};

function flat(h: http.IncomingHttpHeaders): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) o[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  return o;
}

/** Follows up to MAX_REDIRECTS redirects; every hop is re-validated (HTTPS + public) by the fetcher. */
async function getFollow(url: string, f: Fetcher, allowHttp: boolean): Promise<Page> {
  let cur = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const p = await f(cur);
    if (p.status >= 300 && p.status < 400 && p.headers.location) {
      const next = new URL(p.headers.location, cur);
      if (next.protocol === "http:" && !allowHttp) next.protocol = "https:";  // try the secure version of an http redirect
      cur = next.toString();
      continue;
    }
    return { ...p, url: cur };
  }
  throw Object.assign(new Error("too_many_redirects"), { code: "too_many_redirects" });
}

/* ---------- classification (pure, tested with fixtures) ---------- */
export function classifyHome(p: { headers: Record<string, string>; body: string }): { platform: Platform; restHref: string | null } {
  const h = p.headers; const b = p.body.slice(0, MAX_BODY); const lb = b.toLowerCase();
  const restLink = /<([^>]+)>;\s*rel="https:\/\/api\.w\.org\/"/i.exec(h.link ?? "")?.[1]
    ?? /<link[^>]+rel=["']https:\/\/api\.w\.org\/["'][^>]*href=["']([^"']+)["']/i.exec(b)?.[1]
    ?? /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']https:\/\/api\.w\.org\/["']/i.exec(b)?.[1] ?? null;
  const isWp = !!restLink || /wp-content\/|wp-includes\//.test(lb) || /<meta[^>]+name=["']generator["'][^>]+content=["']wordpress/i.test(b);
  if (isWp) {
    const woo = /<meta[^>]+name=["']generator["'][^>]+content=["']woocommerce/i.test(b) || /wp-content\/plugins\/woocommerce\//.test(lb)
      || /\bwoocommerce(-page|-js|-no-js|_params)?\b/.test(lb) || /wc-block-|wc\/store/.test(lb);
    return { platform: woo ? "woocommerce" : "wordpress", restHref: restLink };
  }
  if (h["x-shopify-stage"] || h["x-shopid"] || /shopify/i.test(h["powered-by"] ?? "") || /cdn\.shopify\.com|shopify\.theme|myshopify\.com/.test(lb)) return { platform: "shopify", restHref: null };
  if (h["x-wix-request-id"] || /static\.wixstatic\.com|wix\.com website builder|_wixcssimports|wix-thunderbolt/.test(lb)) return { platform: "wix", restHref: null };
  if (/x-magento-vary|mage-cache/i.test(h["set-cookie"] ?? "") || /text\/x-magento-init|mage\/cookies|magento_|requirejs-config\.js/.test(lb)) return { platform: "magento", restHref: null };
  return { platform: "unknown", restHref: null };
}

export function namespacesOf(json: unknown): string[] {
  const n = (json as { namespaces?: unknown })?.namespaces;
  return Array.isArray(n) ? n.filter((x): x is string => typeof x === "string") : [];
}

export async function detectStore(input: string, opts: { fetcher?: Fetcher; allowHttp?: boolean } = {}): Promise<Detection> {
  const f = opts.fetcher ?? publicFetch;
  const url = opts.allowHttp ? (input.trim().replace(/\/+$/, "")) : normalizeSite(input);
  const base: Detection = { ok: false, platform: "unknown", url: url ?? "", finalUrl: url ?? "", redirected: false, linkupPlugin: false, wooRest: false, restBlocked: false };
  if (!url) return { ...base, error: "invalid_url" };
  let home: Page;
  try { home = await getFollow(`${url}/`, f, !!opts.allowHttp); }
  catch (e) {
    const code = (e as { code?: string }).code;
    return { ...base, error: code === "not_public" ? "not_public" : code === "timeout" ? "timeout" : code === "too_many_redirects" ? "too_many_redirects" : code === "invalid_url" ? "invalid_url" : "unreachable" };
  }
  const fin = new URL(home.url); const finalUrl = `${fin.protocol}//${fin.host}`;
  const redirected = new URL(url).host.replace(/^www\./, "") !== fin.host.replace(/^www\./, "");
  const r: Detection = { ...base, url, finalUrl, redirected, status: home.status };
  if (home.status >= 500 || home.status === 0) return { ...r, error: "http_error" };
  const cls = classifyHome(home);
  const myshop = /([a-z0-9][a-z0-9-]{0,60}\.myshopify\.com)/i.exec(home.body.slice(0, MAX_BODY))?.[1]?.toLowerCase();
  r.platform = cls.platform;
  if (cls.platform === "shopify" && myshop) r.shopifyDomain = myshop;
  // An address on *.myshopify.com is a Shopify store by definition (also when its storefront is password-protected).
  const inHost = new URL(url).host.toLowerCase();
  if (/^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/.test(inHost)) { r.platform = "shopify"; r.shopifyDomain = inHost; }
  // Even when the home page is unclear (blocked, 403, a JS-only page), a WordPress REST index is a reliable signal.
  if (cls.platform === "wordpress" || cls.platform === "woocommerce" || cls.platform === "unknown") {
    // `_fields=namespaces` keeps the answer tiny (a full REST index of a WooCommerce site is hundreds of KB).
    const withFields = (x: string) => { const u = new URL(x, finalUrl); u.searchParams.set("_fields", "namespaces"); return u.toString(); };
    const candidates = [cls.restHref, `${finalUrl}/wp-json/`, `${finalUrl}/?rest_route=/`].filter((x): x is string => !!x).map(withFields)
      .filter((x) => { try { return new URL(x, finalUrl).host === fin.host; } catch { return false; } });
    let restSeen = false;
    for (const c of candidates.slice(0, 2)) {
      try {
        const p = await getFollow(new URL(c, finalUrl).toString(), f, !!opts.allowHttp);
        let json: unknown = null; try { json = JSON.parse(p.body); } catch { /* not JSON */ }
        const ns = namespacesOf(json);
        if (p.status === 200 && ns.length) {
          restSeen = true;
          r.wooRest = ns.some((n) => n.startsWith("wc/") || n === "wc-store");
          r.linkupPlugin = ns.includes("linkup/v1");
          r.platform = r.wooRest ? "woocommerce" : "wordpress";
          break;
        }
        if (p.status === 401 || p.status === 403) restSeen = false;
      } catch { /* try the next candidate */ }
    }
    if (!restSeen && (r.platform === "wordpress" || r.platform === "woocommerce")) r.restBlocked = true;
  }
  if (r.platform === "unknown" && home.status >= 400) return { ...r, error: "http_error" };
  return { ...r, ok: true };
}

/* ---------- WordPress admin check (used only when the owner says "my store is on WooCommerce" but detection was unsure) ---------- */
/** True only if the address really serves WordPress's login form on the same host (one GET, redirects re-validated).
 *  A site that answers every path with its own page (e.g. a single-page app showing "404") is NOT WordPress. */
export async function probeWpAdmin(site: string, opts: { fetcher?: Fetcher; allowHttp?: boolean } = {}): Promise<boolean> {
  const f = opts.fetcher ?? publicFetch;
  try {
    const base = new URL(site);
    const p = await getFollow(`${base.protocol}//${base.host}/wp-login.php`, f, !!opts.allowHttp);
    const same = new URL(p.url).host.replace(/^www\./, "") === base.host.replace(/^www\./, "");
    return same && p.status === 200 && /id=["']loginform["']/i.test(p.body) && /id=["']user_login["']/i.test(p.body);
  } catch { return false; }
}

export type Eligibility = {
  ok: boolean; url: string; detection: Detection;
  /** How the store was verified: WooCommerce detected, or (owner's choice) a real WordPress admin found at this address. */
  via?: "woocommerce" | "wp_admin";
  reason?: "not_woocommerce" | "no_wp_admin" | "redirected" | DetectError;
};

/** Server-side gate before LINKUP creates a connection key or links to /wp-admin on the store's site. */
export async function connectEligibility(input: string, opts: { fetcher?: Fetcher; allowHttp?: boolean } = {}): Promise<Eligibility> {
  const d = await detectStore(input, opts);
  const url = d.finalUrl || d.url;
  if (!d.ok) return { ok: false, url, detection: d, reason: d.error ?? "unreachable" };
  if (d.redirected) return { ok: false, url, detection: d, reason: "redirected" };
  if (d.platform === "woocommerce") return { ok: true, url, detection: d, via: "woocommerce" };
  if (d.platform === "unknown") {
    return (await probeWpAdmin(url, opts)) ? { ok: true, url, detection: d, via: "wp_admin" } : { ok: false, url, detection: d, reason: "no_wp_admin" };
  }
  return { ok: false, url, detection: d, reason: "not_woocommerce" };
}
