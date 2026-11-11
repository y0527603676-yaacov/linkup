/* LINKUP personal links for Shopify (theme app embed).
 * 1. A visitor arrives through a creator's personal link: ?lku=CODE&lkt=<visit time>.
 * 2. The ref "CODE|time" is written to the cart attribute "linkup_ref" (Shopify's Ajax Cart API). Shopify copies cart
 *    attributes to the order, so it reaches LINKUP in the order webhook — the order data itself always comes from Shopify.
 * 3. With marketing consent (Shopify Customer Privacy API), the ref is also kept in this browser for up to 90 days so a
 *    later visit / new cart is still credited; the agreement's own attribution window is enforced by LINKUP's server.
 *    Without consent it is kept for this browsing session only.
 * Last click wins (a newer personal link replaces the older one). No personal data is read or sent. */
(function () {
  "use strict";
  var KEY = "linkup_ref", MAX_AGE = 90 * 86400, RE = /^[A-Za-z0-9]{4,16}\|\d{9,11}$/;
  var script = document.currentScript;
  var root = (script && script.getAttribute("data-root")) || (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
  if (root.slice(-1) !== "/") root += "/";
  function now() { return Math.floor(Date.now() / 1000); }
  function consentOk() {
    try {
      var cp = window.Shopify && window.Shopify.customerPrivacy;
      if (cp && typeof cp.marketingAllowed === "function") return !!cp.marketingAllowed();
    } catch (e) {}
    return true; // no consent API on this store (no banner required) — same rule as LINKUP's WooCommerce plugin
  }
  function read() {
    var v = null;
    try { v = sessionStorage.getItem(KEY); } catch (e) {}
    if (!v) { try { v = localStorage.getItem(KEY); } catch (e) {} }
    if (!v || !RE.test(v)) return null;
    if (now() - Number(v.split("|")[1]) > MAX_AGE) { try { localStorage.removeItem(KEY); } catch (e) {} return null; }
    return v;
  }
  function save(v) {
    try { sessionStorage.setItem(KEY, v); } catch (e) {}
    if (consentOk()) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  }
  function fromUrl() {
    var p = new URLSearchParams(location.search), code = p.get("lku") || "", t = p.get("lkt") || "";
    if (!/^[A-Za-z0-9]{4,16}$/.test(code)) return null;
    var ts = /^\d{9,11}$/.test(t) ? Number(t) : now();
    if (ts > now() + 300) ts = now();
    return code + "|" + ts;
  }
  var ref = fromUrl();
  if (ref) save(ref); else ref = read();
  if (!ref) return;
  function attach() {
    fetch(root + "cart.js", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cart) {
        if (cart && cart.attributes && cart.attributes[KEY] === ref) return;
        return fetch(root + "cart/update.js", { method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ attributes: { linkup_ref: ref } }) });
      })
      .catch(function () {});
  }
  attach();
  // When consent is given later on this page, keep it for later visits too.
  document.addEventListener("visitorConsentCollected", function () { save(ref); });
})();
