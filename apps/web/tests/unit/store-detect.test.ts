import { describe, expect, it } from "vitest";
import { classifyHome, detectStore, isPublicAddress, normalizeSite, publicFetch, type Fetcher } from "../../src/lib/store-detect";

const html = (body: string, headers: Record<string, string> = {}) => ({ headers, body: `<html><head></head><body>${body}</body></html>` });

describe("address safety", () => {
  it("refuses private, loopback, link-local, CGNAT, metadata and IPv6 local ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ["8.8.8.8", "104.21.3.4", "2606:4700::6810:1"]) expect(isPublicAddress(ip), ip).toBe(true);
  });
  it("normalizes what owners type and rejects unsafe input", () => {
    expect(normalizeSite("myshop.co.il")).toBe("https://myshop.co.il");
    expect(normalizeSite("  https://www.MyShop.co.il/shop?x=1 ")).toBe("https://www.myshop.co.il");
    expect(normalizeSite("http://myshop.com")).toBe("https://myshop.com");
    for (const bad of ["", "not a url", "ftp://x.com", "https://127.0.0.1", "https://[::1]", "https://localhost", "https://shop.local", "https://x.com:8443", "https://user:pw@x.com", "javascript:alert(1)"])
      expect(normalizeSite(bad), bad).toBeNull();
  });
});

describe("classification of the home page", () => {
  it("WooCommerce", () => {
    expect(classifyHome(html('<link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/css/x.css"><div class="woocommerce">')).platform).toBe("woocommerce");
    expect(classifyHome(html('<meta name="generator" content="WooCommerce 9.4.2"><script src="/wp-includes/js/x.js">')).platform).toBe("woocommerce");
  });
  it("WordPress without WooCommerce, with the REST link", () => {
    const r = classifyHome({ headers: { link: '<https://blog.example.org/wp-json/>; rel="https://api.w.org/"' }, body: '<meta name="generator" content="WordPress 6.5.5">' });
    expect(r).toEqual({ platform: "wordpress", restHref: "https://blog.example.org/wp-json/" });
  });
  it("Shopify, Wix, Magento, unknown", () => {
    expect(classifyHome(html('<script src="https://cdn.shopify.com/s/files/x.js">')).platform).toBe("shopify");
    expect(classifyHome({ headers: { "x-shopify-stage": "production" }, body: "" }).platform).toBe("shopify");
    expect(classifyHome(html('<img src="https://static.wixstatic.com/media/x.png">')).platform).toBe("wix");
    expect(classifyHome(html('<script type="text/x-magento-init">{}</script>')).platform).toBe("magento");
    expect(classifyHome(html('<div id="__next">Clear thinking tools</div>')).platform).toBe("unknown");
  });
});

/** A tiny in-memory "internet" for the flow tests. */
function web(routes: Record<string, { status?: number; headers?: Record<string, string>; body?: string } | Error>): Fetcher {
  return async (url) => {
    const r = routes[url];
    if (!r) return { status: 404, headers: {}, body: "Not found", url };
    if (r instanceof Error) throw r;
    return { status: r.status ?? 200, headers: r.headers ?? {}, body: r.body ?? "", url };
  };
}
const wpJson = (ns: string[]) => JSON.stringify({ name: "Shop", namespaces: ns });

