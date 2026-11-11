import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectEligibility, probeWpAdmin, type Fetcher } from "../../src/lib/store-detect";

/**
 * Regression for the clearwise.me report: a non-WooCommerce site (a single-page app that answers EVERY path with
 * 200 and its own "404" screen), the owner picks "my store is on WooCommerce", opens the manual step and asks for a key.
 * LINKUP must not claim it found WooCommerce, must not create a key and must not link to /wp-admin on that site.
 */
const spa = '<!doctype html><html><head><title>Clearwise</title><script type="module" src="/assets/index-abc.js"></script></head><body><div id="root"></div></body></html>';
const wpLogin = '<html><body class="login"><form name="loginform" id="loginform" action="https://shop-test.com/wp-login.php" method="post"><input type="text" name="log" id="user_login"></form></body></html>';
const page = (status: number, body: string, headers: Record<string, string> = {}) => ({ status, body, headers, url: "" });

/** Every path answers 200 with the same app shell (how clearwise.me behaves). */
const spaSite: Fetcher = async (url) => ({ ...page(200, spa, { "content-type": "text/html" }), url });
/** A WooCommerce store whose home page and REST are hidden behind a security plugin, but WordPress login is real. */
const hiddenWoo: Fetcher = async (url) => {
  const u = new URL(url);
  if (u.pathname === "/wp-login.php") return { ...page(200, wpLogin), url };
  if (u.pathname.startsWith("/wp-json") || u.searchParams.has("rest_route")) return { ...page(403, "forbidden"), url };
  return { ...page(200, "<html><body>Welcome</body></html>"), url };
};
/** Login path that bounces to another host (must not count as this site's admin). */
const foreignLogin: Fetcher = async (url) => {
  const u = new URL(url);
  if (u.host === "shop-test.com" && u.pathname === "/wp-login.php") return { ...page(302, "", { location: "https://login.other-test.com/wp-login.php" }), url };
  if (u.host === "login.other-test.com") return { ...page(200, wpLogin), url };
  return { ...page(200, "<html><body>Welcome</body></html>"), url };
};
const wooSite: Fetcher = async (url) => {
  const u = new URL(url);
  if (u.pathname.startsWith("/wp-json") || u.searchParams.has("rest_route")) return { ...page(200, JSON.stringify({ namespaces: ["wp/v2", "wc/v3", "wc/store/v1"] })), url };
  return { ...page(200, '<html><head><link rel="https://api.w.org/" href="https://shop-test.com/wp-json/"></head><body class="woocommerce"></body></html>'), url };
};
const shopify: Fetcher = async (url) => ({ ...page(200, '<script src="https://cdn.shopify.com/s/x.js"></script>', { "x-shopid": "1" }), url });

describe("connection gate (server side, before a key or any /wp-admin link)", () => {
  it("clearwise-like site: not WordPress, even though /wp-login.php answers 200", async () => {
    expect(await probeWpAdmin("https://clearwise-test.com", { fetcher: spaSite })).toBe(false);
    const el = await connectEligibility("clearwise-test.com", { fetcher: spaSite });
    expect(el).toMatchObject({ ok: false, reason: "no_wp_admin" });
    expect(el.detection.platform).toBe("unknown");
  });
  it("owner's choice is accepted only when a real WordPress login exists at the same address", async () => {
    expect(await connectEligibility("shop-test.com", { fetcher: hiddenWoo })).toMatchObject({ ok: true, via: "wp_admin", url: "https://shop-test.com" });
    expect(await probeWpAdmin("https://shop-test.com", { fetcher: foreignLogin })).toBe(false);
    expect(await connectEligibility("shop-test.com", { fetcher: foreignLogin })).toMatchObject({ ok: false, reason: "no_wp_admin" });
  });
  it("detected WooCommerce passes; other platforms and bad addresses never do", async () => {
    expect(await connectEligibility("shop-test.com", { fetcher: wooSite })).toMatchObject({ ok: true, via: "woocommerce" });
    expect(await connectEligibility("shop-test.com", { fetcher: shopify })).toMatchObject({ ok: false, reason: "not_woocommerce" });
    expect(await connectEligibility("not a url")).toMatchObject({ ok: false, reason: "invalid_url" });
    expect(await connectEligibility("https://127.0.0.1")).toMatchObject({ ok: false, reason: "invalid_url" });
  });
});

describe("no detection result can come from the address bar", () => {
  const src = readFileSync(join(__dirname, "../../src/app/app/connect/page.tsx"), "utf8");
  const actions = readFileSync(join(__dirname, "../../src/app/app/actions.ts"), "utf8");
  it("the connect page runs detection itself and ignores old result parameters (p, de, rd, pl, rb, m)", () => {
    expect(src).toMatch(/await detectStore\(checkSite/);
    expect(src).not.toMatch(/sp\.(p|de|rd|pl|rb|m)\b/);
  });
  it("creating a key is gated on the server", () => {
    const body = actions.slice(actions.indexOf("export async function connectStore"), actions.indexOf("/* ---------- Store connection without a plugin"));
    expect(body.indexOf("connectEligibility")).toBeGreaterThan(0);
    expect(body.indexOf("connectEligibility")).toBeLessThan(body.indexOf("create_store_connection"));
  });
});
