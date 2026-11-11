import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectStore, localTestFetch } from "../../src/lib/store-detect";

/** Platform detection against real local sites (isolated): real WordPress + real WooCommerce, real WordPress without
 *  WooCommerce REST, a non-WordPress site (the LINKUP app itself), a 404 site, a redirecting site and a dead port. */
const opts = { fetcher: localTestFetch, allowHttp: true };
let helper: Server;
beforeAll(() => {
  helper = createServer((req, res) => {
    if (req.url === "/" && req.headers.host?.startsWith("127.0.0.1:8099")) { res.writeHead(301, { location: "http://localhost:8099/moved" }); return res.end(); }
    if (req.url === "/moved") { res.writeHead(200, { "content-type": "text/html" }); return res.end('<div class="woocommerce"><script src="/wp-includes/x.js"></script>'); }
    res.writeHead(404); res.end("not found");
  }).listen(8099, "127.0.0.1");
});
afterAll(() => helper?.close());

describe("real local sites", () => {
  it("real WooCommerce 9.4.2 store", async () => {
    const d = await detectStore("http://127.0.0.1:8096", opts);
    expect(d).toMatchObject({ ok: true, platform: "woocommerce", wooRest: true, restBlocked: false });
  });
  it("real WordPress without WooCommerce REST", async () => {
    const d = await detectStore("http://127.0.0.1:8090", opts);
    expect(d).toMatchObject({ ok: true, platform: "wordpress", wooRest: false });
  });
  it("a non-WordPress site (Next.js app)", async () => {
    const d = await detectStore("http://localhost:3200", opts);
    expect(d).toMatchObject({ ok: true, platform: "unknown" });
  });
  it("a site that answers 404", async () => {
    const d = await detectStore("http://localhost:8099", opts);
    expect(d).toMatchObject({ ok: false, error: "http_error" });
  });
  it("a site that redirects to another host", async () => {
    const d = await detectStore("http://127.0.0.1:8099", opts);
    expect(d).toMatchObject({ redirected: true, finalUrl: "http://localhost:8099" });
  });
  it("a site that is down", async () => {
    const d = await detectStore("http://127.0.0.1:1", opts);
    expect(d).toMatchObject({ ok: false, error: "unreachable" });
  });
});
