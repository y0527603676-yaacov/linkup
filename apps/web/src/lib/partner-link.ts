/** Where a creator's personal link (/r/CODE) sends the visitor.
 *  - Always: the store address with lku=CODE (creator) and lkt=<visit time>, plus standard UTM tags.
 *    WooCommerce: the LINKUP plugin keeps a first-party cookie for the agreement's attribution window.
 *    Shopify: the order's landing page / Shopify's customer journey carries lku+lkt; the LINKUP theme app embed (when
 *    enabled) also stores it as a cart attribute. Wix: LINKUP's embedded script keeps it until Wix's Purchase event.
 *  - Shopify app + creator coupon with a customer discount confirmed in the shop: Shopify's official shareable discount
 *    link (/discount/CODE?redirect=…). Shopify applies the code automatically and keeps it in the cart/browser, so the
 *    order arrives with the code — the most reliable path, no typing. */
export type ResolvedLink = { code: string; url: string | null; platform?: string | null; discount_link?: boolean };

export function partnerDestination(r: ResolvedLink, nowSec = Math.floor(Date.now() / 1000)): URL | null {
  if (!r?.url || !/^[A-Za-z0-9]{4,16}$/.test(r.code)) return null;
  let site: URL; try { site = new URL(r.url); } catch { return null; }
  if (site.protocol !== "https:" && site.protocol !== "http:") return null;
  const landing = new URL(site.toString());
  landing.searchParams.set("lku", r.code);
  landing.searchParams.set("lkt", String(nowSec));
  landing.searchParams.set("utm_source", "linkup");
  landing.searchParams.set("utm_medium", "partner");
  landing.searchParams.set("utm_campaign", r.code);
  if (r.platform === "shopify" && r.discount_link) {
    const path = `${landing.pathname}${landing.search}`;
    const d = new URL(`/discount/${encodeURIComponent(r.code)}`, site.origin);
    d.searchParams.set("redirect", path);
    return d;
  }
  return landing;
}
