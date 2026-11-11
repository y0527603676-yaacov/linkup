# LINKUP on Shopify and Wix: status, link attribution, setup

Database: migrations 20261111102000 and 20261111102100 applied to production on 11.11.2026 (approved); nothing
activated — no app credentials, no edge function deployed, no scheduled sync, store-facing buttons off.

Status (11.11.2026): built and tested against simulated Shopify/Wix APIs and a local database. **Not yet tested against a
real Shopify development store or a Wix test site.** Store-facing buttons stay off (`LINKUP_SHOPIFY_APP`,
`LINKUP_WIX_APP`). Nothing below is live in production.

## How a sale is attributed (same engine as WooCommerce)

Order data (amounts, status, cancellations, refunds) always comes from the platform: signed webhooks, or a read from
the platform API with LINKUP's app token. The browser never supplies amounts or status. One attribution per order; a
LINKUP coupon wins over a link; commissions only for paid orders; cancellations and refunds reverse them automatically.
The agreement's attribution window is enforced on the server (`ref_at` vs order date).

The personal link `/r/CODE` adds `lku=CODE&lkt=<visit time>&lks=<signature>` (plus UTM tags). The signature
(HMAC with `LINKUP_REF_SECRET`, same value in the web app and the `apps` function) means a browser cannot invent a creator
code or a visit time: unsigned or forged link data is ignored.

**Default everywhere: a plain personal link with no discount.** A discount is only the store's own choice.

Three separate times (none shortens the others):
- **Attribution window** — per agreement (1–90 days), enforced in the database from the signed visit time. Unchanged.
- **Storage in the visitor's browser** — up to 90 days (the longest window LINKUP allows), only with consent.
- **Claim time** — how long after an order a storefront purchase event may still be linked to it: 72 hours
  (`LINKUP_LINK_CLAIM_HOURS`). It exists only so old orders can't be claimed later; the purchase event normally fires
  seconds after payment.

### Shopify (no discount needed)
| Path | Official mechanism | Owner step | Limits |
|---|---|---|---|
| 1. App pixel (main) | Web Pixels API: the app turns it on itself (`webPixelCreate`); it keeps the signed visit and reports `checkout_completed` (order id). LINKUP reads the order from the Admin API. | None | Loads only with the visitor's analytics+marketing consent and not after a data-sale opt-out (`customer_privacy`). Ad blockers / closed thank-you page can stop it (retried 4 times while the page is open). With post-purchase upsells it fires on the upsell page. |
| 2. Landing page | Order webhook `landing_site` (signed link parameters) | None | Only the landing page of the converting session. |
| 3. Customer journey | `Order.customerJourneySummary` (last/first visit landing page) | None | Asked only for orders without coupon or link data; retried on the next order event while not `ready`; sometimes empty per community reports. |
| 4. Theme app embed (optional, not offered in UI) | Cart attribute `linkup_ref` → order `note_attributes` | One click in the theme editor | Kept as an extra; not needed for the flow. |
| Store's choice only | Shareable discount link `/discount/CODE?redirect=…` | `set_link_options` (off by default; no UI yet) | Gives the coupon discount; platform switch `shopify_discount_link`. |

Reliability: high when the visitor accepted cookies — an independent, verified path (pixel) plus Shopify's own order
data (landing page / journey). Visitors who decline marketing cookies, or block scripts, are credited only through the
order's own data (landing page of the same session, or Shopify's journey) — not guaranteed. The coupon remains optional.

### Wix
| Path | Official mechanism | Limits |
|---|---|---|
| 1. Personal link | Embedded script (consent category ADVERTISING) keeps the signed visit; on Wix's standard **Purchase** event (thank-you page, `orderId`) it sends it; LINKUP reads the order from the eCommerce Orders API. Retries when the order isn't readable yet (409). | Wix orders carry no landing page/UTM, so there is no server-side fallback: no consent or a blocked script → no link credit. |
| 2. Coupon (optional) | Partner coupon created in the store | Wix has no documented link that applies a coupon. |