describe("detectStore", () => {
  it("WooCommerce store with the LINKUP plugin already active", async () => {
    const d = await detectStore("myshop.co.il", { fetcher: web({
      "https://myshop.co.il/": { body: '<link rel="https://api.w.org/" href="https://myshop.co.il/wp-json/"><div class="woocommerce">' },
      "https://myshop.co.il/wp-json/?_fields=namespaces": { body: wpJson(["wp/v2", "wc/v3", "wc/store/v1", "linkup/v1"]) },
    }) });
    expect(d).toMatchObject({ ok: true, platform: "woocommerce", wooRest: true, linkupPlugin: true, restBlocked: false, redirected: false });
  });
  it("WordPress without WooCommerce (REST index has no wc namespaces)", async () => {
    const d = await detectStore("blog.example.org", { fetcher: web({
      "https://blog.example.org/": { body: '<meta name="generator" content="WordPress 6.5">' },
      "https://blog.example.org/wp-json/?_fields=namespaces": { body: wpJson(["wp/v2", "oembed/1.0"]) },
    }) });
    expect(d).toMatchObject({ ok: true, platform: "wordpress", wooRest: false });
  });
  it("WooCommerce detected on the page but REST blocked → restBlocked", async () => {
    const d = await detectStore("shop.example.org", { fetcher: web({
      "https://shop.example.org/": { body: '<div class="woocommerce"><script src="/wp-includes/x.js">' },
      "https://shop.example.org/wp-json/?_fields=namespaces": { status: 403, body: "{}" },
      "https://shop.example.org/?rest_route=%2F&_fields=namespaces": { status: 403, body: "{}" },
    }) });
    expect(d).toMatchObject({ ok: true, platform: "woocommerce", restBlocked: true });
  });
  it("a non-WordPress site (like clearwise.me) is 'unknown' – nobody is sent to a 404", async () => {
    const d = await detectStore("clearwise.me", { fetcher: web({ "https://clearwise.me/": { body: '<div id="__next">Clearwise</div>' } }) });
    expect(d).toMatchObject({ ok: true, platform: "unknown", wooRest: false });
  });
  it("Shopify is recognized and reported as not supported yet (platform only)", async () => {
    const d = await detectStore("mystore.com", { fetcher: web({ "https://mystore.com/": { headers: { "x-shopify-stage": "production" }, body: "" } }) });
    expect(d.platform).toBe("shopify");
  });
  it("a site that returns 404 on its home page", async () => {
    const d = await detectStore("gone.example.org", { fetcher: web({ "https://gone.example.org/": { status: 404, body: "nope" } }) });
    expect(d).toMatchObject({ ok: false, error: "http_error" });
  });
  it("redirect to another host is reported (and followed, http upgraded to https)", async () => {
    const d = await detectStore("old-shop.com", { fetcher: web({
      "https://old-shop.com/": { status: 301, headers: { location: "http://new-shop.com/" } },
      "https://new-shop.com/": { body: '<div class="woocommerce"><link rel="https://api.w.org/" href="https://new-shop.com/wp-json/">' },
      "https://new-shop.com/wp-json/?_fields=namespaces": { body: wpJson(["wc/v3"]) },
    }) });
    expect(d).toMatchObject({ ok: true, platform: "woocommerce", redirected: true, url: "https://old-shop.com", finalUrl: "https://new-shop.com" });
  });
  it("www redirect is not treated as another site", async () => {
    const d = await detectStore("shop.co.il", { fetcher: web({
      "https://shop.co.il/": { status: 301, headers: { location: "https://www.shop.co.il/" } },
      "https://www.shop.co.il/": { body: '<div class="woocommerce"><script src="/wp-includes/x.js">' },
      "https://www.shop.co.il/wp-json/?_fields=namespaces": { body: wpJson(["wc/v3"]) },
    }) });
    expect(d).toMatchObject({ ok: true, redirected: false, finalUrl: "https://www.shop.co.il" });
  });
  it("redirect loops, unreachable sites, timeouts, private addresses and bad input", async () => {
    const loop = web({ "https://a.com/": { status: 302, headers: { location: "https://a.com/x" } }, "https://a.com/x": { status: 302, headers: { location: "https://a.com/" } } });
    expect((await detectStore("a.com", { fetcher: loop })).error).toBe("too_many_redirects");
    expect((await detectStore("down.com", { fetcher: web({ "https://down.com/": Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }) }) })).error).toBe("unreachable");
    expect((await detectStore("slow.com", { fetcher: web({ "https://slow.com/": Object.assign(new Error("timeout"), { code: "timeout" }) }) })).error).toBe("timeout");
    expect((await detectStore("inside.com", { fetcher: web({ "https://inside.com/": Object.assign(new Error("not_public"), { code: "not_public" }) }) })).error).toBe("not_public");
    expect((await detectStore("not a url")).error).toBe("invalid_url");
  });
  it("the real fetcher refuses a name that resolves to a private address (no request is made)", async () => {
    await expect(publicFetch("https://localhost/")).rejects.toMatchObject({ code: "not_public" });
    await expect(publicFetch("http://example.com/")).rejects.toMatchObject({ code: "invalid_url" });
  });
});
