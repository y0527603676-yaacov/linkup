import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module of the Shopify pixel extension
import { createPixel, refFromHref, usable } from "../../../../integrations/shopify-app/extensions/linkup-pixel/src/logic.js";

/** LINKUP's Shopify app pixel logic, with a simulated Web Pixels runtime (analytics events, sandboxed storage). */
function runtime(href: string, settings = { endpoint: "https://fn.test/apps/shopify/ref", shop: "s.myshopify.com" }) {
  const handlers: Record<string, (e: any) => unknown> = {}; const store = new Map<string, string>();
  const api = {
    analytics: { subscribe: (n: string, h: (e: any) => unknown) => { handlers[n] = h; } },
    browser: { localStorage: { getItem: async (k: string) => store.get(k) ?? null, setItem: async (k: string, v: string) => { store.set(k, v); } } },
    settings, init: { context: { document: { location: { href } } } },
  };
  return { api, handlers, store };
}
const NOW = 1_790_000_000; const SIG = "abcdefghijklmnopqrstuv";

describe("Shopify app pixel", () => {
  it("keeps the signed visit from the landing page; last click wins; malformed or future visits ignored", async () => {
    const r = runtime(`https://s.co/?lku=NOA12345&lkt=${NOW - 60}&lks=${SIG}`);
    createPixel(r.api, { now: () => NOW, fetch: async () => ({ ok: true, status: 200 }) });
    await new Promise((x) => setTimeout(x, 0));
    expect(r.store.get("linkup_ref")).toBe(`NOA12345|${NOW - 60}|${SIG}`);
    await r.handlers.page_viewed!({ context: { document: { location: { href: `https://s.co/p?lku=DANA9876&lkt=${NOW - 10}&lks=${SIG}` } } } });
    expect(r.store.get("linkup_ref")).toBe(`DANA9876|${NOW - 10}|${SIG}`);
    await r.handlers.page_viewed!({ context: { document: { location: { href: `https://s.co/?lku=<x>&lkt=1` } } } });
    expect(refFromHref(`https://s.co/?lku=NOA12345&lkt=${NOW + 3600}`, NOW)).toBeNull();
    expect(r.store.get("linkup_ref")).toBe(`DANA9876|${NOW - 10}|${SIG}`);
    expect(usable(`NOA12345|${NOW - 91 * 86400}|${SIG}`, NOW)).toBe(false);   // kept at most 90 days
  });
  it("checkout_completed → one request with shop, order id and the ref only; retries while the order isn't readable", async () => {
    const r = runtime(`https://s.co/?lku=NOA12345&lkt=${NOW - 60}&lks=${SIG}`); const sent: any[] = []; let n = 0;
    createPixel(r.api, { now: () => NOW, sleep: async () => {}, fetch: async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); n++; return { ok: n >= 2, status: n >= 2 ? 200 : 409 }; } });
    await r.handlers.checkout_completed!({ data: { checkout: { order: { id: "gid://shopify/Order/123" } } } });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ shop: "s.myshopify.com", order: "gid://shopify/Order/123", ref: `NOA12345|${NOW - 60}|${SIG}` });
  });
  it("no stored visit (or no order id) → nothing is sent", async () => {
    const r = runtime("https://s.co/"); let calls = 0;
    createPixel(r.api, { now: () => NOW, fetch: async () => { calls++; return { ok: true, status: 200 }; } });
    await r.handlers.checkout_completed!({ data: { checkout: { order: { id: "1" } } } });
    await r.handlers.checkout_completed!({ data: { checkout: { order: null } } });
    expect(calls).toBe(0);
  });
});
