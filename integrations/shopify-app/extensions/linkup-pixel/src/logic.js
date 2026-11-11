// Pure logic of the LINKUP pixel (shared by index.js and the tests).
// Keeps the signed personal-link visit "CODE|time|sig" (up to 90 days — LINKUP's longest attribution window; each
// agreement's own window is enforced on the server) and reports Shopify's checkout_completed with the order id.
export const KEY = "linkup_ref";
export const MAX_AGE = 90 * 86400;
const RAW = /^[A-Za-z0-9]{4,16}\|\d{9,11}(\|[A-Za-z0-9_-]{22})?$/;

export function refFromHref(href, nowSec) {
  let u; try { u = new URL(href); } catch { return null; }
  const code = u.searchParams.get("lku") || "", t = u.searchParams.get("lkt") || "", sig = u.searchParams.get("lks") || "";
  if (!/^[A-Za-z0-9]{4,16}$/.test(code) || !/^\d{9,11}$/.test(t)) return null;
  if (Number(t) > nowSec + 300) return null;
  return `${code}|${t}${/^[A-Za-z0-9_-]{22}$/.test(sig) ? `|${sig}` : ""}`;
}
export function usable(v, nowSec) { return typeof v === "string" && RAW.test(v) && nowSec - Number(v.split("|")[1]) <= MAX_AGE; }

export function createPixel({ analytics, browser, settings, init }, deps = {}) {
  const now = deps.now || (() => Math.floor(Date.now() / 1000));
  const fetchFn = deps.fetch || fetch;
  const wait = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const capture = async (href) => { const r = refFromHref(href, now()); if (r) { try { await browser.localStorage.setItem(KEY, r); } catch {} } };
  const ready = capture(init?.context?.document?.location?.href || "");
  analytics.subscribe("page_viewed", (e) => capture(e?.context?.document?.location?.href || ""));
  analytics.subscribe("checkout_completed", async (e) => {
    await ready;
    const id = e?.data?.checkout?.order?.id;
    let ref = null; try { ref = await browser.localStorage.getItem(KEY); } catch {}
    if (!id || !usable(ref, now()) || !settings?.endpoint || !settings?.shop) return;
    const body = JSON.stringify({ shop: settings.shop, order: String(id), ref });
    for (const delay of [0, 3000, 10000, 30000]) {
      if (delay) await wait(delay);
      try {
        const r = await fetchFn(settings.endpoint, { method: "POST", body, headers: { "Content-Type": "text/plain" }, keepalive: true });
        if (r.ok || (r.status !== 409 && r.status < 500)) return;   // done, or a final answer
      } catch {}
    }
  });
}