The earlier "2 hours" was a limit of my implementation (not Wix): it was the claim time, and is now 72 hours and
separate from the attribution window — a purchase 25 days after the click (window 30) is credited.

Not verified yet on real platforms: pixel runtime details (sandboxed `browser.localStorage`, that the stored visit is
readable on the thank-you page, `checkout.order.id` format), `landing_site`/journey contents, the theme embed, the Wix
Purchase-event payload and listener (`wixDevelopersAnalytics`; a `@wix/site` variant is included), the Wix coupon PATCH
body, Wix embedded-script plan/domain requirements.

## What's in the code
- `supabase/functions/apps/` — edge function `apps`: install callbacks, webhooks (incl. Shopify privacy webhooks),
  `wix/ref` beacon, `cron/sync` (health check by a real API call, coupons, products; failures recorded for admin).
  Retries with back-off on 429/5xx. Shopify returns 500 on temporary DB errors so Shopify re-sends.
- `integrations/shopify-app/` — `shopify.app.toml` template, app pixel `linkup-pixel` (main), optional theme app embed
  `linkup-ref`. Pixel dependency: `npm i @shopify/web-pixels-extension@latest` inside the extension (Shopify CLI).
- `integrations/wix-app/embedded-script/` — self-managed embedded script (`{{endpoint}}`, `{{instance}}` parameters)
  and a Wix CLI variant.
- `apps/web/src/lib/partner-link.ts` + `/r/[code]` — where a personal link sends the visitor.
- Migrations (applied 11.11.2026): `20261111102000_app_connections.sql`, `20261111102100_link_attribution.sql`;
  rollbacks in `supabase/rollback/20261111102000.down.sql`, `20261111102100.down.sql`.
- Tests: `tests/db/apps-flow.test.ts`, `tests/db/link-attribution.test.ts`, `tests/storefront/ref-scripts.cjs`
  (real Chromium, desktop/iPhone/iPad/Pixel).

## Owner's steps (in this order)
1. Shopify Partner account (free): https://www.shopify.com/partners → create a **development store** for testing.
2. In the Partner dashboard → Apps → Create app (manually). Copy *Client ID* and *Client secret*.
   App URL: `https://linkup-tawny.vercel.app/app/connect`. Allowed redirect URL:
   `https://ycuvcpslvkgndytubycn.supabase.co/functions/v1/apps/shopify/callback`.
   Scopes: `read_orders, read_products, write_discounts, write_pixels, read_customer_events`. Request access to **protected customer data** (orders include
   the buyer's e-mail; LINKUP stores only a hash) — level 1.
3. Approve migrations 2000 and 2100 (applied by me after approval), then I set the function secrets
   (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `LINKUP_CRON_SECRET`, `LINKUP_REF_SECRET` — also in Vercel) and deploy the `apps` function (verify_jwt off).
4. Deploy the app extensions (pixel; optional theme embed): requires the Shopify CLI on a computer (`npm i -g @shopify/cli`, then in
   `integrations/shopify-app`: `shopify app deploy`). I can guide this step by step.
5. Install on the development store from LINKUP (local flag on for your test store only) → place test orders: with the
   coupon, through the personal link, cancel, refund. Only after this passes may Shopify be offered to stores.
6. Wix: developer account https://dev.wix.com → create app → OAuth (Client ID/secret), Webhooks (eCommerce order
   events, App Removed) and public key, Embedded Script extension (type ADVERTISING, placement BODY_END, parameters
   `endpoint`, `instance`, paste `linkup-ref.html`), permissions: Read Orders, Manage Coupons, Read Products,
   Manage Embedded Scripts. Test on a Wix test site with a Business plan (needed to accept payments).
7. Scheduled sync: a Supabase cron calling `POST …/functions/v1/apps/cron/sync` with header `X-LinkUp-Cron` every
   6 hours (I prepare the SQL after approval).
8. Public App Store listing (Shopify review / Wix review) — later, only after the pilot works.
