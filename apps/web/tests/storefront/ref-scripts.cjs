// Storefront scripts for personal links, run in a real browser (Chromium + mobile/tablet viewports) against simulated
// Shopify / Wix pages. Run: node tests/storefront/ref-scripts.cjs
const { chromium, devices } = require("playwright");
const fs = require("fs"); const path = require("path");
const ROOT = path.join(__dirname, "../../../../integrations");
const shopJs = fs.readFileSync(path.join(ROOT, "shopify-app/extensions/linkup-ref/assets/linkup-ref.js"), "utf8");
const wixHtml = fs.readFileSync(path.join(ROOT, "wix-app/embedded-script/linkup-ref.html"), "utf8")
  .replace("{{endpoint}}", "https://fn.test/functions/v1/apps/wix/ref").replace("{{instance}}", "1a2b3c4d-1111-4222-8333-944455556666");
let failures = 0;
const T1 = Math.floor(Date.now() / 1000) - 3600, T2 = T1 + 600;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) failures++; };

async function shopify(browser, device, consent) {
  const ctx = await browser.newContext(device ? { ...devices[device] } : {});
  const cart = { attributes: {} }; let updates = 0;
  await ctx.route("https://shop.test/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/cart.js") return route.fulfill({ contentType: "application/json", body: JSON.stringify(cart) });
    if (u.pathname === "/cart/update.js") { updates++; Object.assign(cart.attributes, JSON.parse(route.request().postData()).attributes); return route.fulfill({ contentType: "application/json", body: JSON.stringify(cart) }); }
    if (u.pathname === "/linkup-ref.js") return route.fulfill({ contentType: "text/javascript", body: shopJs });
    const privacy = consent === null ? "" : `<script>window.Shopify={customerPrivacy:{marketingAllowed:function(){return ${consent};}}};</script>`;
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name=viewport content="width=device-width"><body>${privacy}<h1>${u.pathname}</h1><script src="/linkup-ref.js" defer data-root="/"></script></body>` });
  });
  const page = await ctx.newPage(); const label = `[shopify ${device ?? "desktop"} consent=${consent}]`;
  await page.goto(`https://shop.test/?lku=NOA12345&lkt=${T1}`);
  await page.waitForFunction(() => true); await page.waitForTimeout(300);
  ok(cart.attributes.linkup_ref === `NOA12345|${T1}`, `${label} link → cart attribute linkup_ref`);
  await page.goto("https://shop.test/products/mug"); await page.waitForTimeout(300);
  ok(updates === 1, `${label} next page: attribute already on cart, no extra writes`);
  cart.attributes = {};   // e.g. cart expired / new cart later in the session
  await page.goto("https://shop.test/collections/all"); await page.waitForTimeout(300);
  ok(cart.attributes.linkup_ref === `NOA12345|${T1}`, `${label} new cart in the same session → attribute restored`);
  const stored = await page.evaluate(() => localStorage.getItem("linkup_ref"));
  ok(consent === false ? stored === null : stored === `NOA12345|${T1}`, `${label} long-term storage only with consent`);
  await page.goto(`https://shop.test/?lku=DANA9876&lkt=${T2}`); await page.waitForTimeout(300);
  ok(cart.attributes.linkup_ref === `DANA9876|${T2}`, `${label} newer link replaces the older one (last click)`);
  await page.goto("https://shop.test/?lku=<script>&lkt=1"); await page.waitForTimeout(300);
  ok(cart.attributes.linkup_ref === `DANA9876|${T2}`, `${label} malformed link ignored`);
  await ctx.close();
  // A later visit in a new session (same browser storage only when consented).
  return stored;
}

async function wix(browser, device) {
  const ctx = await browser.newContext(device ? { ...devices[device] } : {});
  const beacons = [];
  // First answer 409 (order not readable yet) → the script must retry; then 200.
  await ctx.route("https://fn.test/**", async (route) => { beacons.push(route.request().postData()); return route.fulfill({ status: beacons.length === 1 ? 409 : 200, body: "{}" }); });
  await ctx.route("https://wix-shop.test/**", async (route) => route.fulfill({ contentType: "text/html", body:
    `<!doctype html><meta name=viewport content="width=device-width"><body><h1>wix</h1>
     <script>window.wixDevelopersAnalytics={_h:[],register:function(n,cb){this._h.push(cb);},fire:function(e,d){this._h.forEach(function(h){h(e,d);});}};</script>
     ${wixHtml}</body>` }));
  const page = await ctx.newPage(); const label = `[wix ${device ?? "desktop"}]`;
  await page.goto(`https://wix-shop.test/?lku=NOA12345&lkt=${T1}&lks=abcdefghijklmnopqrstuv`);
  await page.goto("https://wix-shop.test/product-page/mug");
  await page.goto("https://wix-shop.test/thank-you-page/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  await page.evaluate(() => { window.wixDevelopersAnalytics.fire("AddToCart", { id: "p1" }); });
  await page.evaluate(() => { window.wixDevelopersAnalytics.fire("Purchase", { orderId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", revenue: "118" }); });
  await page.evaluate(() => { window.wixDevelopersAnalytics.fire("Purchase", { orderId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", revenue: "118" }); });
  await page.waitForTimeout(4500);
  ok(beacons.length === 2 && beacons[0] === beacons[1], `${label} one purchase → one report, retried once after "order not ready" (other events ignored)`);
  const b = beacons[0] ? JSON.parse(beacons[0]) : {};
  ok(b.ref === `NOA12345|${T1}|abcdefghijklmnopqrstuv` && b.order === "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" && b.instance === "1a2b3c4d-1111-4222-8333-944455556666" && Object.keys(b).length === 3,
     `${label} beacon carries only instance, order id and ref (signed visit; no amounts, no personal data)`);
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  await shopify(browser, null, true);
  await shopify(browser, null, false);
  await shopify(browser, null, null);
  await shopify(browser, "iPhone 13", true);
  await shopify(browser, "iPad Mini", true);
  await wix(browser, null);
  await wix(browser, "Pixel 7");
  await browser.close();
  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
})();
